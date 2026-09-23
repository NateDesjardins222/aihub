/**
 * D-05 — Measure tool metrics.
 */
import { describe, expect, it } from 'vitest';
import { measureStats, formatElapsed, timeframeMs, measureReadoutLines } from './measure';

describe('measureStats (D-05)', () => {
  it('computes price change, ticks, percent, value and bars for an up move', () => {
    const s = measureStats(
      { time: 0, price: 20_000 },
      { time: 5 * 60_000, price: 20_010 }, // +10.00, 5 minutes
      { tickSize: 0.25, tickValueMicros: 5_000_000, barMs: 60_000 },
    );
    expect(s.priceDelta).toBeCloseTo(10, 6);
    expect(s.ticks).toBe(40); // 10 / 0.25
    expect(s.percent).toBeCloseTo(0.05, 4); // 10 / 20000 * 100
    expect(s.valueMicros).toBe(200_000_000); // 40 ticks * $5 = $200
    expect(s.bars).toBe(5);
    expect(s.elapsedMs).toBe(300_000);
    expect(s.up).toBe(true);
  });

  it('is signed for a down move', () => {
    const s = measureStats(
      { time: 0, price: 20_000 },
      { time: 60_000, price: 19_990 },
      { tickSize: 0.25, tickValueMicros: 5_000_000, barMs: 60_000 },
    );
    expect(s.priceDelta).toBeCloseTo(-10, 6);
    expect(s.ticks).toBe(-40);
    expect(s.valueMicros).toBe(-200_000_000);
    expect(s.up).toBe(false);
  });

  it('leaves value/ticks null when the tick size or value is unknown', () => {
    const s = measureStats({ time: 0, price: 100 }, { time: 0, price: 105 }, {});
    expect(s.ticks).toBeNull();
    expect(s.valueMicros).toBeNull();
    expect(s.bars).toBeNull(); // no barMs
    expect(s.priceDelta).toBeCloseTo(5, 6);
  });

  it('formats elapsed time in minutes, hours and days', () => {
    expect(formatElapsed(45 * 60_000)).toBe('45m');
    expect(formatElapsed(135 * 60_000)).toBe('2h 15m');
    expect(formatElapsed(3 * 60 * 60_000)).toBe('3h');
    expect(formatElapsed((28 * 60 + 0) * 60_000)).toBe('1d 4h');
  });

  it('maps timeframe labels to bar milliseconds', () => {
    expect(timeframeMs('1m')).toBe(60_000);
    expect(timeframeMs('5m')).toBe(300_000);
    expect(timeframeMs('1h')).toBe(3_600_000);
    expect(timeframeMs('1D')).toBe(86_400_000);
    expect(timeframeMs('nonsense')).toBeNull();
  });

  it('produces readable readout lines including ticks, percent, value and time', () => {
    const s = measureStats(
      { time: 0, price: 20_000 },
      { time: 5 * 60_000, price: 20_010 },
      { tickSize: 0.25, tickValueMicros: 5_000_000, barMs: 60_000 },
    );
    const lines = measureReadoutLines(s, 2, (m) => `$${(m / 1_000_000).toFixed(2)}`);
    expect(lines[0]).toContain('ticks');
    expect(lines.some((l) => l.includes('%'))).toBe(true);
    expect(lines.some((l) => l.includes('/contract'))).toBe(true);
    expect(lines.some((l) => l.includes('bars') && l.includes('5m'))).toBe(true);
  });
});
