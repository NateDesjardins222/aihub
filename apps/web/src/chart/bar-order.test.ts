/**
 * Engineering Phase A — candle regression: the chart series must reach the
 * renderer strictly ascending and unique, whatever a page contains. A duplicate
 * or out-of-order timestamp used to freeze lightweight-charts (its setData throws
 * on unordered/duplicate times), which reads as "misplaced / wrong / frozen"
 * candles. This is the pure guard `applyHistory` now applies.
 */
import { describe, expect, it } from 'vitest';
import type { NormalizedBar } from '@atlas/contracts';
import { orderBarsAscendingUnique } from './bar-order';

const bar = (time: number, close = 100): NormalizedBar => ({
  symbol: 'NQ', time, open: close, high: close + 1, low: close - 1, close, volume: 10, closed: true,
});

describe('orderBarsAscendingUnique', () => {
  it('is a no-op on an already sorted, unique series', () => {
    const input = [bar(1000), bar(2000), bar(3000)];
    const out = orderBarsAscendingUnique(input);
    expect(out.map((b) => b.time)).toEqual([1000, 2000, 3000]);
  });

  it('sorts an out-of-order page ascending', () => {
    const out = orderBarsAscendingUnique([bar(3000), bar(1000), bar(2000)]);
    expect(out.map((b) => b.time)).toEqual([1000, 2000, 3000]);
  });

  it('drops duplicate timestamps, keeping the LAST (a revision of the bucket)', () => {
    const out = orderBarsAscendingUnique([bar(1000, 10), bar(2000, 20), bar(2000, 25), bar(3000, 30)]);
    expect(out.map((b) => b.time)).toEqual([1000, 2000, 3000]);
    expect(out.find((b) => b.time === 2000)!.close).toBe(25); // last-wins
  });

  it('produces a strictly ascending unique series from a scrambled, duplicated page', () => {
    const out = orderBarsAscendingUnique([bar(3000), bar(1000), bar(2000), bar(1000), bar(3000)]);
    const times = out.map((b) => b.time);
    expect(times).toEqual([1000, 2000, 3000]);
    for (let i = 1; i < times.length; i += 1) expect(times[i]! > times[i - 1]!).toBe(true);
  });

  it('handles empty and single-element inputs', () => {
    expect(orderBarsAscendingUnique([])).toEqual([]);
    expect(orderBarsAscendingUnique([bar(5000)]).map((b) => b.time)).toEqual([5000]);
  });
});
