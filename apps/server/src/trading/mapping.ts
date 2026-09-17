/**
 * Mapping between database rows and the engine's own types.
 *
 * Kept in one place so the engine never learns what a database row looks like,
 * and the database never learns what an engine order looks like.
 */
import type { InstrumentSpec, OrderStatus, OrderType, Side, TimeInForce } from '@atlas/contracts';
import { avgFillTicks, type BracketRole, type EngineOrder } from '@atlas/core';
import { avgEntryTicks, flatPosition, sideOf, type PositionState } from '@atlas/core';
import type { orders, positions } from '../db/schema.js';

export type OrderRow = typeof orders.$inferSelect;
export type PositionRow = typeof positions.$inferSelect;

/** Ticks are fractional in averages; the database stores them scaled. */
export const TICK_SCALE = 1_000_000;

export function scaleTicks(ticks: number): number {
  return Math.round(ticks * TICK_SCALE);
}

export function unscaleTicks(scaled: number): number {
  return scaled / TICK_SCALE;
}

/** Bracket offsets carried alongside an entry order. */
export interface StoredBracket {
  readonly stopLossTicks?: number | null;
  readonly takeProfitTicks?: number | null;
  readonly trailingStopTicks?: number | null;
}

export function readBracket(row: OrderRow): StoredBracket | null {
  return (row.bracketConfig ?? null) as StoredBracket | null;
}

export function toEngineOrder(row: OrderRow): EngineOrder {
  return {
    id: row.id,
    accountId: row.accountId,
    clientOrderId: row.clientOrderId,
    symbol: row.symbol,
    side: row.side as Side,
    qty: row.qty,
    filledQty: row.filledQty,
    fillNotionalMicros: row.fillNotionalMicros,
    type: row.type as OrderType,
    limitTicks: row.limitTicks,
    stopTicks: row.stopTicks,
    tif: row.tif as TimeInForce,
    status: row.status as OrderStatus,
    stopTriggered: row.stopTriggered,
    hasRested: row.hasRested,
    restedMarketTs: row.restedMarketTs,
    ocoGroupId: row.ocoGroupId,
    parentOrderId: row.parentOrderId,
    bracketRole: row.bracketRole as BracketRole,
    trailTicks: row.trailTicks,
    trailAnchorTicks: row.trailAnchorTicks,
    eligibleAt: row.eligibleAt,
    tradingDate: row.tradingDate,
    rejectReason: row.rejectReason,
    version: row.version,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function toOrderValues(order: EngineOrder): typeof orders.$inferInsert {
  return {
    id: order.id,
    accountId: order.accountId,
    clientOrderId: order.clientOrderId,
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    filledQty: order.filledQty,
    fillNotionalMicros: order.fillNotionalMicros,
    type: order.type,
    limitTicks: order.limitTicks,
    stopTicks: order.stopTicks,
    tif: order.tif,
    status: order.status,
    stopTriggered: order.stopTriggered,
    hasRested: order.hasRested,
    restedMarketTs: order.restedMarketTs,
    ocoGroupId: order.ocoGroupId,
    parentOrderId: order.parentOrderId,
    bracketRole: order.bracketRole,
    trailTicks: order.trailTicks,
    trailAnchorTicks: order.trailAnchorTicks,
    eligibleAt: order.eligibleAt,
    tradingDate: order.tradingDate,
    rejectReason: order.rejectReason,
    version: order.version,
    createdAt: new Date(order.createdAt),
    updatedAt: new Date(order.updatedAt),
  };
}

export function toEnginePosition(row: PositionRow | undefined, symbol: string): PositionState {
  if (!row) return flatPosition(symbol);
  return {
    symbol: row.symbol,
    qty: row.qty,
    costBasisMicros: row.costBasisMicros,
    realizedPnlMicros: row.realizedPnlMicros,
    feesMicros: row.feesMicros,
    openedAt: row.openedAt?.getTime() ?? null,
    updatedAt: row.updatedAt.getTime(),
  };
}

export function toPositionValues(
  accountId: string,
  position: PositionState,
): typeof positions.$inferInsert {
  return {
    accountId,
    symbol: position.symbol,
    side: sideOf(position.qty),
    qty: position.qty,
    costBasisMicros: position.costBasisMicros,
    realizedPnlMicros: position.realizedPnlMicros,
    feesMicros: position.feesMicros,
    openedAt: position.openedAt === null ? null : new Date(position.openedAt),
    updatedAt: new Date(position.updatedAt ?? Date.now()),
  };
}

/** Client-facing order view. Average fill price is derived, never stored. */
export function presentOrder(order: EngineOrder, spec: InstrumentSpec) {
  const avg = avgFillTicks(order, spec.tickValueMicros);
  return {
    id: order.id,
    accountId: order.accountId,
    clientOrderId: order.clientOrderId,
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    filledQty: order.filledQty,
    remainingQty: Math.max(0, order.qty - order.filledQty),
    type: order.type,
    limitTicks: order.limitTicks,
    stopTicks: order.stopTicks,
    limitPrice: order.limitTicks === null ? null : ticks(spec, order.limitTicks),
    stopPrice: order.stopTicks === null ? null : ticks(spec, order.stopTicks),
    tif: order.tif,
    status: order.status,
    stopTriggered: order.stopTriggered,
    avgFillTicks: avg,
    avgFillPrice: avg === null ? null : ticks(spec, avg),
    ocoGroupId: order.ocoGroupId,
    parentOrderId: order.parentOrderId,
    bracketRole: order.bracketRole,
    trailTicks: order.trailTicks,
    rejectReason: order.rejectReason,
    version: order.version,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function ticks(spec: InstrumentSpec, t: number): number {
  return (t * spec.tickSizeScaled) / 10 ** spec.pricePrecision;
}

/** Client-facing position view, with a mark supplied by the caller. */
export function presentPosition(
  position: PositionState,
  spec: InstrumentSpec,
  markTicks: number | null,
  /**
   * NULL when no mark applies: unknown, not zero.
   *
   * Reporting an unmarkable position as flat P&L is how a trader ends up
   * believing a number that reconciles to nothing. A position with no mark has
   * no open P&L to show, and the terminal shows that rather than a figure.
   */
  unrealizedMicros: number | null,
  protective: { stopOrderId: string | null; targetOrderId: string | null },
) {
  const avg = position.qty === 0 ? null : avgEntryTicks(spec, position);
  return {
    symbol: position.symbol,
    side: sideOf(position.qty),
    qty: Math.abs(position.qty),
    signedQty: position.qty,
    avgEntryTicks: avg,
    avgEntryPrice: avg === null ? null : ticks(spec, avg),
    markTicks,
    markPrice: markTicks === null ? null : ticks(spec, markTicks),
    unrealizedPnlMicros: unrealizedMicros,
    realizedPnlMicros: position.realizedPnlMicros,
    feesMicros: position.feesMicros,
    openedAt: position.openedAt,
    updatedAt: position.updatedAt,
    stopOrderId: protective.stopOrderId,
    targetOrderId: protective.targetOrderId,
  };
}
