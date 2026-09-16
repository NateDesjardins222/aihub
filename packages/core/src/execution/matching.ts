/**
 * The matching engine.
 *
 * Pure: it takes orders, a position and a market observation, and returns the
 * events that should happen. It performs no I/O and holds no state, so the
 * server can run it inside a database transaction and the tests can run
 * thousands of scenarios in milliseconds.
 *
 * Ordering inside a single market observation is deliberate and documented at
 * `sortForEvaluation`: when a bar's range spans several of an account's orders,
 * the sequence is unknowable, so the engine resolves it against the trader.
 */
import type { InstrumentSpec } from '@atlas/contracts';
import { perSideFeesMicros } from '@atlas/instruments';
import type { SimulationEnvironment } from './environment.js';
import type { EngineOrder, FillDecision, MarketSnapshot } from './types.js';
import { isOpen, remainingQty, signedQty } from './types.js';
import {
  advanceTrailAnchor,
  evaluateLimit,
  evaluateMarket,
  evaluateStopTrigger,
  evaluateTriggeredStopMarket,
  trailingStopTicks,
} from './fill-model.js';
import { applyFill, type PositionState } from '../position/position.js';

export interface FillEvent {
  readonly orderId: string;
  readonly qty: number;
  readonly priceTicks: number;
  readonly feesMicros: number;
  readonly slippageTicks: number;
  readonly liquidity: 'MAKER' | 'TAKER';
  readonly reason: string;
  readonly exchangeTs: number;
}

export interface MatchResult {
  readonly orders: readonly EngineOrder[];
  readonly position: PositionState;
  readonly fills: readonly FillEvent[];
  /** Orders canceled by an OCO sibling filling. */
  readonly canceledByOco: readonly string[];
  readonly closedLots: readonly import('../position/position.js').ClosedLot[];
  readonly realizedPnlMicros: number;
  readonly feesMicros: number;
}

export interface MatchContext {
  readonly spec: InstrumentSpec;
  readonly env: SimulationEnvironment;
  readonly market: MarketSnapshot;
  /** Wall clock, used only for latency eligibility. Never for pricing. */
  readonly now: number;
}

function feesFor(ctx: MatchContext, qty: number): number {
  if (!ctx.env.feesEnabled) return 0;
  const override = ctx.env.commissionPerSideMicrosOverride;
  if (override === null) return perSideFeesMicros(ctx.spec, qty);
  return qty * (override + ctx.spec.exchangeFeesPerSideMicros);
}

/**
 * Evaluation order within one market observation.
 *
 * A one-minute bar reports a high and a low but not their sequence. When a
 * position's protective stop and its target both sit inside that range, either
 * could have filled first, and the difference is the whole trade's outcome.
 *
 * Under ADVERSE_FIRST the engine sorts stops ahead of targets, so the losing
 * side is taken. This is the only defensible default: a simulator that picks
 * the profitable branch on ambiguous data reports an edge that does not exist.
 */
function sortForEvaluation(orders: readonly EngineOrder[], env: SimulationEnvironment): EngineOrder[] {
  const rank = (o: EngineOrder): number => {
    if (env.intrabarPolicy !== 'ADVERSE_FIRST') return 1;
    if (o.bracketRole === 'STOP_LOSS') return 0;
    if (o.type === 'STOP_MARKET' || o.type === 'STOP_LIMIT' || o.type === 'TRAILING_STOP') return 0;
    return 2;
  };
  return [...orders].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
}

/**
 * The observation as THIS order is entitled to see it.
 *
 * A bar's extremes are the only prices a delayed feed can prove traded, but
 * they may only fill an order that was working for the whole bar. An order that
 * arrived mid-bar, or after it closed, sees the bar stripped out and is left
 * with the quote - which is both honest and, for stops, the more pessimistic of
 * the two paths.
 */
export function observationFor(market: MarketSnapshot, order: EngineOrder): MarketSnapshot {
  if (market.bar === null) return market;
  if (order.restedMarketTs === null) return { ...market, bar: null };
  if (order.restedMarketTs > market.bar.startTs) return { ...market, bar: null };
  return market;
}

/** Decide whether a single order fills against this observation. */
function decide(ctx: MatchContext, order: EngineOrder): { decision: FillDecision | null; order: EngineOrder } {
  const { spec, env } = ctx;
  const market = observationFor(ctx.market, order);
  let working = order;

  // Latency: an order is not eligible until its acceptance has "reached" the
  // exchange. Without this, a market order fills on data that predates it.
  if (ctx.now < order.eligibleAt) return { decision: null, order: working };

  switch (order.type) {
    case 'MARKET':
      return { decision: evaluateMarket(spec, env, working, market), order: working };

    case 'LIMIT': {
      if (working.limitTicks === null) return { decision: null, order: working };
      const decision = evaluateLimit(spec, env, working, market, working.limitTicks, !working.hasRested);
      return { decision, order: working };
    }

    case 'STOP_MARKET': {
      if (working.stopTicks === null) return { decision: null, order: working };
      const trigger = evaluateStopTrigger(env, working, market, working.stopTicks);
      if (!trigger.triggered || trigger.triggerTicks === null) return { decision: null, order: working };
      working = { ...working, stopTriggered: true };
      return {
        decision: evaluateTriggeredStopMarket(env, working, market, trigger.triggerTicks),
        order: working,
      };
    }

    case 'STOP_LIMIT': {
      // The election price bounds what the limit may claim inside this same
      // observation — see the `boundTicks` note on evaluateLimit.
      let electionTicks: number | null = null;
      if (!working.stopTriggered) {
        if (working.stopTicks === null) return { decision: null, order: working };
        const trigger = evaluateStopTrigger(env, working, market, working.stopTicks);
        if (!trigger.triggered) return { decision: null, order: working };
        // Triggering and filling are separate events. The order becomes a limit
        // now and may rest there indefinitely — including forever, if price
        // never comes back. That is what a stop-limit is for.
        // `hasRested` is reset because the order becomes a LIMIT that has not
        // rested at its limit yet. `restedMarketTs` is NOT: the order was
        // working through this bar as a stop, so the bar's range is still its
        // to use - bounded by the election price, see evaluateLimit.
        working = { ...working, stopTriggered: true, hasRested: false };
        electionTicks = trigger.triggerTicks;
      }
      if (working.limitTicks === null) return { decision: null, order: working };
      const decision = evaluateLimit(
        spec,
        env,
        working,
        market,
        working.limitTicks,
        !working.hasRested,
        electionTicks,
      );
      return { decision, order: working };
    }

    case 'TRAILING_STOP': {
      const anchor = advanceTrailAnchor(working, market, env.useBarRange);
      working = { ...working, trailAnchorTicks: anchor };
      if (anchor === null || working.trailTicks === null) return { decision: null, order: working };

      const stopTicks = trailingStopTicks(working, anchor);
      const trigger = evaluateStopTrigger(env, working, market, stopTicks);
      if (!trigger.triggered || trigger.triggerTicks === null) {
        return { decision: null, order: { ...working, stopTicks } };
      }
      working = { ...working, stopTicks, stopTriggered: true };
      return {
        decision: evaluateTriggeredStopMarket(env, working, market, trigger.triggerTicks),
        order: working,
      };
    }

    default:
      return { decision: null, order: working };
  }
}

/**
 * Run every open order for one symbol against one market observation.
 *
 * Returns the complete set of changes. The caller persists them atomically, so
 * an OCO sibling can never be left working after its partner filled.
 */
export function matchOrders(
  ctx: MatchContext,
  openOrders: readonly EngineOrder[],
  position: PositionState,
): MatchResult {
  const byId = new Map(openOrders.map((o) => [o.id, o]));
  const fills: FillEvent[] = [];
  const canceledByOco = new Set<string>();
  const closedLots: Array<import('../position/position.js').ClosedLot> = [];

  let currentPosition = position;
  let realized = 0;
  let feesTotal = 0;

  for (const candidate of sortForEvaluation(openOrders, ctx.env)) {
    const order = byId.get(candidate.id)!;
    if (!isOpen(order) || canceledByOco.has(order.id)) continue;
    if (remainingQty(order) <= 0) continue;

    const { decision, order: advanced } = decide(ctx, order);

    if (!decision) {
      // Mark it as having rested so a limit cannot later claim arrival pricing.
      byId.set(order.id, {
        ...advanced,
        hasRested: true,
        restedMarketTs: advanced.restedMarketTs ?? ctx.market.exchangeTs,
        updatedAt: ctx.market.exchangeTs,
      });
      continue;
    }

    const qty = Math.min(decision.qty, remainingQty(advanced));
    if (qty <= 0) {
      byId.set(order.id, {
        ...advanced,
        hasRested: true,
        restedMarketTs: advanced.restedMarketTs ?? ctx.market.exchangeTs,
      });
      continue;
    }

    const fees = feesFor(ctx, qty);
    const filledQty = advanced.filledQty + qty;
    const notional = advanced.fillNotionalMicros + decision.priceTicks * qty * ctx.spec.tickValueMicros;
    const complete = filledQty >= advanced.qty;

    const filled: EngineOrder = {
      ...advanced,
      filledQty,
      fillNotionalMicros: notional,
      status: complete ? 'FILLED' : 'PARTIALLY_FILLED',
      // An order that executed against a market beyond its price has not
      // "rested" — see FillDecision.marketable. Marking it rested would fill
      // the remainder at its own limit, which may be a price never traded.
      hasRested: !decision.marketable,
      restedMarketTs: decision.marketable
        ? advanced.restedMarketTs
        : (advanced.restedMarketTs ?? ctx.market.exchangeTs),
      version: advanced.version + 1,
      updatedAt: ctx.market.exchangeTs,
    };
    byId.set(order.id, filled);

    fills.push({
      orderId: order.id,
      qty,
      priceTicks: decision.priceTicks,
      feesMicros: fees,
      slippageTicks: decision.slippageTicks,
      liquidity: decision.liquidity,
      reason: decision.reason,
      exchangeTs: ctx.market.exchangeTs,
    });

    const applied = applyFill(ctx.spec, currentPosition, {
      signedQty: signedQty(filled, qty),
      priceTicks: decision.priceTicks,
      feesMicros: fees,
      exchangeTs: ctx.market.exchangeTs,
    });
    currentPosition = applied.position;
    realized += applied.grossRealizedMicros;
    feesTotal += fees;
    closedLots.push(...applied.closedLots);

    // OCO is resolved the instant a sibling trades, inside this same pass, so no
    // later order in this loop can fill against the same observation.
    //
    // A PARTIAL fill must reduce the siblings rather than leave them alone.
    // The legs of a bracket protect one position between them; if a stop fills
    // 1 of 3 and the target stays sized for 3, the remaining 2 can be exited
    // twice and the account is flipped short by the difference.
    if (filled.ocoGroupId) {
      for (const other of byId.values()) {
        if (other.id === filled.id) continue;
        if (other.ocoGroupId !== filled.ocoGroupId) continue;
        if (!isOpen(other)) continue;

        const reducedQty = other.qty - qty;
        if (reducedQty <= other.filledQty) {
          canceledByOco.add(other.id);
          byId.set(other.id, {
            ...other,
            status: 'CANCELED',
            version: other.version + 1,
            updatedAt: ctx.market.exchangeTs,
          });
        } else {
          byId.set(other.id, {
            ...other,
            qty: reducedQty,
            version: other.version + 1,
            updatedAt: ctx.market.exchangeTs,
          });
        }
      }
    }
  }

  return {
    orders: [...byId.values()],
    position: currentPosition,
    fills,
    canceledByOco: [...canceledByOco],
    closedLots,
    realizedPnlMicros: realized,
    feesMicros: feesTotal,
  };
}

/**
 * Protective orders are sized to the position, not to their original quantity.
 *
 * If a long 3 is reduced to 1 by a manual sell, a stop for 3 would flip the
 * account short 2 when it fires. Real platforms resize protective orders; so
 * does this one.
 */
export function resizeProtectiveOrders(
  orders: readonly EngineOrder[],
  position: PositionState,
  exchangeTs: number,
): EngineOrder[] {
  const openQty = Math.abs(position.qty);
  return orders.map((order) => {
    if (order.bracketRole !== 'STOP_LOSS' && order.bracketRole !== 'TAKE_PROFIT') return order;
    if (!isOpen(order)) return order;

    if (openQty === 0) {
      return { ...order, status: 'CANCELED', version: order.version + 1, updatedAt: exchangeTs };
    }
    const target = Math.min(order.qty, openQty);
    if (target === order.qty) return order;
    return { ...order, qty: target, version: order.version + 1, updatedAt: exchangeTs };
  });
}
