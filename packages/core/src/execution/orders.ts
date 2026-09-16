/**
 * Order construction and lifecycle transitions.
 *
 * Kept separate from matching so that "what an order is" and "when an order
 * fills" can be reasoned about independently.
 */
import type { OrderStatus, OrderType, Side, TimeInForce } from '@atlas/contracts';
import type { SimulationEnvironment } from './environment.js';
import type { BracketRole, EngineOrder } from './types.js';
import { isOpen, remainingQty } from './types.js';

export interface CreateOrderInput {
  readonly id: string;
  readonly accountId: string;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly qty: number;
  readonly type: OrderType;
  readonly limitTicks?: number | null;
  readonly stopTicks?: number | null;
  readonly tif?: TimeInForce;
  readonly trailTicks?: number | null;
  readonly ocoGroupId?: string | null;
  readonly parentOrderId?: string | null;
  readonly bracketRole?: BracketRole;
  readonly tradingDate?: string | null;
  readonly now: number;
  /**
   * Exchange time of the market the order was sent into.
   *
   * It fixes the order's place in market time, which is what decides whether a
   * closed bar is allowed to fill it: a bar that opened before the order was
   * sent traded prices the order was never live for.
   */
  readonly marketTs?: number | null;
}

export function createOrder(input: CreateOrderInput, env: SimulationEnvironment): EngineOrder {
  return {
    id: input.id,
    accountId: input.accountId,
    clientOrderId: input.clientOrderId,
    symbol: input.symbol,
    side: input.side,
    qty: input.qty,
    filledQty: 0,
    fillNotionalMicros: 0,
    type: input.type,
    limitTicks: input.limitTicks ?? null,
    stopTicks: input.stopTicks ?? null,
    tif: input.tif ?? 'DAY',
    status: 'WORKING',
    stopTriggered: false,
    hasRested: false,
    restedMarketTs: input.marketTs ?? null,
    ocoGroupId: input.ocoGroupId ?? null,
    parentOrderId: input.parentOrderId ?? null,
    bracketRole: input.bracketRole ?? 'STANDALONE',
    trailTicks: input.trailTicks ?? null,
    trailAnchorTicks: null,
    eligibleAt: input.now + env.latencyMs,
    tradingDate: input.tradingDate ?? null,
    rejectReason: null,
    version: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function rejectOrder(order: EngineOrder, reason: string, now: number): EngineOrder {
  return {
    ...order,
    status: 'REJECTED',
    rejectReason: reason,
    version: order.version + 1,
    updatedAt: now,
  };
}

export function cancelOrder(order: EngineOrder, now: number): EngineOrder {
  return { ...order, status: 'CANCELED', version: order.version + 1, updatedAt: now };
}

export function expireOrder(order: EngineOrder, now: number): EngineOrder {
  return { ...order, status: 'EXPIRED', version: order.version + 1, updatedAt: now };
}

export interface ModifyOrderPatch {
  readonly qty?: number;
  readonly limitTicks?: number | null;
  readonly stopTicks?: number | null;
  readonly trailTicks?: number | null;
}

export type ModifyRejection =
  | 'ORDER_NOT_MODIFIABLE'
  | 'QUANTITY_BELOW_FILLED'
  | 'INVALID_QUANTITY';

export interface ModifyResult {
  readonly ok: boolean;
  readonly order: EngineOrder;
  readonly reason?: ModifyRejection;
}

/**
 * Apply a modification.
 *
 * Reducing quantity below what has already filled is refused rather than
 * silently clamped: the caller asked for something that cannot be true, and
 * quietly doing something else is how a trader ends up with a position they did
 * not intend.
 *
 * A modified order goes back to the end of the queue — `hasRested` is reset —
 * because moving a resting limit is a new order at the exchange, not the same
 * one at a different price.
 */
export function modifyOrder(
  order: EngineOrder,
  patch: ModifyOrderPatch,
  now: number,
): ModifyResult {
  if (!isOpen(order) || order.status === 'CANCEL_PENDING') {
    return { ok: false, order, reason: 'ORDER_NOT_MODIFIABLE' };
  }

  let next = order;

  if (patch.qty !== undefined) {
    if (!Number.isInteger(patch.qty) || patch.qty <= 0) {
      return { ok: false, order, reason: 'INVALID_QUANTITY' };
    }
    if (patch.qty < order.filledQty) {
      return { ok: false, order, reason: 'QUANTITY_BELOW_FILLED' };
    }
    next = { ...next, qty: patch.qty };
  }

  if (patch.limitTicks !== undefined) next = { ...next, limitTicks: patch.limitTicks };
  if (patch.stopTicks !== undefined) next = { ...next, stopTicks: patch.stopTicks };
  if (patch.trailTicks !== undefined) {
    // Re-anchor: a new trail distance measured from a stale anchor would jump
    // the stop to a price the market never justified.
    next = { ...next, trailTicks: patch.trailTicks, trailAnchorTicks: null };
  }

  // A stop-limit whose stop is moved back above the market un-triggers: the
  // election has not happened at the new price.
  if (next.type === 'STOP_LIMIT' && patch.stopTicks !== undefined) {
    next = { ...next, stopTriggered: false };
  }

  const settled = next.filledQty >= next.qty;
  return {
    ok: true,
    order: {
      ...next,
      // A modified order is a new order at its new price: it has not rested
      // there, so it may claim neither arrival pricing nor an earlier bar.
      hasRested: false,
      restedMarketTs: null,
      status: settled ? 'FILLED' : next.filledQty > 0 ? 'PARTIALLY_FILLED' : 'WORKING',
      version: next.version + 1,
      updatedAt: now,
    },
  };
}

/** Time-in-force handling applied immediately after an order's first evaluation. */
export function applyTimeInForce(order: EngineOrder, now: number): EngineOrder {
  if (!isOpen(order)) return order;
  if (order.tif === 'IOC' && remainingQty(order) > 0 && order.hasRested) {
    return order.filledQty > 0
      ? { ...order, status: 'CANCELED', version: order.version + 1, updatedAt: now }
      : cancelOrder(order, now);
  }
  return order;
}

/**
 * Fill-or-kill: either the whole quantity fills on the first look or nothing
 * does. Checked before any fill is committed, so a partial is never left behind.
 */
export function violatesFillOrKill(order: EngineOrder, availableQty: number): boolean {
  return order.tif === 'FOK' && availableQty < order.qty;
}

/** DAY orders die at the end of the trading date they were created on. */
export function expiresOnTradingDate(order: EngineOrder, currentTradingDate: string): boolean {
  if (order.tif !== 'DAY') return false;
  if (order.tradingDate === null) return false;
  return currentTradingDate !== order.tradingDate;
}

export function statusAfterFill(order: EngineOrder): OrderStatus {
  if (order.filledQty >= order.qty) return 'FILLED';
  if (order.filledQty > 0) return 'PARTIALLY_FILLED';
  return 'WORKING';
}
