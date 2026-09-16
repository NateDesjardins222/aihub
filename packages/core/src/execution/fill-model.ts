/**
 * Fill models.
 *
 * This is where a simulator earns or loses its credibility. Two rules govern
 * everything below:
 *
 *   1. A fill may only occur at a price the market actually reached. Nothing is
 *      interpolated, and no price is invented to make an order fill.
 *   2. Where the data leaves the outcome ambiguous, resolve it AGAINST the
 *      trader. A stop that may or may not have been hit is treated as hit; a
 *      limit that may or may not have filled is treated as unfilled.
 *
 * The second rule is why these functions look pessimistic. They are meant to.
 */
import type { InstrumentSpec } from '@atlas/contracts';
import type { SimulationEnvironment } from './environment.js';
import type { EngineOrder, FillDecision, MarketSnapshot } from './types.js';
import { remainingQty } from './types.js';

/** The price a buyer must pay right now, or null when the market is unknown. */
export function marketableBuyTicks(market: MarketSnapshot): number | null {
  return market.askTicks ?? market.lastTicks;
}

/** The price a seller receives right now. */
export function marketableSellTicks(market: MarketSnapshot): number | null {
  return market.bidTicks ?? market.lastTicks;
}

function marketablePrice(order: EngineOrder, market: MarketSnapshot): number | null {
  return order.side === 'BUY' ? marketableBuyTicks(market) : marketableSellTicks(market);
}

/** Slippage always moves the price against the order's side. */
function applySlippage(order: EngineOrder, priceTicks: number, slippageTicks: number): number {
  return order.side === 'BUY' ? priceTicks + slippageTicks : priceTicks - slippageTicks;
}

function cap(env: SimulationEnvironment, order: EngineOrder): number {
  const remaining = remainingQty(order);
  if (env.maxContractsPerFill === null) return remaining;
  return Math.min(remaining, env.maxContractsPerFill);
}

/** Highest price the market is known to have reached in this observation. */
function highWater(market: MarketSnapshot, useBarRange: boolean): number | null {
  const bar = useBarRange ? market.bar : null;
  const candidates = [market.lastTicks, market.askTicks, bar?.highTicks].filter(
    (v): v is number => v !== null && v !== undefined,
  );
  return candidates.length ? Math.max(...candidates) : null;
}

/** Lowest price the market is known to have reached in this observation. */
function lowWater(market: MarketSnapshot, useBarRange: boolean): number | null {
  const bar = useBarRange ? market.bar : null;
  const candidates = [market.lastTicks, market.bidTicks, bar?.lowTicks].filter(
    (v): v is number => v !== null && v !== undefined,
  );
  return candidates.length ? Math.min(...candidates) : null;
}

// ---------------------------------------------------------------------------
// Market orders
// ---------------------------------------------------------------------------

export function evaluateMarket(
  _spec: InstrumentSpec,
  env: SimulationEnvironment,
  order: EngineOrder,
  market: MarketSnapshot,
): FillDecision | null {
  const base = marketablePrice(order, market);
  // No price means no fill. A market order does NOT get invented a price.
  if (base === null) return null;

  const slippage = env.fillModel === 'SIMPLE' ? 0 : env.marketSlippageTicks;
  return {
    qty: cap(env, order),
    priceTicks: applySlippage(order, base, slippage),
    slippageTicks: slippage,
    liquidity: 'TAKER',
    reason: 'market',
    marketable: true,
  };
}

// ---------------------------------------------------------------------------
// Limit orders
// ---------------------------------------------------------------------------

export function evaluateLimit(
  _spec: InstrumentSpec,
  env: SimulationEnvironment,
  order: EngineOrder,
  market: MarketSnapshot,
  limitTicks: number,
  /**
   * True only on the order's first evaluation.
   *
   * This distinction matters and is easy to get wrong. A limit that is
   * marketable the moment it arrives fills at the market's price. A limit that
   * has been RESTING fills at its own price when the market comes to it — it
   * does not get handed the market's price later. Without this flag, a buy
   * limit resting at 100 would fill at 95 once the market fell to 95, which is
   * free money the market never offered.
   */
  arrival: boolean,
  /**
   * The earliest price this limit may claim, when it only became live partway
   * through the observation.
   *
   * A stop-limit elected mid-bar must not be filled at that bar's OPEN: the
   * open happened before the election, when the order was still a stop. Without
   * this bound a sell stop-limit elected at 19,990 would fill at an open of
   * 19,995 — a price the market offered only while the order was dormant.
   *
   * The bound applies ONLY to the observation in which election happened. From
   * the next one the order is an ordinary resting limit.
   */
  boundTicks: number | null = null,
): FillDecision | null {
  const marketable = marketablePrice(order, market);

  /** Is `price` better for this order's side than the bound allows? */
  const beyondBound = (price: number): boolean => {
    if (boundTicks === null) return false;
    return order.side === 'BUY' ? price < boundTicks : price > boundTicks;
  };

  // Marketable on arrival: a buy limit placed above the offer is a market order
  // with a price cap, and it fills at the market's price, not at the limit.
  if (arrival && marketable !== null && !beyondBound(marketable)) {
    const crosses = order.side === 'BUY' ? marketable <= limitTicks : marketable >= limitTicks;
    if (crosses) {
      return {
        qty: cap(env, order),
        priceTicks: marketable,
        slippageTicks: 0,
        liquidity: 'TAKER',
        reason: 'limit marketable on arrival',
        marketable: true,
      };
    }
  }

  // A gap straight through a resting limit fills at the open, which is better
  // than the limit asked for. That is not simulator generosity: an exchange
  // fills a resting order at the first price it can, and on a gap that price is
  // the open.
  if (env.useBarRange && market.bar) {
    const openTicks = market.bar.openTicks;
    const gapped = order.side === 'BUY' ? openTicks < limitTicks : openTicks > limitTicks;
    if (gapped && !beyondBound(openTicks)) {
      return {
        qty: cap(env, order),
        priceTicks: openTicks,
        slippageTicks: 0,
        liquidity: 'TAKER',
        reason: 'limit gapped through',
        marketable: true,
      };
    }
  }

  // Resting: fill only if the market came to us. Using the bar's extreme is the
  // only way a delayed feed can see a price its quote sampling missed.
  const reach = order.side === 'BUY' ? lowWater(market, env.useBarRange) : highWater(market, env.useBarRange);
  if (reach === null) return null;

  const touched = order.side === 'BUY' ? reach <= limitTicks : reach >= limitTicks;
  if (!touched) return null;

  // A touch does not guarantee a fill: at the touched price there may have been
  // a queue ahead of us that absorbed everything. Requiring a trade THROUGH the
  // price is the conservative reading.
  if (env.requireThroughTradeForLimit) {
    const through = order.side === 'BUY' ? reach < limitTicks : reach > limitTicks;
    if (!through) return null;
  }

  if (beyondBound(limitTicks)) return null;

  return {
    qty: cap(env, order),
    // A resting limit gets its own price; the market coming to it is what fills
    // it, and it is never filled better than it asked.
    priceTicks: limitTicks,
    slippageTicks: 0,
    liquidity: 'MAKER',
    reason: env.requireThroughTradeForLimit ? 'limit traded through' : 'limit touched',
    marketable: false,
  };
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

export interface StopTrigger {
  readonly triggered: boolean;
  /** The price at which the trigger is deemed to have occurred. */
  readonly triggerTicks: number | null;
}

/**
 * Has a stop been elected?
 *
 * A buy stop elects when the market trades at or above it; a sell stop at or
 * below. The trigger price matters as much as the fact: a stop that gaps must
 * be filled at the gap, not at the stop price.
 */
export function evaluateStopTrigger(
  env: SimulationEnvironment,
  order: EngineOrder,
  market: MarketSnapshot,
  stopTicks: number,
): StopTrigger {
  const usingBar = env.useBarRange && market.bar !== null;
  const observed = order.side === 'BUY' ? marketableBuyTicks(market) : marketableSellTicks(market);

  /**
   * The election price.
   *
   * Everything turns on whether the data proves the market moved CONTINUOUSLY
   * through the stop:
   *
   *   - With a bar, it does. The bar's open says where the move started, so a
   *     bar that opened on the safe side traded through the stop and elects AT
   *     the stop, while a bar that opened beyond it gapped and elects at the
   *     open.
   *
   *   - With only quotes, it does not. Samples arrive seconds apart and the
   *     path between them is unknown; the market may have gapped straight to
   *     the sampled price. The unknown is therefore resolved against the
   *     trader: election happens at whichever is WORSE, the stop or the price
   *     actually observed. Electing at the stop price on unproven continuity
   *     would hand back ticks the market never offered.
   */
  const elect = (reference: number): number => {
    if (usingBar) {
      const openTicks = market.bar!.openTicks;
      const gapped = order.side === 'BUY' ? openTicks > reference : openTicks < reference;
      return gapped ? openTicks : reference;
    }
    if (observed === null) return reference;
    return order.side === 'BUY' ? Math.max(reference, observed) : Math.min(reference, observed);
  };

  if (order.side === 'BUY') {
    const reach = highWater(market, env.useBarRange);
    if (reach === null || reach < stopTicks) return { triggered: false, triggerTicks: null };
    return { triggered: true, triggerTicks: elect(stopTicks) };
  }

  const reach = lowWater(market, env.useBarRange);
  if (reach === null || reach > stopTicks) return { triggered: false, triggerTicks: null };
  return { triggered: true, triggerTicks: elect(stopTicks) };
}

/**
 * A triggered stop-market becomes a market order and pays for the privilege.
 *
 * It fills at the ELECTION price plus slippage, and nothing else. Two wrong
 * alternatives are worth naming:
 *
 *   - filling at the bar's close would assume the stop sat unelected until the
 *     end of the bar, which can be tens of ticks away from where it triggered;
 *   - filling at the bar's extreme would assume the worst tick of the minute.
 *
 * The election price already carries the only distinction the data supports:
 * a bar that OPENED beyond the stop gapped through it and fills at the open,
 * while a bar that traded through it fills at the stop.
 */
export function evaluateTriggeredStopMarket(
  env: SimulationEnvironment,
  order: EngineOrder,
  _market: MarketSnapshot,
  triggerTicks: number,
): FillDecision {
  const slippage = env.fillModel === 'SIMPLE' ? 0 : env.stopSlippageTicks;
  return {
    qty: cap(env, order),
    priceTicks: applySlippage(order, triggerTicks, slippage),
    slippageTicks: slippage,
    liquidity: 'TAKER',
    reason: 'stop elected',
    marketable: true,
  };
}

// ---------------------------------------------------------------------------
// Trailing stops
// ---------------------------------------------------------------------------

/**
 * Advance a trailing stop's anchor.
 *
 * The anchor is the best price seen since activation: the high for a sell
 * trail, the low for a buy trail. It only ever moves in the trader's favour,
 * which is what makes the stop trail rather than wander.
 */
export function advanceTrailAnchor(
  order: EngineOrder,
  market: MarketSnapshot,
  useBarRange: boolean,
): number | null {
  // A SELL trailing stop protects a long, so it follows the high.
  const observed =
    order.side === 'SELL' ? highWater(market, useBarRange) : lowWater(market, useBarRange);
  if (observed === null) return order.trailAnchorTicks;
  if (order.trailAnchorTicks === null) return observed;
  return order.side === 'SELL'
    ? Math.max(order.trailAnchorTicks, observed)
    : Math.min(order.trailAnchorTicks, observed);
}

/** Where a trailing stop currently sits, given its anchor. */
export function trailingStopTicks(order: EngineOrder, anchorTicks: number): number {
  const distance = order.trailTicks ?? 0;
  return order.side === 'SELL' ? anchorTicks - distance : anchorTicks + distance;
}
