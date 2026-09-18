/**
 * The 1-minute timeline, audited end to end.
 *
 * Fetches the vendor payload directly, then asks Atlas for the same window,
 * and reports every minute of a chosen period side by side. Nothing here goes
 * through Atlas's own code except the API it is auditing, so a disagreement
 * between the two columns is a real disagreement.
 *
 *   node tools/candle-audit.mjs [SYMBOL] [FROM_HHMM] [MINUTES]
 *
 * Times are in the instrument's exchange timezone (America/Chicago for CME).
 */
const API = process.env.ATLAS_API ?? 'http://localhost:4000';
const EMAIL = process.env.ATLAS_EMAIL ?? 'demo@atlasfutures.local';
const PASSWORD = process.env.ATLAS_PASSWORD ?? 'atlas-demo-2026';

const [, , symbolArg = 'NQ', fromArg = '15:30', minutesArg = '30'] = process.argv;
const SYMBOL = symbolArg.toUpperCase();
const MINUTES = Number(minutesArg);

const VENDOR = { NQ: 'NQ=F', MNQ: 'NQ=F', ES: 'ES=F', MES: 'ES=F', GC: 'GC=F', MGC: 'GC=F', CL: 'CL=F', MCL: 'CL=F' };
/** Tick size per instrument, for comparing at the resolution the market has. */
const TICK = { NQ: 0.25, MNQ: 0.25, ES: 0.25, MES: 0.25, GC: 0.1, MGC: 0.1, CL: 0.01, MCL: 0.01 };
const ZONE = 'America/Chicago';

/*
 * Compare at TICK resolution, and count what the vendor's encoding costs
 * separately.
 *
 * Yahoo serves some series as 32-bit floats: gold's 4388.30 arrives as
 * 4388.2998046875. Atlas snaps every price to the instrument's tick, which
 * recovers 4388.30 exactly - so Atlas is closer to the market than the payload
 * it was built from, and a naive float comparison reports 1324 "differences"
 * that are all the vendor's rounding. A difference worth reporting is one of at
 * least half a tick, because nothing smaller can be a real price.
 */
const tick = TICK[SYMBOL] ?? 0.25;
const differs = (a, b) => Math.abs(a - b) >= tick / 2;
const vendorNoise = (a, b) => Math.abs(a - b) > 1e-9 && Math.abs(a - b) < tick / 2;

const chicago = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const hhmm = (ms) => {
  const p = Object.fromEntries(chicago.formatToParts(ms).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
};
const ymd = (ms) => {
  const p = Object.fromEntries(chicago.formatToParts(ms).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

async function token() {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  return (await r.json()).accessToken;
}

/** The vendor's own 1-minute rows, untouched. */
async function vendorBars() {
  const vs = VENDOR[SYMBOL];
  if (!vs) throw new Error(`no vendor symbol for ${SYMBOL}`);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(vs)}?interval=1m&range=1d&includePrePost=true`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; AtlasFuturesTerminal/0.1; simulation)', accept: 'application/json' } });
  if (!r.ok) throw new Error(`vendor HTTP ${r.status}`);
  const body = await r.json();
  const result = body.chart?.result?.[0];
  if (!result) throw new Error('vendor returned no result');
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const rows = [];
  for (let i = 0; i < ts.length; i += 1) {
    rows.push({
      time: ts[i] * 1000,
      aligned: (ts[i] % 60) === 0,
      open: q.open?.[i] ?? null,
      high: q.high?.[i] ?? null,
      low: q.low?.[i] ?? null,
      close: q.close?.[i] ?? null,
      volume: q.volume?.[i] ?? null,
    });
  }
  return { rows, meta: result.meta };
}

async function atlasBars(tok) {
  const r = await fetch(`${API}/api/v1/marketdata/bars?symbol=${SYMBOL}&timeframe=1m&limit=2000`, {
    headers: { authorization: `Bearer ${tok}` },
  });
  if (!r.ok) throw new Error(`atlas HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

const n = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));

const tok = await token();
const [vendor, atlas] = await Promise.all([vendorBars(), atlasBars(tok)]);

console.log(`# ${SYMBOL} 1-minute audit`);
console.log(`vendor symbol       ${VENDOR[SYMBOL]}`);
console.log(`vendor rows         ${vendor.rows.length}`);
console.log(`  off-grid rows     ${vendor.rows.filter((r) => !r.aligned).length}`);
console.log(`  all-null rows     ${vendor.rows.filter((r) => r.open == null && r.close == null).length}`);
console.log(`  zero-volume rows  ${vendor.rows.filter((r) => r.volume === 0).length}`);
console.log(`vendor regularMarketTime  ${new Date((vendor.meta.regularMarketTime ?? 0) * 1000).toISOString()} (${hhmm((vendor.meta.regularMarketTime ?? 0) * 1000)} ${ZONE})`);
console.log(`vendor first/last   ${hhmm(vendor.rows[0].time)} -> ${hhmm(vendor.rows[vendor.rows.length - 1].time)}`);
console.log(`atlas bars          ${atlas.bars.length}  source=${atlas.source} provider=${atlas.provider} mode=${atlas.mode}`);
if (atlas.bars.length) {
  console.log(`atlas first/last    ${hhmm(atlas.bars[0].time)} -> ${hhmm(atlas.bars[atlas.bars.length - 1].time)}`);
}

// Overlap analysis over the whole day, before zooming into the window.
const vendorAligned = vendor.rows.filter((r) => r.aligned && r.open != null);
const vByTime = new Map(vendorAligned.map((r) => [r.time, r]));
const aByTime = new Map(atlas.bars.map((b) => [b.time, b]));
const lo = Math.max(vendorAligned[0]?.time ?? 0, atlas.bars[0]?.time ?? 0);
const hi = Math.min(
  vendorAligned[vendorAligned.length - 1]?.time ?? 0,
  atlas.bars[atlas.bars.length - 1]?.time ?? 0,
);
let inVendorOnly = 0, inAtlasOnly = 0, both = 0, ohlcDiff = 0, volDiff = 0;
let noiseOnly = 0, closedDiff = 0;
for (const t of new Set([...vByTime.keys(), ...aByTime.keys()])) {
  if (t < lo || t > hi) continue;
  const v = vByTime.get(t), a = aByTime.get(t);
  if (v && !a) inVendorOnly += 1;
  else if (!v && a) inAtlasOnly += 1;
  else if (v && a) {
    both += 1;
    const pairs = [[v.open, a.open], [v.high, a.high], [v.low, a.low], [v.close, a.close]];
    if (pairs.some(([x, y]) => differs(x, y))) {
      ohlcDiff += 1;
      if (a.closed !== false) closedDiff += 1;
    } else if (pairs.some(([x, y]) => vendorNoise(x, y))) {
      noiseOnly += 1;
    }
    if ((v.volume ?? 0) !== a.volume) volDiff += 1;
  }
}
console.log(`\n## overlap ${hhmm(lo)} -> ${hhmm(hi)} (${ymd(lo)})`);
console.log(`minutes in both            ${both}`);
console.log(`minutes vendor has, atlas lacks  ${inVendorOnly}`);
console.log(`minutes atlas has, vendor lacks  ${inAtlasOnly}`);
console.log(`minutes differing by >= half a tick  ${ohlcDiff}`);
console.log(`  of those, on a CLOSED bar         ${closedDiff}   <- must be 0`);
console.log(`minutes agreeing to within a tick,`);
console.log(`  but not bit-exact (vendor float32) ${noiseOnly}`);
console.log(`minutes with different volume        ${volDiff}`);

// Invariants on what Atlas serves.
let bad = 0, dupes = 0, unordered = 0, offGrid = 0;
let prev = null;
const seen = new Set();
for (const b of atlas.bars) {
  if (!(b.low <= b.open && b.open <= b.high && b.low <= b.close && b.close <= b.high)) bad += 1;
  if (seen.has(b.time)) dupes += 1;
  seen.add(b.time);
  if (prev !== null && b.time <= prev) unordered += 1;
  if (b.time % 60000 !== 0) offGrid += 1;
  prev = b.time;
}
console.log(`\n## invariants on what Atlas serves`);
console.log(`bars violating low<=open/close<=high  ${bad}`);
console.log(`duplicate timestamps                  ${dupes}`);
console.log(`out-of-order timestamps               ${unordered}`);
console.log(`timestamps off the 1-minute grid      ${offGrid}`);

/*
 * The requested window, minute by minute.
 *
 * The hour is asked for without a date, and the overlap regularly straddles
 * midnight - 23:09 on one day to 01:05 on the next. So the day of the LAST bar
 * is only the first place to look: if that day has no such minute, take the
 * most recent one that does, and say which day it came from. Printing "no data
 * at 23:30" for a minute that is sitting in both columns is the audit lying
 * about its own inputs.
 */
const [fh, fm] = fromArg.split(':').map(Number);
const wanted = `${String(fh).padStart(2, '0')}:${String(fm).padStart(2, '0')}`;
const lastDay = ymd(atlas.bars[atlas.bars.length - 1]?.time ?? Date.now());
const candidates = [...vByTime.keys(), ...aByTime.keys()]
  .sort((a, b) => a - b)
  .filter((t) => hhmm(t) === wanted);
const startTs =
  candidates.find((t) => ymd(t) === lastDay) ?? candidates[candidates.length - 1];
const day = startTs === undefined ? lastDay : ymd(startTs);

console.log(`\n## ${fromArg} onwards, ${MINUTES} minutes (${day} ${ZONE})`);
console.log('| minute | vendor O/H/L/C | vendor V | atlas O/H/L/C | atlas V | verdict |');
console.log('| --- | --- | --- | --- | --- | --- |');
if (startTs === undefined) {
  console.log(`| (no data at ${fromArg} on ${day}) | | | | | |`);
} else {
  for (let i = 0; i < MINUTES; i += 1) {
    const t = startTs + i * 60_000;
    const v = vByTime.get(t), a = aByTime.get(t);
    const raw = vendor.rows.find((r) => r.time === t);
    let verdict;
    if (!v && !a) verdict = raw ? 'vendor row is null — no trading' : 'neither has this minute';
    else if (v && !a) verdict = '**ATLAS MISSING**';
    else if (!v && a) verdict = '**ATLAS EXTRA**';
    else {
      const pairs = [[v.open, a.open], [v.high, a.high], [v.low, a.low], [v.close, a.close]];
      if (pairs.some(([x, y]) => differs(x, y))) {
        verdict = a.closed === false ? 'forming bar, still moving' : '**OHLC DIFFERS**';
      } else if ((v.volume ?? 0) !== a.volume) verdict = 'volume differs';
      else verdict = pairs.some(([x, y]) => vendorNoise(x, y)) ? 'match (vendor float32 rounded)' : 'match';
    }
    console.log(
      `| ${hhmm(t)} | ${v ? `${n(v.open)}/${n(v.high)}/${n(v.low)}/${n(v.close)}` : '—'} | ${v ? (v.volume ?? '—') : '—'} ` +
      `| ${a ? `${n(a.open)}/${n(a.high)}/${n(a.low)}/${n(a.close)}` : '—'} | ${a ? a.volume : '—'} | ${verdict} |`,
    );
  }
}
