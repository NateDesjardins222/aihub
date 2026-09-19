import { describe, expect, it } from 'vitest';
import type { ApiPosition } from '../trading/api';
import { bracketLevels, breakEvenPrice, estimatePnlMicros, legFor, partialQty } from './protection';

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

  it('measures against the MARKET when it is given one', () => {
    /*
     * A long that has moved against the trader: entry 20,000, market 19,980.
     *
     * A level at 19,990 is below the entry - which used to make it a "stop" -
     * but it is ABOVE the market, so as a stop it would exit immediately and
     * the engine refuses it. Against the market it is what it actually is: a
     * target, ten points above where the position would exit now.
     */
    const long = position(1);
    expect(legFor(long, 19_990, 19_980)).toBe('TARGET');
    expect(legFor(long, 19_970, 19_980)).toBe('STOP');

    // And the mirror, on a short that has moved against the trader.
    const short = position(-1);
    expect(legFor(short, 20_010, 20_020)).toBe('TARGET');
    expect(legFor(short, 20_030, 20_020)).toBe('STOP');
  });

  it('falls back to the entry when there is no mark, as the engine does', () => {
    const long = position(1);
    expect(legFor(long, 20_010, null)).toBe('TARGET');
    expect(legFor(long, 19_990, null)).toBe('STOP');
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

describe('breakEvenPrice', () => {
  const long = (avg: number, qty = 2): ApiPosition =>
    ({
      symbol: 'NQ',
      side: 'LONG',
      qty,
      signedQty: qty,
      avgEntryPrice: avg,
      markPrice: avg,
      unrealizedPnlMicros: 0,
      realizedPnlMicros: 0,
      feesMicros: 0,
      openedAt: 0,
      stopOrderId: null,
      targetOrderId: null,
    }) as ApiPosition;

  const short = (avg: number, qty = 2): ApiPosition =>
    ({ ...long(avg, qty), side: 'SHORT', signedQty: -qty }) as ApiPosition;

  it('sits on the true average entry when fees are excluded', () => {
    // A position built at 100.00 and 100.50 averages 100.25, and THAT is
    // break even - not either of the prices the trader watched fill.
    expect(breakEvenPrice(long(100.25), 0.25, 5_000_000, 4_000_000, false)).toBe(100.25);
  });

  it('moves far enough past the entry to cover the round turn', () => {
    // $4 of round turn against a $5 tick is one tick, rounded up.
    expect(breakEvenPrice(long(100), 0.25, 5_000_000, 4_000_000, true)).toBe(100.25);
  });

  it('rounds up rather than leaving the trader a dollar short', () => {
    // $6 against a $5 tick is 1.2 ticks: two, not one.
    expect(breakEvenPrice(long(100), 0.25, 5_000_000, 6_000_000, true)).toBe(100.5);
  });

  it('goes the other way for a short', () => {
    expect(breakEvenPrice(short(100), 0.25, 5_000_000, 6_000_000, true)).toBe(99.5);
  });

  it('has nothing to say about a flat position', () => {
    expect(breakEvenPrice({ ...long(100, 0), qty: 0 } as ApiPosition, 0.25, 5_000_000, 0, false)).toBeNull();
  });
});

describe('partialQty', () => {
  it('takes a quarter of eight', () => {
    expect(partialQty(8, 0.25)).toBe(2);
  });

  it('never returns zero contracts', () => {
    expect(partialQty(3, 0.25)).toBe(1);
  });

  it('never closes the whole position', () => {
    // 75% of 2 rounds to 2, which would be a flatten in disguise.
    expect(partialQty(2, 0.75)).toBe(1);
    expect(partialQty(4, 1)).toBe(3);
  });

  it('has no partial to offer on a one-lot', () => {
    expect(partialQty(1, 0.5)).toBe(0);
  });

  it('reads a short position by its size', () => {
    expect(partialQty(-8, 0.5)).toBe(4);
  });
});
