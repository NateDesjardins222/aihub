import { describe, expect, it } from 'vitest';
import type { NormalizedBar } from '@atlas/contracts';
import {
  atr,
  bollinger,
  ema,
  macd,
  rsi,
  sma,
  smooth,
  sourceValue,
  stdev,
  trueRange,
  vwap,
} from './math';

/**
 * Indicator maths, checked against numbers worked out by hand.
 *
 * The RSI case is the canonical Wilder worked example, which is the only way to
 * be sure the smoothing is Wilder's and not a plain EMA - they differ by enough
 * to change where an overbought reading lands.
 */

function bar(partial: Partial<NormalizedBar> & { close: number }): NormalizedBar {
  return {
    symbol: 'NQ',
    time: 0,
    open: partial.open ?? partial.close,
    high: partial.high ?? partial.close,
    low: partial.low ?? partial.close,
    close: partial.close,
    volume: partial.volume ?? 0,
    closed: true,
  };
}

describe('sma', () => {
  it('is null until the window is full, then the mean of the window', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('never carries a value forward into a bar that has none', () => {
    expect(sma([10], 5)).toEqual([null]);
  });
});

describe('ema', () => {
  it('seeds from the simple average of the first period', () => {
    // period 3 over 1..5: seed (1+2+3)/3 = 2, k = 0.5
    // bar 3: 4*0.5 + 2*0.5 = 3; bar 4: 5*0.5 + 3*0.5 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('gives nothing at all when there is less history than the period', () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
  });
});

describe('stdev', () => {
  it('is the population standard deviation of the window', () => {
    // window [2,4,4,4,5,5,7,9] has mean 5 and population sd 2
    const out = stdev([2, 4, 4, 4, 5, 5, 7, 9], 8);
    expect(out[7]).toBeCloseTo(2, 10);
  });
});

describe('bollinger', () => {
  it('places the bands a multiple of the deviation either side of the average', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const { middle, upper, lower } = bollinger(values, 8, 2);
    expect(middle[7]).toBeCloseTo(5, 10);
    expect(upper[7]).toBeCloseTo(9, 10);
    expect(lower[7]).toBeCloseTo(1, 10);
    expect(middle[6]).toBeNull();
    expect(upper[6]).toBeNull();
  });
});

describe('rsi', () => {
  /**
   * The standard 20-close teaching series, worked through by hand.
   *
   * Over changes 1..14 the gains total 3.34 and the losses 1.40, so the seed
   * averages are 3.34/14 = 0.2385714 and 1.40/14 = 0.10. That gives
   * RS = 2.3857143 and RSI = 100 - 100/3.3857143 = 70.4641.
   *
   * The next bar closes 0.28 lower, and Wilder's smoothing carries 13/14 of
   * each average forward: gain 0.2215313, loss 0.1128571, RSI 66.2496. A plain
   * 14-period EMA of gains and losses would give 66.05 here, which is why this
   * assertion is to four decimals rather than to the nearest point.
   */
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
    46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
  ];

  it('matches the hand-worked first reading', () => {
    const out = rsi(closes, 14);
    expect(out.slice(0, 14).every((value) => value === null)).toBe(true);
    expect(out[14]!).toBeCloseTo(70.4641, 3);
  });

  it('smooths by Wilder rather than restarting each window', () => {
    const out = rsi(closes, 14);
    expect(out[15]!).toBeCloseTo(66.2496, 3);
    expect(out[16]!).toBeCloseTo(66.4809, 3);
    expect(out[17]!).toBeCloseTo(69.3469, 3);
  });

  it('reads 100 when nothing went down and 0 when nothing went up', () => {
    const up = rsi([1, 2, 3, 4, 5, 6], 3);
    expect(up[3]).toBe(100);
    const down = rsi([6, 5, 4, 3, 2, 1], 3);
    expect(down[3]).toBe(0);
  });
});

describe('macd', () => {
  it('is the difference of two EMAs, with a signal over the defined part only', () => {
    const values = Array.from({ length: 40 }, (_, i) => 100 + i);
    const { macd: line, signal, histogram } = macd(values, 12, 26, 9);

    expect(line.slice(0, 25).every((value) => value === null)).toBe(true);
    const fast = ema(values, 12);
    const slow = ema(values, 26);
    expect(line[30]!).toBeCloseTo(fast[30]! - slow[30]!, 10);

    // The signal cannot exist before the MACD line does.
    expect(signal[25]).toBeNull();
    expect(signal[33]).not.toBeNull();
    expect(histogram[33]!).toBeCloseTo(line[33]! - signal[33]!, 10);
  });
});

describe('true range and atr', () => {
  const bars = [
    bar({ high: 10, low: 8, close: 9 }),
    bar({ high: 12, low: 9, close: 11 }),
    bar({ high: 11, low: 6, close: 7 }),
  ];

  it('takes the widest of the bar range and the two gaps from the previous close', () => {
    // bar 1: range 3, |12-9| = 3, |9-9| = 0 -> 3
    // bar 2: range 5, |11-11| = 0, |6-11| = 5 -> 5
    expect(trueRange(bars)).toEqual([2, 3, 5]);
  });

  it('averages the true range by Wilder', () => {
    const out = atr(bars, 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(2.5, 10);
    // (2.5 * 1 + 5) / 2
    expect(out[2]).toBeCloseTo(3.75, 10);
  });
});

describe('vwap', () => {
  it('weights price by volume and resets at the session boundary', () => {
    const bars = [
      bar({ close: 10, volume: 100 }),
      bar({ close: 20, volume: 300 }),
      bar({ close: 50, volume: 100 }),
    ];
    const out = vwap(bars, 'close', (_, index) => index === 2);
    expect(out[0]).toBeCloseTo(10, 10);
    // (10*100 + 20*300) / 400
    expect(out[1]).toBeCloseTo(17.5, 10);
    // reset: the new session starts again from bar 2 alone
    expect(out[2]).toBeCloseTo(50, 10);
  });

  it('reports nothing when the feed carries no volume, rather than a plain average', () => {
    const bars = [bar({ close: 10, volume: 0 }), bar({ close: 20, volume: 0 })];
    expect(vwap(bars, 'close', () => false)).toEqual([null, null]);
  });
});

describe('sourceValue', () => {
  it('derives each price source from the bar it is given', () => {
    const b = bar({ open: 2, high: 10, low: 4, close: 8 });
    expect(sourceValue(b, 'open')).toBe(2);
    expect(sourceValue(b, 'high')).toBe(10);
    expect(sourceValue(b, 'low')).toBe(4);
    expect(sourceValue(b, 'close')).toBe(8);
    expect(sourceValue(b, 'hl2')).toBe(7);
    expect(sourceValue(b, 'hlc3')).toBeCloseTo((10 + 4 + 8) / 3, 10);
    expect(sourceValue(b, 'ohlc4')).toBe(6);
  });
});

describe('smooth', () => {
  it('returns the series untouched when smoothing is off', () => {
    const line = [null, 1, 2, 3];
    expect(smooth(line, 1)).toEqual(line);
    expect(smooth(line, 0)).toEqual(line);
  });

  it('averages the indicator output over its window', () => {
    // [1,2,3,4] smoothed by 2 -> [null, 1.5, 2.5, 3.5]
    expect(smooth([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });

  it('emits nothing until the whole window is real', () => {
    /*
     * An indicator's output begins with nulls, and averaging across that
     * boundary would produce a number from fewer samples than were asked for.
     * A 3-wide window over [null, null, 4, 6, 8] can first speak at index 4.
     */
    expect(smooth([null, null, 4, 6, 8], 3)).toEqual([null, null, null, null, 6]);
  });

  it('smooths an EMA without inventing a value the EMA had not reached', () => {
    const values = [10, 11, 12, 13, 14, 15, 16, 17];
    const line = ema(values, 3);
    const smoothed = smooth(line, 2);
    for (let i = 0; i < values.length; i += 1) {
      const point = smoothed[i];
      if (point === null || point === undefined) continue;
      const a = line[i - 1];
      const b = line[i];
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      // Every smoothed point is the mean of two points the EMA actually had.
      expect(point).toBeCloseTo(((a as number) + (b as number)) / 2, 10);
    }
    // And it never runs ahead of the line it is smoothing.
    expect(smoothed.filter((v) => v !== null).length).toBeLessThan(
      line.filter((v) => v !== null).length,
    );
  });
});
