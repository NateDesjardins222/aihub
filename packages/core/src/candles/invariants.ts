/**
 * What a series of bars is not allowed to be.
 *
 * These are checked, not assumed. The brief asked for hard invariants after a
 * manual comparison suggested the OHLC pipeline could not be trusted; the audit
 * found the pipeline correct, and the way to keep it correct is to make a
 * violation a reported fact rather than something a later reader has to notice
 * on a chart.
 *
 * Everything here is a pure function of the bars. It is called by the bar
 * service on every page it serves, and by the tests on golden data.
 */
import type { InstrumentSpec, NormalizedBar, Timeframe } from '@atlas/contracts';
import { isValidTickPrice } from '@atlas/instruments';
import { TIMEFRAME_MS, isCalendarTimeframe } from './timeframe.js';

export type ViolationKind =
  /** low <= open <= high, or low <= close <= high, is false. */
  | 'OHLC_INCONSISTENT'
  /** A price is not a whole number of ticks for the instrument. */
  | 'PRICE_OFF_TICK'
  /** Two bars share a bucket time. */
  | 'DUPLICATE_TIME'
  /** A bar's time is not greater than its predecessor's. */
  | 'OUT_OF_ORDER'
  /** A bar's time is not on the timeframe's bucket grid. */
  | 'OFF_GRID'
  /** A bar carries a symbol other than the one requested. */
  | 'WRONG_SYMBOL'
  /** Volume is negative or not finite. */
  | 'BAD_VOLUME'
  /** A price is not finite. */
  | 'NOT_FINITE'
  /** A bar other than the last claims to still be forming. */
  | 'INTERIOR_BAR_OPEN';

export interface Violation {
  readonly kind: ViolationKind;
  readonly time: number;
  readonly detail: string;
}

export interface CheckOptions {
  /**
   * Whether the grid check applies. Calendar timeframes (1D, 1W, 1M) are
   * bucketed by session date rather than by a fixed number of milliseconds, so
   * an epoch grid means nothing for them.
   */
  readonly checkGrid?: boolean;
}

/**
 * Every way this series breaks its contract, in order.
 *
 * Returns an empty array for a series that is sound. Nothing is repaired here:
 * a caller that wants to drop a bad bar decides that itself, so that "we served
 * fewer bars" is never silent.
 */
export function checkBars(
  spec: InstrumentSpec,
  tf: Timeframe,
  bars: readonly NormalizedBar[],
  options: CheckOptions = {},
): Violation[] {
  const out: Violation[] = [];
  const checkGrid = options.checkGrid ?? !isCalendarTimeframe(tf);
  const grid = TIMEFRAME_MS[tf];
  const seen = new Set<number>();
  let previous: number | null = null;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const at = (kind: ViolationKind, detail: string): void => {
      out.push({ kind, time: bar.time, detail });
    };

    if (bar.symbol !== spec.root) {
      at('WRONG_SYMBOL', `${bar.symbol} in a ${spec.root} series`);
    }

    const prices = [bar.open, bar.high, bar.low, bar.close];
    if (!prices.every(Number.isFinite)) {
      at('NOT_FINITE', `o=${bar.open} h=${bar.high} l=${bar.low} c=${bar.close}`);
    } else {
      if (!(bar.low <= bar.open && bar.open <= bar.high)) {
        at('OHLC_INCONSISTENT', `open ${bar.open} outside [${bar.low}, ${bar.high}]`);
      }
      if (!(bar.low <= bar.close && bar.close <= bar.high)) {
        at('OHLC_INCONSISTENT', `close ${bar.close} outside [${bar.low}, ${bar.high}]`);
      }
      for (const [name, price] of [
        ['open', bar.open],
        ['high', bar.high],
        ['low', bar.low],
        ['close', bar.close],
      ] as const) {
        if (!isValidTickPrice(spec, price)) {
          at('PRICE_OFF_TICK', `${name} ${price} is not on ${spec.root}'s tick grid`);
        }
      }
    }

    if (!Number.isFinite(bar.volume) || bar.volume < 0) {
      at('BAD_VOLUME', `volume ${bar.volume}`);
    }

    if (seen.has(bar.time)) at('DUPLICATE_TIME', `${new Date(bar.time).toISOString()} appears twice`);
    seen.add(bar.time);

    if (previous !== null && bar.time <= previous) {
      at('OUT_OF_ORDER', `${bar.time} follows ${previous}`);
    }
    previous = bar.time;

    if (checkGrid && grid > 0 && bar.time % grid !== 0) {
      at('OFF_GRID', `${new Date(bar.time).toISOString()} is not a ${tf} boundary`);
    }

    if (!bar.closed && i !== bars.length - 1) {
      at('INTERIOR_BAR_OPEN', `bar ${i} of ${bars.length - 1} is still forming`);
    }
  }

  return out;
}

/** A one-line summary for a log, or null when there is nothing to say. */
export function describeViolations(violations: readonly Violation[]): string | null {
  if (violations.length === 0) return null;
  const counts = new Map<ViolationKind, number>();
  for (const v of violations) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, n]) => `${kind}=${n}`);
  const first = violations[0]!;
  return `${violations.length} violation(s): ${parts.join(' ')} — first at ${new Date(first.time).toISOString()}: ${first.detail}`;
}
