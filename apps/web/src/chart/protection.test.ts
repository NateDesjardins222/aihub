import { describe, expect, it } from 'vitest';
import type { ApiPosition } from '../trading/api';
import { bracketLevels, estimatePnlMicros, legFor } from './protection';

/**
 * Which way a drag means.
 *
 * Dragging off the position marker decides between a stop and a target from
 * the DIRECTION alone, so getting it the wrong way round on one side would put
 * a trader's stop where their target belongs. All four cases are pinned here.
 *
 * NQ: tick 0.25, $5 a tick.
 */
const TICK = 0.25;
const TICK_VALUE = 5_000_000;

function position(signedQty: number, entry = 20_000): ApiPosition {
  return {
    symbol: 'NQ',
    side: signedQty > 0 ? 'LONG' : 'SHORT',
    qty: Math.abs(signedQty),
    signedQty,
    avgEntryPrice: entry,
    markPrice: entry,
    unrealizedPnlMicros: 0,
    realizedPnlMicros: 0,
    feesMicros: 0,
    openedAt: 0,
    stopOrderId: null,
    targetOrderId: null,
  };
}

describe('legFor', () => {
  it('on a long, above the entry is a target and below it is a stop', () => {
    const long = position(2);
    expect(legFor(long, 20_010)).toBe('TARGET');
    expect(legFor(long, 19_990)).toBe('STOP');
  });

  it('on a short, below the entry is a target and above it is a stop', () => {
    const short = position(-2);
    expect(legFor(short, 19_990)).toBe('TARGET');
    expect(legFor(short, 20_010)).toBe('STOP');
  });

  it('is undecided exactly at the entry', () => {
    expect(legFor(position(1), 20_000)).toBeNull();
  });

  it('has nothing to say about a position with no average price', () => {
    expect(legFor({ ...position(1), avgEntryPrice: null }, 20_010)).toBeNull();
  });
});

describe('estimatePnlMicros', () => {
  it('is positive above a long and negative below it', () => {
    const long = position(2);
    // 10 points = 40 ticks, $5 a tick, 2 contracts
    expect(estimatePnlMicros(long, 20_010, TICK, TICK_VALUE)).toBe(400_000_000);
    expect(estimatePnlMicros(long, 19_990, TICK, TICK_VALUE)).toBe(-400_000_000);
  });

  it('is positive below a short and negative above it', () => {
    const short = position(-3);
    expect(estimatePnlMicros(short, 19_990, TICK, TICK_VALUE)).toBe(600_000_000);
    expect(estimatePnlMicros(short, 20_010, TICK, TICK_VALUE)).toBe(-600_000_000);
  });

  it('scales with size', () => {
    const one = estimatePnlMicros(position(1), 20_010, TICK, TICK_VALUE)!;
    const five = estimatePnlMicros(position(5), 20_010, TICK, TICK_VALUE)!;
    expect(five).toBe(one * 5);
  });

  it('gives nothing for a flat position', () => {
    expect(estimatePnlMicros(position(0), 20_010, TICK, TICK_VALUE)).toBeNull();
  });
});

describe('bracketLevels', () => {
  it('puts the stop against a long and the target with it', () => {
    const levels = bracketLevels(position(1), 40, 80, TICK);
    expect(levels.stopPrice).toBeCloseTo(19_990, 10);
    expect(levels.targetPrice).toBeCloseTo(20_020, 10);
  });

  it('reverses both for a short', () => {
    const levels = bracketLevels(position(-1), 40, 80, TICK);
    expect(levels.stopPrice).toBeCloseTo(20_010, 10);
    expect(levels.targetPrice).toBeCloseTo(19_980, 10);
  });

  it('omits a leg whose distance is zero', () => {
    const levels = bracketLevels(position(1), 0, 80, TICK);
    expect(levels.stopPrice).toBeNull();
    expect(levels.targetPrice).not.toBeNull();
  });

  it('lands every level on the tick grid', () => {
    const levels = bracketLevels(position(1, 20_000.13), 37, 71, TICK);
    for (const level of [levels.stopPrice!, levels.targetPrice!]) {
      expect(Math.abs(level / TICK - Math.round(level / TICK))).toBeLessThan(1e-9);
    }
  });
});
