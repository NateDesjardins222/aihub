/**
 * Deterministic bar comparison + historical/live merge (Milestone 9).
 *
 * §14: chart correctness is proven by exact numbers, not visual similarity. This
 * utility diffs Rithmic bars against an authoritative reference (e.g. R|Trader Pro
 * export) field by field and reports every mismatch. §15: historical + live bars
 * merge with no duplicate current bar, no backward timestamps, no phantom bars and
 * no double-counted volume.
 */
import type { NormalizedBar } from '@atlas/contracts';

export interface BarDiff {
  readonly time: number;
  readonly field: 'open' | 'high' | 'low' | 'close' | 'volume' | 'missing_in_a' | 'missing_in_b';
  readonly a: number | null;
  readonly b: number | null;
}

export interface BarComparison {
  readonly matched: number;
  readonly diffs: readonly BarDiff[];
  readonly identical: boolean;
}

/** Compare two bar series by open time; report every field mismatch and any gaps. */
export function compareBars(a: readonly NormalizedBar[], b: readonly NormalizedBar[], priceEpsilon = 1e-9): BarComparison {
  const byTimeA = new Map(a.map((x) => [x.time, x]));
  const byTimeB = new Map(b.map((x) => [x.time, x]));
  const times = [...new Set([...byTimeA.keys(), ...byTimeB.keys()])].sort((x, y) => x - y);
  const diffs: BarDiff[] = [];
  let matched = 0;
  for (const t of times) {
    const x = byTimeA.get(t);
    const y = byTimeB.get(t);
    if (!x) { diffs.push({ time: t, field: 'missing_in_a', a: null, b: y!.close }); continue; }
    if (!y) { diffs.push({ time: t, field: 'missing_in_b', a: x.close, b: null }); continue; }
    let ok = true;
    for (const f of ['open', 'high', 'low', 'close'] as const) {
      if (Math.abs(x[f] - y[f]) > priceEpsilon) { diffs.push({ time: t, field: f, a: x[f], b: y[f] }); ok = false; }
    }
    if (x.volume !== y.volume) { diffs.push({ time: t, field: 'volume', a: x.volume, b: y.volume }); ok = false; }
    if (ok) matched += 1;
  }
  return { matched, diffs, identical: diffs.length === 0 };
}

/** Render a bar comparison as a plain-text report for the CLI debug tool. */
export function formatBarComparison(cmp: BarComparison): string {
  const lines = [`bars matched: ${cmp.matched}`, `diffs: ${cmp.diffs.length}`, cmp.identical ? 'IDENTICAL' : 'MISMATCH'];
  for (const d of cmp.diffs.slice(0, 50)) {
    lines.push(`  ${new Date(d.time).toISOString()} ${d.field}: a=${d.a} b=${d.b}`);
  }
  return lines.join('\n');
}

/**
 * Merge historical (all closed) with live bars. Live bars override historical at
 * the same open time (the live one is authoritative as it forms), duplicates
 * collapse, times sort ascending, and the result never contains two bars at the
 * same open time — so volume is never double-counted and there is no phantom or
 * backward bar.
 */
export function mergeHistoricalWithLive(historical: readonly NormalizedBar[], live: readonly NormalizedBar[]): NormalizedBar[] {
  const byTime = new Map<number, NormalizedBar>();
  for (const b of historical) byTime.set(b.time, b);
  for (const b of live) byTime.set(b.time, b); // live wins at same open time
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Validate a merged series for the invariants §15 requires. Returns problems (empty = clean). */
export function validateBarSeries(bars: readonly NormalizedBar[]): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  let prev = -Infinity;
  for (const b of bars) {
    if (seen.has(b.time)) problems.push(`duplicate bar at ${b.time}`);
    seen.add(b.time);
    if (b.time < prev) problems.push(`backward timestamp at ${b.time} (prev ${prev})`);
    prev = b.time;
    if (!(b.high >= b.low && b.high >= b.open && b.high >= b.close && b.low <= b.open && b.low <= b.close)) {
      problems.push(`OHLC invariant violated at ${b.time}`);
    }
    if (b.volume < 0) problems.push(`negative volume at ${b.time}`);
  }
  return problems;
}
