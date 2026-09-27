/**
 * Engineering Phase A — candle-truth regression (deterministic, no network).
 *
 * Locks the invariants the live bar-truth diagnostic proved against Yahoo:
 *  - a vendor null minute becomes a GAP (dropped), never a fabricated candle;
 *  - a valid minute is normalized FAITHFULLY (tick-snapped, self-consistent);
 *  - bar timestamps are bucket-OPEN epoch-ms (tsSeconds*1000);
 *  - bar count = input minutes minus null/invalid drops, no duplication.
 * These fail if the pipeline ever starts inventing, dropping, or shifting bars.
 */
import { describe, expect, it } from 'vitest';
import { requireInstrument } from '@atlas/instruments';
import { emptyStats, normalizeBar, type RawBarInput } from './normalize.js';

const NQ = requireInstrument('NQ');
const MIN = 60;
const base = 1_790_000_000; // arbitrary epoch seconds on the minute grid

function row(minute: number, o: number, h: number, l: number, c: number, v: number | null = 100): RawBarInput {
  return { tsSeconds: base + minute * MIN, open: o, high: h, low: l, close: c, volume: v };
}

describe('candle truth — normalization is faithful and never fabricates', () => {
  it('a null minute is dropped as a gap, never invented', () => {
    const stats = emptyStats();
    const nullRow: RawBarInput = { tsSeconds: base, open: null, high: null, low: null, close: null, volume: null };
    expect(normalizeBar(NQ, nullRow, stats, true)).toBeNull();
    expect(stats.droppedNullPrice).toBe(1);
    expect(stats.accepted).toBe(0);
  });

  it('a valid minute normalizes faithfully with bucket-open epoch-ms and tick snap', () => {
    const stats = emptyStats();
    const bar = normalizeBar(NQ, row(0, 20000, 20005.25, 19998.5, 20003.75), stats, true)!;
    expect(bar).not.toBeNull();
    expect(bar.time).toBe(base * 1000); // seconds -> ms, open-time
    expect(bar.open).toBe(20000);
    expect(bar.high).toBe(20005.25);
    expect(bar.low).toBe(19998.5);
    expect(bar.close).toBe(20003.75);
    expect(bar.volume).toBe(100);
    // low <= open,close <= high always holds after normalization.
    expect(bar.low <= bar.open && bar.open <= bar.high).toBe(true);
    expect(bar.low <= bar.close && bar.close <= bar.high).toBe(true);
  });

  it('an off-tick price is snapped to the instrument grid (0.25 for NQ)', () => {
    const stats = emptyStats();
    const bar = normalizeBar(NQ, row(0, 20000.12, 20000.62, 19999.87, 20000.37), stats, true)!;
    for (const v of [bar.open, bar.high, bar.low, bar.close]) expect((v * 100) % 25).toBe(0);
    expect(stats.snapped).toBe(1);
  });

  it('a window with null minutes yields exactly (minutes - nulls) bars, in order, unique', () => {
    const stats = emptyStats();
    const rows: RawBarInput[] = [];
    for (let m = 0; m < 10; m += 1) {
      // minutes 3 and 7 are vendor nulls (no trade)
      if (m === 3 || m === 7) rows.push({ tsSeconds: base + m * MIN, open: null, high: null, low: null, close: null, volume: null });
      else rows.push(row(m, 20000 + m, 20000 + m + 1, 20000 + m - 1, 20000 + m));
    }
    const bars = rows.map((r) => normalizeBar(NQ, r, stats, true)).filter((b) => b !== null);
    expect(bars).toHaveLength(8); // 10 minutes - 2 nulls, no fabrication of the gaps
    const times = bars.map((b) => b!.time);
    expect(new Set(times).size).toBe(times.length); // unique
    for (let i = 1; i < times.length; i += 1) expect(times[i]! > times[i - 1]!).toBe(true); // ascending
    // The gap minutes (3, 7) are simply absent — never filled with a synthetic price.
    expect(times).not.toContain((base + 3 * MIN) * 1000);
    expect(times).not.toContain((base + 7 * MIN) * 1000);
  });
});
