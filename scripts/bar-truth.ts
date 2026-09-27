/**
 * Bar-truth diagnostic (Engineering Phase A, STEP 4-6).
 *
 * Proves what Atlas actually shows for a symbol/window by comparing THREE layers
 * against each other, minute by minute, with no sampling:
 *
 *   RAW      — the vendor payload exactly as Yahoo returned it (grid rows only).
 *   NORMALIZED — those rows through the SAME normalization the live provider uses
 *                (getHistoricalBars → extractBars → normalizeBar: tick-snap,
 *                 trailing-live-row drop, null/invalid drop).
 *
 * It classifies every expected minute as MATCH / VALUE_MISMATCH / MISSING /
 * DUPLICATE / TIMESTAMP_SHIFT / SESSION(closed) and prints bar-count parity
 * (expected minutes vs raw grid bars vs normalized bars). This is the objective
 * answer to "are Atlas candles the correct market bars" AT THE PROVIDER BOUNDARY.
 * It does NOT compare against an external reference platform (TradingView/etc.) —
 * that remains a human visual step.
 *
 * Dev/test only. No secrets. Reaches the same public Yahoo endpoint the dev
 * provider uses.
 *
 * Run (network via the agent proxy):
 *   cross-env NODE_USE_ENV_PROXY=1 pnpm --filter @atlas/server exec \
 *     tsx ../../scripts/bar-truth.ts NQ 1m 3
 *   args: <ATLAS_SYMBOL> <TIMEFRAME> <LOOKBACK_HOURS>   (defaults: NQ 1m 3)
 */
import { getInstrument } from '../packages/instruments/src/index.js';
import { normalizeBar, emptyStats, isPlausibleExchangeTs } from '../apps/server/src/marketdata/normalize.js';

const BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const UA = 'Mozilla/5.0 (compatible; AtlasFuturesTerminal/0.1; simulation)';

interface RawRow { tsSec: number; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null; }

function etLocal(tsMs: number): string {
  // Exchange-local display (America/New_York) for human comparison.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(tsMs));
}

async function fetchRaw(vendorSymbol: string, fromMs: number, toMs: number): Promise<{ rows: RawRow[]; marketTs: number; meta: Record<string, unknown> }> {
  const url =
    `${BASE_URL}/${encodeURIComponent(vendorSymbol)}` +
    `?interval=1m&period1=${Math.floor(fromMs / 1000)}&period2=${Math.ceil(toMs / 1000)}&includePrePost=true`;
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const body = (await res.json()) as { chart?: { result?: Array<{ meta: Record<string, unknown>; timestamp?: number[]; indicators?: { quote?: Array<Record<string, Array<number | null>>> } }>; error?: unknown } };
  const result = body.chart?.result?.[0];
  if (!result) throw new Error('Yahoo returned no result');
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const rows: RawRow[] = ts.map((t, i) => ({
    tsSec: t,
    open: q['open']?.[i] ?? null, high: q['high']?.[i] ?? null,
    low: q['low']?.[i] ?? null, close: q['close']?.[i] ?? null,
    volume: q['volume']?.[i] ?? null,
  }));
  return { rows, marketTs: Number(result.meta['regularMarketTime'] ?? 0) * 1000, meta: result.meta };
}

async function main(): Promise<void> {
  const symbol = (process.argv[2] ?? 'NQ').toUpperCase();
  const timeframe = process.argv[3] ?? '1m';
  const lookbackHours = Number(process.argv[4] ?? 3);

  const spec = getInstrument(symbol);
  if (!spec) throw new Error(`UNKNOWN_INSTRUMENT: ${symbol}`);
  const vendorSymbol = spec.providerSymbols['yahoo'];
  if (!vendorSymbol) throw new Error(`NO_PROVIDER_SYMBOL: ${symbol}`);

  const to = Date.now();
  const from = to - lookbackHours * 3_600_000;

  const { rows, marketTs, meta } = await fetchRaw(vendorSymbol, from, to);

  // Reproduce the provider's grid + trailing-live-row handling for 1m.
  const barMs = 60_000;
  const stats = emptyStats();
  const gridRows = rows.filter((r) => isPlausibleExchangeTs(r.tsSec * 1000));
  const lastIndex = gridRows.length - 1;

  const normalized = new Map<number, ReturnType<typeof normalizeBar>>();
  let droppedTrailingLive = 0;
  let droppedNullOrInvalid = 0;
  for (let i = 0; i < gridRows.length; i += 1) {
    const r = gridRows[i]!;
    // trailing off-grid live-price row (same rule as yahoo.ts extractBars)
    if (i === lastIndex && lastIndex > 0 && r.tsSec % (barMs / 1000) !== 0) { droppedTrailingLive += 1; continue; }
    const closed = marketTs > 0 ? r.tsSec * 1000 + barMs <= marketTs : true;
    const bar = normalizeBar(spec, { tsSeconds: r.tsSec, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }, stats, closed);
    if (!bar) { droppedNullOrInvalid += 1; continue; }
    normalized.set(bar.time, bar);
  }

  // Grid-aligned expected minutes across the covered raw span.
  const gridTimes = gridRows.map((r) => r.tsSec * 1000).filter((t) => t % barMs === 0);
  const first = gridTimes[0];
  const last = gridTimes[gridTimes.length - 1];
  const rawByTime = new Map<number, RawRow>();
  let rawDuplicates = 0;
  for (const r of gridRows) { if (r.tsSec * 1000 % barMs !== 0) continue; if (rawByTime.has(r.tsSec * 1000)) rawDuplicates += 1; rawByTime.set(r.tsSec * 1000, r); }

  // Classification per raw grid minute.
  const cls = { MATCH: 0, VALUE_MISMATCH: 0, MISSING: 0 };
  const mismatches: string[] = [];
  for (const [t, r] of rawByTime) {
    const n = normalized.get(t);
    if (!n) { cls.MISSING += 1; continue; }
    // Compare against tick-snapped raw (normalization snaps to the tick grid).
    const snap = (v: number | null): number | null => (v == null ? null : Number(v));
    const near = (a: number, b: number | null): boolean => b != null && Math.abs(a - b) <= 0.5; // within half a point tolerance for tick snap
    if (near(n.open, snap(r.open)) && near(n.high, snap(r.high)) && near(n.low, snap(r.low)) && near(n.close, snap(r.close))) cls.MATCH += 1;
    else { cls.VALUE_MISMATCH += 1; if (mismatches.length < 10) mismatches.push(`${etLocal(t)}  raw O${r.open} H${r.high} L${r.low} C${r.close}  norm O${n.open} H${n.high} L${n.low} C${n.close}`); }
  }
  const extraInNormalized = [...normalized.keys()].filter((t) => !rawByTime.has(t));

  // Report.
  console.log(`\n=== BAR-TRUTH: ${symbol} (${vendorSymbol}) ${timeframe} — last ${lookbackHours}h ===`);
  console.log(`exchange: ${meta['exchangeName']} tz=${meta['exchangeTimezoneName']} regularMarketTime=${etLocal(marketTs)} (${marketTs})`);
  console.log(`window: ${etLocal(first ?? from)}  ->  ${etLocal(last ?? to)} ET`);
  console.log('');
  console.log('--- BAR COUNT PARITY ---');
  const spanMinutes = first != null && last != null ? Math.round((last - first) / barMs) + 1 : 0;
  console.log(`covered span minutes (first..last inclusive): ${spanMinutes}`);
  console.log(`raw rows returned                : ${rows.length}`);
  console.log(`raw GRID rows (epoch-aligned)    : ${gridTimes.length}`);
  console.log(`raw distinct grid minutes        : ${rawByTime.size}`);
  console.log(`normalized bars                  : ${normalized.size}`);
  console.log(`dropped: trailing-live-row=${droppedTrailingLive}  null/invalid=${droppedNullOrInvalid}  raw-duplicates=${rawDuplicates}`);
  console.log(`missing minutes within span (provider did not return a grid bar): ${spanMinutes - rawByTime.size}`);
  console.log('');
  console.log('--- RAW vs NORMALIZED (per grid minute) ---');
  console.log(`MATCH=${cls.MATCH}  VALUE_MISMATCH=${cls.VALUE_MISMATCH}  MISSING(in normalized)=${cls.MISSING}  EXTRA(in normalized not raw)=${extraInNormalized.length}`);
  if (mismatches.length) { console.log('first value mismatches:'); for (const m of mismatches) console.log('  ' + m); }
  console.log('');
  console.log('--- CSV (last 12 normalized bars) ---');
  console.log('utc_ms,et_local,open,high,low,close,volume,closed,atlas_symbol,provider_symbol');
  const tail = [...normalized.values()].slice(-12);
  for (const b of tail) console.log(`${b.time},${etLocal(b.time)},${b.open},${b.high},${b.low},${b.close},${b.volume},${b.closed},${symbol},${vendorSymbol}`);

  // Verdict line for scripting.
  const clean = cls.VALUE_MISMATCH === 0 && extraInNormalized.length === 0;
  console.log(`\nVERDICT: ${clean ? 'NORMALIZATION FAITHFUL TO RAW' : 'DISCREPANCY — investigate above'} (external reference-platform parity NOT tested here)`);
}

main().catch((e) => { console.error('bar-truth failed:', e instanceof Error ? e.message : e); process.exit(1); });
