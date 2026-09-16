/**
 * Missing-interval detection.
 *
 * A hole in a bar series has two very different causes, and confusing them is
 * expensive in both directions:
 *
 *   - the market was shut (session break, weekend, holiday) — the hole is
 *     correct and refetching it forever wastes vendor requests;
 *   - we were not listening (outage, restart, a dropped connection) — the hole
 *     is missing data and the chart is lying by omission until it is filled.
 *
 * Only the exchange's session calendar can tell them apart, so that is what
 * decides here rather than a duration threshold.
 */
import type { InstrumentSpec, NormalizedBar } from '@atlas/contracts';
import { isMarketOpen } from '@atlas/instruments';

export interface MarketGap {
  /** Bucket time of the bar before the hole. */
  readonly from: number;
  /** Bucket time of the bar after the hole. */
  readonly to: number;
  readonly durationMs: number;
}

export interface GapScanOptions {
  /** Nominal length of one bar at this timeframe. */
  readonly barMs: number;
  /**
   * A hole must exceed this many bar-lengths to count. One bar-length of slack
   * absorbs an instrument whose bars are simply sparse in quiet hours.
   */
  readonly toleranceBars?: number;
}

/**
 * Holes in an ascending series that span time the market was actually open.
 */
export function findMarketGaps(
  spec: InstrumentSpec,
  bars: readonly NormalizedBar[],
  options: GapScanOptions,
): MarketGap[] {
  const tolerance = (options.toleranceBars ?? 2) * options.barMs;
  const gaps: MarketGap[] = [];

  for (let i = 1; i < bars.length; i += 1) {
    const previous = bars[i - 1]!.time;
    const current = bars[i]!.time;
    const durationMs = current - previous;
    if (durationMs <= tolerance) continue;

    // Sample inside the hole rather than at its edges: the edges sit on bars
    // that exist, and a break's boundary is exactly where open/closed flips.
    if (!spansOpenMarket(spec, previous, current, options.barMs)) continue;
    gaps.push({ from: previous, to: current, durationMs });
  }
  return gaps;
}

/**
 * Was the market open at any point strictly inside the hole?
 *
 * Sampled rather than scanned: a hole can be days long, and a minute-by-minute
 * walk of a weekend would cost thousands of timezone conversions to answer a
 * question three samples settle.
 */
function spansOpenMarket(
  spec: InstrumentSpec,
  from: number,
  to: number,
  barMs: number,
): boolean {
  const span = to - from;
  const samples = Math.min(24, Math.max(3, Math.ceil(span / Math.max(barMs, 60_000))));
  for (let i = 1; i < samples; i += 1) {
    const at = from + (span * i) / samples;
    if (isMarketOpen(spec, at)) return true;
  }
  return false;
}

/**
 * Is the newest bar far enough behind the feed's own clock to suggest we
 * stopped receiving data?
 *
 * `feedNow` must be the feed's view of market time, not the server clock: a
 * delayed feed is permanently behind the wall clock by design, and comparing
 * against it would report every healthy delayed feed as broken.
 */
export function hasTailGap(
  spec: InstrumentSpec,
  bars: readonly NormalizedBar[],
  feedNow: number,
  barMs: number,
  toleranceBars = 2,
): boolean {
  const newest = bars[bars.length - 1]?.time;
  if (newest === undefined) return false;
  if (feedNow - newest <= barMs * toleranceBars) return false;
  return isMarketOpen(spec, feedNow);
}
