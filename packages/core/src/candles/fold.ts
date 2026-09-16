/**
 * Folding fine-granularity bars into coarser timeframes.
 *
 * Folding is a PURE FUNCTION of the underlying bars. Nothing accumulates state
 * across calls, so a revised source bar produces a correctly revised output bar
 * instead of a double-counted one.
 */
import type { InstrumentSpec, NormalizedBar, Timeframe } from '@atlas/contracts';
import { bucketStart } from './timeframe.js';

/** Combine bars that share a bucket. Input must be ascending by time. */
export function foldBucket(bars: readonly NormalizedBar[], bucketTime: number): NormalizedBar | null {
  if (bars.length === 0) return null;
  const first = bars[0]!;
  let high = first.high;
  let low = first.low;
  let volume = 0;
  let closed = true;

  for (const bar of bars) {
    if (bar.high > high) high = bar.high;
    if (bar.low < low) low = bar.low;
    volume += bar.volume;
    // A bucket is only settled once every bar inside it is settled.
    if (!bar.closed) closed = false;
  }

  return {
    symbol: first.symbol,
    time: bucketTime,
    open: first.open,
    high,
    low,
    close: bars[bars.length - 1]!.close,
    volume,
    closed,
  };
}

/**
 * Fold an ascending series of fine bars into `tf` buckets.
 *
 * `markLastOpen` leaves the newest bucket flagged as still forming, which is
 * what the chart needs for the live candle.
 */
export function foldBars(
  spec: InstrumentSpec,
  bars: readonly NormalizedBar[],
  tf: Timeframe,
): NormalizedBar[] {
  if (bars.length === 0) return [];

  const out: NormalizedBar[] = [];
  let currentBucket = bucketStart(spec, bars[0]!.time, tf);
  let group: NormalizedBar[] = [];

  for (const bar of bars) {
    const bucket = bucketStart(spec, bar.time, tf);
    if (bucket !== currentBucket) {
      const folded = foldBucket(group, currentBucket);
      if (folded) out.push(folded);
      group = [];
      currentBucket = bucket;
    }
    group.push(bar);
  }
  const folded = foldBucket(group, currentBucket);
  if (folded) out.push(folded);

  return out;
}

/**
 * Recompute a single bucket from a fine series, for incremental live updates.
 * Returns null when the bucket holds no data.
 */
export function refoldBucket(
  spec: InstrumentSpec,
  fine: readonly NormalizedBar[],
  bucketTime: number,
  bucketEndTime: number,
): NormalizedBar | null {
  const inBucket = fine.filter((b) => b.time >= bucketTime && b.time < bucketEndTime);
  return foldBucket(inBucket, bucketTime);
}
