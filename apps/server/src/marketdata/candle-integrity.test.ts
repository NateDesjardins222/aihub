/**
 * D-17/D-18 — candle integrity audit.
 *
 * Proves the auditor catches every class of data defect and that a well-formed
 * aggregated series (including a still-forming last bar whose open is the bucket
 * open) passes clean. This is the harness that separates a DATA error from a
 * render/time-scale question.
 */
import { describe, expect, it } from 'vitest';
import { auditCandles, type AuditBar } from './candle-integrity';

const MIN = 60_000;

/** A clean, aligned, strictly-increasing 1-minute series. */
function goodSeries(n: number, start = 0): AuditBar[] {
  const bars: AuditBar[] = [];
  let price = 20_000;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = price + (i % 2 === 0 ? 2 : -1.5);
    const high = Math.max(open, close) + 1;
    const low = Math.min(open, close) - 1;
    bars.push({ time: start + i * MIN, open, high, low, close, volume: 100, closed: true });
    price = close;
  }
  return bars;
}

describe('candle integrity audit (D-17)', () => {
  it('a clean 1m series passes with no hard violations', () => {
    const res = auditCandles(goodSeries(200), { barMs: MIN });
    expect(res.ok).toBe(true);
    expect(res.hardViolations).toHaveLength(0);
    expect(res.bars).toBe(200);
  });

  it('a still-forming last bar (open = bucket open) is valid', () => {
    const bars = goodSeries(10);
    // Forming bar: open is the bucket open, high/low bracket the body, not closed.
    bars.push({ time: 10 * MIN, open: 20_010, high: 20_015, low: 20_008, close: 20_012, closed: false });
    expect(auditCandles(bars, { barMs: MIN }).ok).toBe(true);
  });

  it('catches a high below the body', () => {
    const bars = goodSeries(3);
    bars[1] = { ...bars[1]!, high: bars[1]!.open - 5 };
    const res = auditCandles(bars, { barMs: MIN });
    expect(res.ok).toBe(false);
    expect(res.hardViolations.map((v) => v.kind)).toContain('HIGH_BELOW_BODY');
  });

  it('catches a low above the body and high below low', () => {
    const bars = goodSeries(3);
    bars[1] = { ...bars[1]!, low: bars[1]!.high + 5 };
    const kinds = auditCandles(bars, { barMs: MIN }).hardViolations.map((v) => v.kind);
    expect(kinds).toContain('LOW_ABOVE_BODY');
    expect(kinds).toContain('HIGH_BELOW_LOW');
  });

  it('catches a duplicate and an out-of-order timestamp', () => {
    const dup = goodSeries(3);
    dup[2] = { ...dup[2]!, time: dup[1]!.time };
    expect(auditCandles(dup, { barMs: MIN }).hardViolations.map((v) => v.kind)).toContain('DUPLICATE_TIME');

    const back = goodSeries(3);
    back[2] = { ...back[2]!, time: back[0]!.time - MIN };
    expect(auditCandles(back, { barMs: MIN }).hardViolations.map((v) => v.kind)).toContain(
      'TIME_NOT_INCREASING',
    );
  });

  it('catches a mis-bucketed timestamp', () => {
    const bars = goodSeries(3);
    bars[1] = { ...bars[1]!, time: bars[1]!.time + 7_000 }; // 7s off the 1m grid
    const res = auditCandles(bars, { barMs: MIN });
    expect(res.hardViolations.map((v) => v.kind)).toContain('MISALIGNED_BUCKET');
  });

  it('catches a non-finite price', () => {
    const bars = goodSeries(3);
    bars[1] = { ...bars[1]!, close: Number.NaN };
    expect(auditCandles(bars, { barMs: MIN }).hardViolations.map((v) => v.kind)).toContain('NON_FINITE');
  });

  it('reports session gaps only when asked, and never as a hard violation', () => {
    const bars = goodSeries(3);
    bars[2] = { ...bars[2]!, time: bars[1]!.time + 5 * MIN }; // a 4-bucket gap
    const silent = auditCandles(bars, { barMs: MIN });
    expect(silent.violations.some((v) => v.kind === 'GAP')).toBe(false);
    const loud = auditCandles(bars, { barMs: MIN, reportGaps: true });
    expect(loud.violations.some((v) => v.kind === 'GAP')).toBe(true);
    expect(loud.ok).toBe(true); // a gap is informational, not a data error
  });
});
