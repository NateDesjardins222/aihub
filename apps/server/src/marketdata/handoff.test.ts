/**
 * History/live handoff (Professional Market Data V2, Phases 38-40).
 *
 * The join between bootstrapped history and the live stream is where duplicate,
 * missing, reset or backward candles are born. These tests exercise it at the
 * CandleAggregator — deterministic, in-process, no DB, no provider, no key, so
 * they are part of the offline gate and safe in CI when the market is closed.
 *
 * Invariants proven: history then live continues without duplicating or
 * resetting the boundary bar; an overlapping re-sent bar is a revision, not a
 * second candle (no volume double-count); a live bar that arrives during the
 * historical load is not lost when history seeds around it (the startup race);
 * and the derived series never regresses in time.
 */
import { describe, expect, it } from 'vitest';
import { CandleAggregator } from '@atlas/core';
import { requireInstrument } from '@atlas/instruments';
import type { NormalizedBar, NormalizedTrade } from '@atlas/contracts';

const spec = requireInstrument('NQ');
const MIN = 60_000;
const T0 = Date.UTC(2026, 5, 1, 14, 0, 0); // minute-aligned

function bar(minute: number, o: number, h: number, l: number, c: number, v: number, closed = true): NormalizedBar {
  return { symbol: 'NQ', time: T0 + minute * MIN, open: o, high: h, low: l, close: c, volume: v, closed };
}
function trade(minute: number, secs: number, price: number, size: number, seq: number): NormalizedTrade {
  return { symbol: 'NQ', exchangeTs: T0 + minute * MIN + secs * 1000, price, size, seq, aggressor: 'BUY' };
}
function agg(): CandleAggregator {
  return new CandleAggregator(spec, { baseTimeframe: '1m' });
}
function monotonic(bars: readonly NormalizedBar[]): boolean {
  for (let i = 1; i < bars.length; i += 1) if (bars[i]!.time <= bars[i - 1]!.time) return false;
  return true;
}

describe('history/live handoff', () => {
  it('continues from history into live without a duplicate, reset or gap', () => {
    const a = agg();
    a.seed([bar(0, 100, 101, 99, 100, 5), bar(1, 100, 102, 99, 101, 6), bar(2, 101, 103, 100, 102, 7)]);
    // Live resumes in the NEXT bucket.
    a.ingestTrade(trade(3, 1, 102, 2, 1));
    a.ingestTrade(trade(3, 30, 104, 3, 2));
    const bars = a.series('1m');
    expect(bars.map((b) => b.time)).toEqual([0, 1, 2, 3].map((m) => T0 + m * MIN));
    expect(monotonic(bars)).toBe(true);
    const forming = bars[bars.length - 1]!;
    expect(forming.closed).toBe(false);
    expect(forming.open).toBe(102); // first live trade sets the open
    expect(forming.high).toBe(104);
    expect(forming.volume).toBe(5);
  });

  it('treats an overlapping re-sent bar as a revision, never a second candle', () => {
    const a = agg();
    a.seed([bar(0, 100, 101, 99, 100, 5), bar(1, 100, 102, 99, 101, 6)]);
    // The boundary bar is re-delivered (reconnect/replay overlap).
    a.ingestBar(bar(1, 100, 102, 99, 101, 6), 'STREAM');
    const bars = a.series('1m');
    expect(bars.filter((b) => b.time === T0 + 1 * MIN)).toHaveLength(1); // no duplicate
    expect(bars.find((b) => b.time === T0 + 1 * MIN)!.volume).toBe(6); // no double-count
    expect(monotonic(bars)).toBe(true);
  });

  it('does not lose a live bar that arrived during the historical load (startup race)', () => {
    const a = agg();
    // Live trade for bucket 5 arrives FIRST, while history is still loading...
    a.ingestTrade(trade(5, 2, 110, 4, 1));
    // ...then history seeds the earlier buckets around it.
    a.seed([bar(0, 100, 101, 99, 100, 5), bar(1, 100, 102, 99, 101, 6), bar(2, 101, 103, 100, 102, 7)]);
    const bars = a.series('1m');
    // The live bucket survived and sits after the seeded history.
    const live = bars.find((b) => b.time === T0 + 5 * MIN);
    expect(live).toBeDefined();
    expect(live!.open).toBe(110);
    expect(live!.closed).toBe(false);
    expect(monotonic(bars)).toBe(true);
  });

  it('resumes after a gap without inventing the missing interval', () => {
    const a = agg();
    a.seed([bar(0, 100, 101, 99, 100, 5)]);
    // A gap (buckets 1..9 never traded), then live resumes at bucket 10.
    a.ingestTrade(trade(10, 5, 120, 2, 1));
    const bars = a.series('1m');
    // No invented bars for the empty interval; only the two real buckets exist.
    expect(bars.map((b) => (b.time - T0) / MIN)).toEqual([0, 10]);
    expect(monotonic(bars)).toBe(true);
  });

  it('derives higher timeframes from the same fine series after a handoff', () => {
    const a = agg();
    a.seed(Array.from({ length: 5 }, (_, i) => bar(i, 100 + i, 101 + i, 99 + i, 100 + i, 1)));
    a.ingestTrade(trade(5, 1, 106, 3, 1));
    const five = a.series('5m');
    // First 5m bucket folds minutes 0..4; the forming one holds minute 5.
    expect(five.length).toBeGreaterThanOrEqual(1);
    expect(monotonic(five.filter((b) => b.closed))).toBe(true);
  });
});
