/**
 * Protective levels: which way a drag means, and what a level is worth.
 *
 * Pure, and deliberately free of React, stores and the chart library, so the
 * arithmetic that decides whether a dragged level becomes a stop or a target
 * can be tested on its own. Getting it the wrong way round on one side would
 * put a trader's stop where their target belongs.
 */
import type { ApiPosition } from '../trading/api';

export function snapPrice(price: number, tickSize: number): number {
  return Number((Math.round(price / tickSize) * tickSize).toFixed(10));
}

/**
 * What a level is worth if the position closes there.
 *
 * An ESTIMATE, and labelled as one on the chart: the fill will be at whatever
 * the market gives, which for a stop is usually a little worse. Derived from
 * the instrument's tick value, never from a number the client invented.
 */
export function estimatePnlMicros(
  position: ApiPosition,
  level: number,
  tickSize: number,
  tickValueMicros: number,
): number | null {
  if (position.avgEntryPrice === null || position.qty === 0) return null;
  const ticks = (level - position.avgEntryPrice) / tickSize;
  const direction = position.signedQty > 0 ? 1 : -1;
  return Math.round(ticks * direction * position.qty * tickValueMicros);
}

/**
 * Which protective leg a level represents.
 *
 * Measured against the MARKET, not the entry, because that is the rule the
 * engine enforces: a stop for a long has to sit below the price it would exit
 * at, or it is an instant market exit rather than protection - and the server
 * refuses it as `PROTECTION_ON_WRONG_SIDE`.
 *
 * Deciding it against the entry instead made the chart promise something the
 * server would then refuse: on a long that had moved against the trader,
 * dragging just under the ENTRY - still above the market - previewed a stop,
 * and the drop came back rejected with no stop on the chart.
 *
 * The entry is the fallback when there is no mark, which is the only case
 * where the server also lets the level through unchecked.
 */
export function legFor(
  position: ApiPosition,
  level: number,
  marketPrice?: number | null,
): 'STOP' | 'TARGET' | null {
  const reference =
    marketPrice !== undefined && marketPrice !== null ? marketPrice : position.avgEntryPrice;
  if (reference === null) return null;
  if (level === reference) return null;
  const above = level > reference;
  const long = position.signedQty > 0;
  return above === long ? 'TARGET' : 'STOP';
}

/**
 * Where a configured bracket would sit for this position.
 *
 * Exported so the order ticket and the chart agree on what "40 ticks" means
 * without either of them owning the other.
 */
export function bracketLevels(
  position: ApiPosition,
  stopTicks: number,
  targetTicks: number,
  tickSize: number,
): { stopPrice: number | null; targetPrice: number | null } {
  if (position.avgEntryPrice === null) return { stopPrice: null, targetPrice: null };
  const long = position.signedQty > 0;
  return {
    stopPrice:
      stopTicks > 0
        ? snapPrice(position.avgEntryPrice + (long ? -1 : 1) * stopTicks * tickSize, tickSize)
        : null,
    targetPrice:
      targetTicks > 0
        ? snapPrice(position.avgEntryPrice + (long ? 1 : -1) * targetTicks * tickSize, tickSize)
        : null,
  };
}
