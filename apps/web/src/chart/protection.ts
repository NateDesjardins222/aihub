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

/**
 * Where a break-even stop goes.
 *
 * At the TRUE average entry the server reports - not at the price the trader
 * clicked, not at the first fill, not at a number the client kept its own copy
 * of. On a position built in three fills at three prices, only one of those is
 * break even.
 *
 * `roundTurnMicros` is the cost of getting in and out again for ONE contract.
 * When it is included, the stop moves far enough past the entry to cover it,
 * rounded UP to a whole tick and away from the entry: a break-even stop that
 * comes out a dollar behind is not break even, and rounding the trader's way
 * would be a lie told in their favour, which is still a lie.
 */
export function breakEvenPrice(
  position: ApiPosition,
  tickSize: number,
  tickValueMicros: number,
  roundTurnMicros: number,
  includeFees: boolean,
): number | null {
  if (position.avgEntryPrice === null || position.qty === 0) return null;
  const entry = position.avgEntryPrice;
  if (!includeFees || roundTurnMicros <= 0 || tickValueMicros <= 0) {
    return snapPrice(entry, tickSize);
  }
  const ticks = Math.ceil(roundTurnMicros / tickValueMicros);
  const direction = position.signedQty > 0 ? 1 : -1;
  return snapPrice(entry + direction * ticks * tickSize, tickSize);
}

/**
 * How many contracts a percentage means.
 *
 * Futures come in whole contracts, so a fraction has to land on an integer,
 * and two rules decide which one: never zero - an order for no contracts is
 * not an order - and never the whole position, because a partial that closes
 * everything is a flatten wearing a disguise. A one-lot therefore has no
 * partial at all, and the controls are disabled rather than quietly rounding
 * to something the trader did not ask for.
 */
export function partialQty(qty: number, fraction: number): number {
  const size = Math.abs(Math.trunc(qty));
  if (size < 2) return 0;
  const wanted = Math.round(size * fraction);
  return Math.max(1, Math.min(size - 1, wanted));
}
