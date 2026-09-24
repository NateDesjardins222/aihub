/** Rule-status bands — pure, deterministic thresholds. */
import { describe, expect, it } from 'vitest';
import { consistencyStatus, drawdownStatus } from './rule-status.js';

const M = 1_000_000;

describe('drawdownStatus', () => {
  // MLL distance = starting − floor = 50,000 − 48,000 = 2,000.
  const start = 50_000 * M;
  const floor = 48_000 * M;
  it('is SAFE well above the floor (> 25% headroom)', () => {
    const s = drawdownStatus(49_000 * M, floor, start); // headroom 1,000 = 50%
    expect(s.band).toBe('SAFE');
    expect(s.headroomMicros).toBe(1_000 * M);
    expect(s.headroomFraction).toBeCloseTo(0.5);
  });
  it('is APPROACHING between 10% and 25%', () => {
    const s = drawdownStatus(48_400 * M, floor, start); // headroom 400 = 20%
    expect(s.band).toBe('APPROACHING');
  });
  it('is AT_RISK under 10%', () => {
    const s = drawdownStatus(48_100 * M, floor, start); // headroom 100 = 5%
    expect(s.band).toBe('AT_RISK');
  });
  it('is BREACHED at or below the floor', () => {
    expect(drawdownStatus(48_000 * M, floor, start).band).toBe('BREACHED');
    expect(drawdownStatus(47_500 * M, floor, start).band).toBe('BREACHED');
    expect(drawdownStatus(47_500 * M, floor, start).headroomMicros).toBe(0);
  });
  it('reports a null fraction when the MLL distance is unknown, still classifying breach', () => {
    const s = drawdownStatus(100 * M, 0, 0); // distance 0
    expect(s.headroomFraction).toBeNull();
    expect(s.band).toBe('SAFE');
    expect(drawdownStatus(-1, 0, 0).band).toBe('BREACHED');
  });
});

describe('consistencyStatus', () => {
  it('is best-day / total, within threshold when under it', () => {
    const s = consistencyStatus(30 * M, 100 * M, 0.4);
    expect(s.ratio).toBeCloseTo(0.3);
    expect(s.withinThreshold).toBe(true);
  });
  it('flags over-threshold', () => {
    expect(consistencyStatus(60 * M, 100 * M, 0.4).withinThreshold).toBe(false);
  });
  it('is null ratio with no positive profit, null threshold when unconstrained', () => {
    expect(consistencyStatus(0, 0, 0.4).ratio).toBeNull();
    expect(consistencyStatus(0, 0, 0.4).withinThreshold).toBeNull();
    expect(consistencyStatus(30 * M, 100 * M, null).withinThreshold).toBeNull();
  });
});
