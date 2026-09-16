/**
 * Bar transforms.
 *
 * A chart type that changes the SHAPE of the series (rather than how it is
 * painted) is expressed as a transform over real bars. Heikin Ashi ships now;
 * Renko, Kagi, Line Break and Point & Figure are the same shape of problem and
 * plug in here rather than requiring changes to the adapter.
 *
 * Transforms never invent prices. They are deterministic functions of the real
 * OHLCV series.
 */
import type { NormalizedBar } from '@atlas/contracts';
import type { ChartType } from './ChartAdapter';

export type BarTransform = (bars: readonly NormalizedBar[]) => NormalizedBar[];

/**
 * Heikin Ashi.
 *   close = (o + h + l + c) / 4
 *   open  = (previous HA open + previous HA close) / 2
 *   high  = max(high, HA open, HA close)
 *   low   = min(low, HA open, HA close)
 */
export function heikinAshi(bars: readonly NormalizedBar[]): NormalizedBar[] {
  const out: NormalizedBar[] = [];
  let previousOpen: number | null = null;
  let previousClose: number | null = null;

  for (const bar of bars) {
    const close = (bar.open + bar.high + bar.low + bar.close) / 4;
    const open: number =
      previousOpen === null || previousClose === null
        ? (bar.open + bar.close) / 2
        : (previousOpen + previousClose) / 2;
    const high = Math.max(bar.high, open, close);
    const low = Math.min(bar.low, open, close);

    out.push({ ...bar, open, high, low, close });
    previousOpen = open;
    previousClose = close;
  }
  return out;
}

const IDENTITY: BarTransform = (bars) => [...bars];

export function transformFor(type: ChartType): BarTransform {
  return type === 'HEIKIN_ASHI' ? heikinAshi : IDENTITY;
}

/** True when the type needs the whole series recomputed on every update. */
export function isStatefulTransform(type: ChartType): boolean {
  // Heikin Ashi's open depends on the previous bar, so a live update must
  // recompute from the tail rather than being applied in isolation.
  return type === 'HEIKIN_ASHI';
}
