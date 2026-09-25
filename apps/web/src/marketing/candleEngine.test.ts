/**
 * The synthetic candle engine backs the branded header. These tests lock in the
 * three properties that make it feel like a live chart without misbehaving:
 * history already exists at load, every candle is a pure function of its index
 * (so a hidden tab recovers exactly — never a run of flat candles), and the
 * candles have genuine, varied ranges.
 */
import { describe, expect, it } from 'vitest';
import { CandleEngine } from './candleEngine';

const T0 = 1_700_000_000_000; // a fixed "load" instant

describe('history on arrival', () => {
  it('shows a full window of completed candles immediately', () => {
    const e = new CandleEngine({}, T0);
    const f = e.frame(T0);
    expect(f.candles.length).toBe(e.visible);
    expect(f.activeIndex).toBeGreaterThanOrEqual(e.visible);
    // Every historical candle is already formed (has a real range).
    for (const c of f.candles) expect(c.high).toBeGreaterThan(c.low);
  });
});

describe('purity — candle(i) is a pure function of its index', () => {
  it('two engines created at different times agree on the same index', () => {
    const a = new CandleEngine({}, T0);
    const b = new CandleEngine({}, T0 + 987_654); // different origin
    for (const i of [0, 1, 7, 42, 99, 500]) {
      expect(b.candle(i)).toEqual(a.candle(i));
    }
  });
  it('the same index is identical on repeated reads', () => {
    const e = new CandleEngine({}, T0);
    expect(e.candle(123)).toEqual(e.candle(123));
  });
});

describe('catch-up after a hidden tab — no flat candles', () => {
  it('an hour later, the window is full of non-degenerate candles', () => {
    const e = new CandleEngine({}, T0);
    const later = T0 + 60 * 60 * 1000; // one hour of "hidden tab"
    const f = e.frame(later);
    // The active index advanced by ~ (3600s / 3s).
    expect(f.activeIndex).toBeGreaterThan(e.frame(T0).activeIndex + 1000);
    // Not a single flat, zero-range candle in the visible window.
    for (const c of f.candles) {
      expect(c.high).toBeGreaterThan(c.low);
      expect(Number.isFinite(c.open)).toBe(true);
      expect(Number.isFinite(c.close)).toBe(true);
    }
    // And they are not all identical (the classic "stuck" failure mode).
    const ranges = f.candles.map((c) => c.high - c.low);
    expect(new Set(ranges.map((r) => Math.round(r))).size).toBeGreaterThan(3);
  });
});

describe('the active candle forms tick-by-tick', () => {
  it('starts at the open and progresses within the bucket', () => {
    const e = new CandleEngine({}, T0);
    const active = e.activeIndex(T0);
    const bucket = e.bucketMs;
    const startOfBucket = T0 - e.progress(T0) * bucket; // align to bucket start

    const atOpen = e.frame(startOfBucket + 1);
    expect(atOpen.partial.progress).toBeLessThan(0.05);
    expect(atOpen.partial.price).toBeCloseTo(atOpen.partial.open, 6);

    const mid = e.frame(startOfBucket + bucket * 0.5);
    expect(mid.partial.progress).toBeGreaterThan(0.4);
    expect(mid.partial.progress).toBeLessThan(0.6);
    // High/low bound the current price.
    expect(mid.partial.high).toBeGreaterThanOrEqual(mid.partial.price);
    expect(mid.partial.low).toBeLessThanOrEqual(mid.partial.price);
    expect(active).toBe(e.activeIndex(T0));
  });

  it('progress is always within [0, 1)', () => {
    const e = new CandleEngine({}, T0);
    for (let k = 0; k < 50; k += 1) {
      const p = e.progress(T0 + k * 137);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });
});

describe('varied candle character', () => {
  it('produces a mix of small, medium and large ranges', () => {
    const e = new CandleEngine({}, T0);
    const ranges: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const c = e.candle(i);
      ranges.push(c.high - c.low);
    }
    const min = Math.min(...ranges);
    const max = Math.max(...ranges);
    // Some candles are much larger than others — not a flat, uniform strip.
    expect(max).toBeGreaterThan(min * 2.5);
    // Bodies are not all the same sign — direction flips.
    const ups = Array.from({ length: 200 }, (_, i) => e.candle(i)).filter((c) => c.close >= c.open).length;
    expect(ups).toBeGreaterThan(20);
    expect(ups).toBeLessThan(180);
  });
});
