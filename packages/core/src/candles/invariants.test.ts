/**
 * The invariants, and golden data that must satisfy them.
 *
 * The golden set is a real NQ 1-minute window captured from the audited feed on
 * 2026-09-17 (15:30-15:49 America/Chicago), verified against the vendor payload
 * minute by minute by `tools/candle-audit.mjs`. It is committed so that a
 * regression in folding, snapping, ordering or bucketing has something it
 * cannot argue with.
 */
import { describe, expect, it } from 'vitest';
import { requireInstrument } from '@atlas/instruments';
import type { NormalizedBar } from '@atlas/contracts';
import { checkBars, describeViolations } from './invariants.js';
import { foldBars } from './fold.js';

const NQ = requireInstrument('NQ');
const GC = requireInstrument('GC');

/** 15:30-15:49 CT on 2026-09-17, exactly as the vendor served it. */
const GOLDEN_NQ_1M: NormalizedBar[] = [
  [1789677000000, 29715.25, 29717.0, 29714.5, 29714.75, 66],
  [1789677060000, 29714.5, 29717.25, 29714.5, 29716.75, 63],
  [1789677120000, 29716.5, 29717.75, 29715.5, 29716.75, 118],
  [1789677180000, 29716.75, 29718.0, 29716.25, 29718.0, 36],
  [1789677240000, 29718.0, 29718.5, 29715.25, 29717.75, 81],
  [1789677300000, 29717.5, 29720.5, 29716.25, 29716.25, 215],
  [1789677360000, 29716.75, 29720.5, 29716.75, 29720.0, 89],
  [1789677420000, 29719.75, 29722.25, 29719.75, 29720.75, 124],
  [1789677480000, 29720.5, 29722.0, 29719.0, 29719.25, 133],
  [1789677540000, 29719.0, 29721.25, 29719.0, 29720.25, 60],
  [1789677600000, 29720.0, 29721.75, 29719.75, 29720.75, 60],
  [1789677660000, 29720.25, 29721.0, 29719.5, 29720.0, 67],
  [1789677720000, 29719.75, 29720.5, 29717.0, 29717.0, 85],
  [1789677780000, 29716.5, 29717.25, 29714.75, 29716.0, 87],
  [1789677840000, 29715.75, 29716.5, 29714.5, 29715.5, 80],
  [1789677900000, 29715.75, 29716.5, 29714.5, 29714.5, 141],
  [1789677960000, 29714.5, 29717.5, 29714.25, 29717.0, 77],
  [1789678020000, 29717.25, 29718.0, 29716.75, 29717.25, 65],
  [1789678080000, 29717.5, 29720.0, 29717.25, 29719.75, 84],
  [1789678140000, 29720.25, 29720.25, 29715.5, 29716.5, 129],
].map(([time, open, high, low, close, volume]) => ({
  symbol: 'NQ',
  time: time!,
  open: open!,
  high: high!,
  low: low!,
  close: close!,
  volume: volume!,
  closed: true,
}));

describe('golden NQ 1-minute data', () => {
  it('satisfies every invariant', () => {
    expect(checkBars(NQ, '1m', GOLDEN_NQ_1M)).toEqual([]);
  });

  it('is twenty consecutive minutes with no hole', () => {
    expect(GOLDEN_NQ_1M).toHaveLength(20);
    for (let i = 1; i < GOLDEN_NQ_1M.length; i += 1) {
      expect(GOLDEN_NQ_1M[i]!.time - GOLDEN_NQ_1M[i - 1]!.time).toBe(60_000);
    }
  });

  it('folds into 5-minute bars that agree with it', () => {
    const m5 = foldBars(NQ, GOLDEN_NQ_1M, '5m');
    expect(m5).toHaveLength(4);
    expect(checkBars(NQ, '5m', m5)).toEqual([]);

    // The first 5-minute bucket, derived by hand from the five minutes above.
    expect(m5[0]).toMatchObject({
      time: 1789677000000,
      open: 29715.25,
      high: 29718.5,
      low: 29714.5,
      close: 29717.75,
      volume: 66 + 63 + 118 + 36 + 81,
    });
    // And the last, so a fold error at either end is caught.
    expect(m5[3]).toMatchObject({
      time: 1789677900000,
      open: 29715.75,
      high: 29720.25,
      low: 29714.25,
      close: 29716.5,
      volume: 141 + 77 + 65 + 84 + 129,
    });
  });

  it('folds into one 20-minute span whose extremes are the window extremes', () => {
    const m10 = foldBars(NQ, GOLDEN_NQ_1M, '10m');
    expect(checkBars(NQ, '10m', m10)).toEqual([]);
    const high = Math.max(...GOLDEN_NQ_1M.map((b) => b.high));
    const low = Math.min(...GOLDEN_NQ_1M.map((b) => b.low));
    expect(Math.max(...m10.map((b) => b.high))).toBe(high);
    expect(Math.min(...m10.map((b) => b.low))).toBe(low);
  });
});

describe('checkBars', () => {
  const bar = (over: Partial<NormalizedBar> = {}): NormalizedBar => ({
    symbol: 'NQ',
    time: 1789677000000,
    open: 29715.25,
    high: 29717.0,
    low: 29714.5,
    close: 29714.75,
    volume: 66,
    closed: true,
    ...over,
  });

  it('catches an open outside the range', () => {
    const v = checkBars(NQ, '1m', [bar({ open: 29800 })]);
    expect(v.map((x) => x.kind)).toContain('OHLC_INCONSISTENT');
  });

  it('catches a close outside the range', () => {
    const v = checkBars(NQ, '1m', [bar({ close: 29000 })]);
    expect(v.map((x) => x.kind)).toContain('OHLC_INCONSISTENT');
  });

  it('catches a price that is not on the tick grid', () => {
    // NQ trades in quarters. A tenth is not a price this contract can have.
    const v = checkBars(NQ, '1m', [bar({ close: 29715.1, low: 29714.5, high: 29717 })]);
    expect(v.map((x) => x.kind)).toContain('PRICE_OFF_TICK');
  });

  it('accepts a tenth on gold, which trades in tenths', () => {
    const gold = bar({ symbol: 'GC', open: 4355.2, high: 4355.6, low: 4353.5, close: 4353.8 });
    expect(checkBars(GC, '1m', [gold])).toEqual([]);
  });

  it('catches a duplicate bucket time', () => {
    const v = checkBars(NQ, '1m', [bar(), bar()]);
    expect(v.map((x) => x.kind)).toContain('DUPLICATE_TIME');
    expect(v.map((x) => x.kind)).toContain('OUT_OF_ORDER');
  });

  it('catches bars out of order', () => {
    const v = checkBars(NQ, '1m', [bar({ time: 1789677060000 }), bar({ time: 1789677000000 })]);
    expect(v.map((x) => x.kind)).toContain('OUT_OF_ORDER');
  });

  it('catches a timestamp off the interval grid', () => {
    const v = checkBars(NQ, '1m', [bar({ time: 1789677030000 })]);
    expect(v.map((x) => x.kind)).toContain('OFF_GRID');
  });

  it('does not apply the grid test to calendar timeframes', () => {
    // A daily bucket opens at the session start, not at a multiple of 24h.
    const v = checkBars(NQ, '1D', [bar({ time: 1789677030000 })]);
    expect(v.map((x) => x.kind)).not.toContain('OFF_GRID');
  });

  it('catches a foreign symbol in the series', () => {
    const v = checkBars(NQ, '1m', [bar({ symbol: 'ES' })]);
    expect(v.map((x) => x.kind)).toContain('WRONG_SYMBOL');
  });

  it('catches negative volume', () => {
    const v = checkBars(NQ, '1m', [bar({ volume: -1 })]);
    expect(v.map((x) => x.kind)).toContain('BAD_VOLUME');
  });

  it('catches a non-finite price', () => {
    const v = checkBars(NQ, '1m', [bar({ close: Number.NaN })]);
    expect(v.map((x) => x.kind)).toContain('NOT_FINITE');
  });

  it('allows the LAST bar to be forming and no other', () => {
    expect(checkBars(NQ, '1m', [bar(), bar({ time: 1789677060000, closed: false })])).toEqual([]);
    const v = checkBars(NQ, '1m', [bar({ closed: false }), bar({ time: 1789677060000 })]);
    expect(v.map((x) => x.kind)).toContain('INTERIOR_BAR_OPEN');
  });

  it('says nothing about a sound series', () => {
    expect(describeViolations([])).toBeNull();
  });

  it('summarises what it found', () => {
    const v = checkBars(NQ, '1m', [bar({ open: 30000 })]);
    expect(describeViolations(v)).toMatch(/OHLC_INCONSISTENT=1/);
  });
});
