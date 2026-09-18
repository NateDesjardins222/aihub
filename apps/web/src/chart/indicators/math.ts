/**
 * Indicator mathematics.
 *
 * Pure functions over genuine bars. No chart library, no React, no I/O, so they
 * can be unit-tested against hand-checked numbers - which they are, in
 * math.test.ts, because an indicator that is subtly wrong is worse than one
 * that is missing: a trader acts on it.
 *
 * Two rules hold throughout:
 *
 *   A value that cannot be computed yet is `null`, never zero and never carried
 *   forward. A 20-period average has no value on bar 3; drawing one would put a
 *   line on the chart that the data does not support.
 *
 *   Nothing is extrapolated past the last genuine bar.
 */
import type { NormalizedBar } from '@atlas/contracts';

export type Source = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';

export function sourceValue(bar: NormalizedBar, source: Source): number {
  switch (source) {
    case 'open':
      return bar.open;
    case 'high':
      return bar.high;
    case 'low':
      return bar.low;
    case 'hl2':
      return (bar.high + bar.low) / 2;
    case 'hlc3':
      return (bar.high + bar.low + bar.close) / 3;
    case 'ohlc4':
      return (bar.open + bar.high + bar.low + bar.close) / 4;
    default:
      return bar.close;
  }
}

/** Simple moving average. `null` until `period` values exist. */
export function sma(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values.
 *
 * Seeding matters: starting from the first value alone makes the early part of
 * the line depend on where the history window happens to begin, so scrolling
 * back would change the numbers on bars the trader already looked at.
 */
export function ema(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * A moving average OF AN INDICATOR'S OUTPUT.
 *
 * Smoothing is a second average applied to a line that has already been
 * computed, so unlike `sma` its input has a null head: a 21-period EMA has
 * nothing to say about its first twenty bars. Averaging across that boundary
 * would produce a number from fewer samples than were asked for, which is a
 * value the data does not support - so the whole window must be real before
 * anything is emitted.
 *
 * A length of 1 or less returns the series untouched, because the setting has
 * to be able to be off.
 */
export function smooth(
  values: ReadonlyArray<number | null>,
  period: number,
): Array<number | null> {
  if (period <= 1) return values.slice();
  const out: Array<number | null> = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    let complete = true;
    for (let j = i - period + 1; j <= i; j += 1) {
      const value = values[j];
      if (value === null || value === undefined) {
        complete = false;
        break;
      }
      sum += value;
    }
    if (complete) out[i] = sum / period;
  }
  return out;
}

/** Population standard deviation over a rolling window. */
export function stdev(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 1) return out;
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += values[j]!;
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const d = values[j]! - mean;
      variance += d * d;
    }
    out[i] = Math.sqrt(variance / period);
  }
  return out;
}

export interface BollingerResult {
  readonly middle: Array<number | null>;
  readonly upper: Array<number | null>;
  readonly lower: Array<number | null>;
}

export function bollinger(
  values: readonly number[],
  period: number,
  multiplier: number,
): BollingerResult {
  const middle = sma(values, period);
  const deviation = stdev(values, period);
  const upper = middle.map((m, i) => (m === null || deviation[i] == null ? null : m + multiplier * deviation[i]!));
  const lower = middle.map((m, i) => (m === null || deviation[i] == null ? null : m - multiplier * deviation[i]!));
  return { middle, upper, lower };
}

/**
 * Wilder's relative strength index.
 *
 * The first value lands on bar `period`, seeded from the average gain and loss
 * over the first `period` changes, and is smoothed by Wilder's method from
 * there. An all-up window gives 100 and an all-down window gives 0 - both are
 * genuine, not a divide-by-zero guard.
 */
export function rsi(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0 || values.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i]! - values[i - 1]!;
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  readonly macd: Array<number | null>;
  readonly signal: Array<number | null>;
  readonly histogram: Array<number | null>;
}

export function macd(
  values: readonly number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): MacdResult {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const line = values.map((_, i) =>
    fast[i] === null || slow[i] === null ? null : fast[i]! - slow[i]!,
  );

  // The signal line is an EMA of the MACD line, which does not exist for the
  // first slowPeriod-1 bars. It is computed over the defined part only, so the
  // leading nulls do not drag the average towards zero.
  const firstDefined = line.findIndex((value) => value !== null);
  const signal: Array<number | null> = new Array(values.length).fill(null);
  if (firstDefined >= 0) {
    const defined = line.slice(firstDefined).map((value) => value ?? 0);
    const smoothed = ema(defined, signalPeriod);
    for (let i = 0; i < smoothed.length; i += 1) signal[firstDefined + i] = smoothed[i]!;
  }

  const histogram = line.map((value, i) =>
    value === null || signal[i] === null ? null : value - signal[i]!,
  );
  return { macd: line, signal, histogram };
}

/** True range: the greatest of the bar's own range and its gaps from the close before it. */
export function trueRange(bars: readonly NormalizedBar[]): Array<number | null> {
  return bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = bars[i - 1]!.close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
  });
}

/** Wilder's average true range. */
export function atr(bars: readonly NormalizedBar[], period: number): Array<number | null> {
  const tr = trueRange(bars).map((value) => value ?? 0);
  const out: Array<number | null> = new Array(bars.length).fill(null);
  if (period <= 0 || bars.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += tr[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Session-anchored volume-weighted average price.
 *
 * Reset at each session boundary, which is supplied rather than guessed: VWAP
 * anchored to the wrong moment is not a slightly different line, it is a
 * different statistic. A bar with no volume contributes nothing, so a feed that
 * reports zero volume yields no VWAP at all rather than a plain average
 * pretending to be one.
 */
export function vwap(
  bars: readonly NormalizedBar[],
  source: Source,
  isSessionStart: (bar: NormalizedBar, index: number) => boolean,
): Array<number | null> {
  const out: Array<number | null> = new Array(bars.length).fill(null);
  let pv = 0;
  let volume = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    if (isSessionStart(bar, i)) {
      pv = 0;
      volume = 0;
    }
    pv += sourceValue(bar, source) * bar.volume;
    volume += bar.volume;
    out[i] = volume > 0 ? pv / volume : null;
  }
  return out;
}
