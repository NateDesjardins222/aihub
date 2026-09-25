/**
 * Normalize Rithmic order/execution messages ↔ Atlas canonical (Milestone 9).
 *
 * Atlas order ids are canonical; the Rithmic basket_id is stored alongside. A
 * provider acknowledgement is NOT a fill; a fill is only an ExchangeOrderNotification
 * of type FILL. Execution reports carry a stable dedup key so a replayed or
 * duplicated fill is never applied twice. Enum values are resolved from the schema,
 * never hardcoded.
 */
import type { ExecutionReport, ExternalSubmitInput } from '../../execution/external-provider.js';
import type { ExternalOrderState } from '@atlas/contracts';
import type { RithmicCodec } from '../protocol/codec.js';

/** Build a RequestNewOrder payload from an Atlas submit intent. */
export function buildNewOrder(
  codec: RithmicCodec,
  input: ExternalSubmitInput,
  ctx: { fcmId: string; ibId: string; providerAccountId: string; exchange: string; tradeRoute: string },
): Record<string, unknown> {
  const txn = codec.enumValue('RequestNewOrder', 'TransactionType', input.side === 'BUY' ? 'BUY' : 'SELL');
  const priceTypeName = ({ MARKET: 'MARKET', LIMIT: 'LIMIT', STOP_MARKET: 'STOP_MARKET', STOP_LIMIT: 'STOP_LIMIT' } as const)[input.type];
  const priceType = codec.enumValue('RequestNewOrder', 'PriceType', priceTypeName);
  const duration = codec.enumValue('RequestNewOrder', 'Duration', 'DAY');
  // An Atlas-generated (API) order is AUTO, per the official manual/auto designation.
  const manualOrAuto = codec.enumValue('RequestNewOrder', 'OrderPlacement', 'AUTO');
  const payload: Record<string, unknown> = {
    user_tag: input.clientOrderId, // stable idempotency/correlation key
    fcm_id: ctx.fcmId, ib_id: ctx.ibId, account_id: ctx.providerAccountId,
    symbol: input.contractCode ?? input.symbol, exchange: ctx.exchange,
    quantity: input.qty, quantity_64: input.qty,
    transaction_type: txn, duration, price_type: priceType,
    trade_route: ctx.tradeRoute, manual_or_auto: manualOrAuto,
    user_msg: [input.clientOrderId],
  };
  if (input.limitPrice != null) payload['price'] = input.limitPrice;
  if (input.stopPrice != null) payload['trigger_price'] = input.stopPrice;
  return payload;
}

/** A stable dedup key for an execution/fill so it can never apply twice. */
export function executionDedupKey(msg: Record<string, unknown>): string {
  const basket = String(msg['basket_id'] ?? '');
  const trade = String(msg['trade_id'] ?? '');
  const fill = String(msg['fill_size'] ?? '');
  const ts = `${msg['ssboe'] ?? ''}.${msg['usecs'] ?? ''}`;
  return `${basket}|${trade}|${fill}|${ts}`;
}

/**
 * Map an ExchangeOrderNotification to an Atlas ExecutionReport. The exchange is
 * authoritative for external fills/rejects — the Atlas simulator never fills a
 * Rithmic-routed order.
 */
export function mapExchangeNotification(codec: RithmicCodec, msg: Record<string, unknown>, atlasOrderId: string | null): ExecutionReport {
  const notifyType = Number(msg['notify_type']);
  const totalFill = numOr0(msg['total_fill_size']);
  const totalUnfilled = numOr0(msg['total_unfilled_size']);
  const lastFill = numOr0(msg['fill_size']);
  const fillPrice = num(msg['fill_price']);
  const state = exchangeStateFor(codec, notifyType, totalFill, totalUnfilled);
  return {
    providerOrderId: String(msg['basket_id'] ?? ''),
    atlasOrderId,
    state,
    filledQty: totalFill,
    lastFillQty: lastFill,
    avgFillPrice: fillPrice,
    providerStatus: String(msg['status'] ?? msg['report_type'] ?? '') || `notify=${notifyType}`,
    eventTs: rithmicEventTs(msg),
  };
}

function exchangeStateFor(codec: RithmicCodec, notifyType: number, totalFill: number, totalUnfilled: number): ExternalOrderState {
  const NT = (name: string): number => { try { return codec.enumValue('ExchangeOrderNotification', 'NotifyType', name); } catch { return -1; } };
  if (notifyType === NT('REJECT')) return 'REJECTED';
  if (notifyType === NT('CANCEL')) return 'CANCELED';
  if (notifyType === NT('FILL')) return totalUnfilled > 0 ? 'PARTIALLY_FILLED' : 'FILLED';
  if (notifyType === NT('NOT_MODIFIED') || notifyType === NT('NOT_CANCELLED')) return 'ACKNOWLEDGED';
  // STATUS / TRIGGER / MODIFY: working unless already fully filled.
  if (totalFill > 0 && totalUnfilled === 0) return 'FILLED';
  if (totalFill > 0) return 'PARTIALLY_FILLED';
  return 'ACKNOWLEDGED';
}

/** Map a RithmicOrderNotification (order-plant lifecycle) to a coarse state. */
export function mapRithmicNotification(codec: RithmicCodec, msg: Record<string, unknown>, atlasOrderId: string | null): ExecutionReport {
  const notifyType = Number(msg['notify_type']);
  const NT = (name: string): number => { try { return codec.enumValue('RithmicOrderNotification', 'NotifyType', name); } catch { return -1; } };
  let state: ExternalOrderState = 'SUBMITTED';
  if (notifyType === NT('ORDER_RCVD_FROM_CLNT')) state = 'SUBMITTED';
  else if (notifyType === NT('OPEN_PENDING')) state = 'SUBMITTED';
  else if (notifyType === NT('CANCEL_PENDING')) state = 'PENDING_CANCEL';
  else if (notifyType === NT('MODIFY_PENDING')) state = 'ACKNOWLEDGED';
  else if (notifyType === NT('ORDER_RCVD_BY_EXCH_GTWY')) state = 'ACKNOWLEDGED';
  return {
    providerOrderId: String(msg['basket_id'] ?? ''),
    atlasOrderId,
    state,
    filledQty: 0,
    lastFillQty: 0,
    avgFillPrice: null,
    providerStatus: String(msg['status'] ?? '') || `notify=${notifyType}`,
    eventTs: rithmicEventTs(msg),
  };
}

function rithmicEventTs(msg: Record<string, unknown>): number {
  const s = Number(msg['ssboe']);
  if (!Number.isFinite(s) || s <= 0) return Date.now();
  const u = Number(msg['usecs']);
  return s * 1000 + (Number.isFinite(u) ? Math.floor(u / 1000) : 0);
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== null && v !== '' ? n : null;
}
function numOr0(v: unknown): number {
  return num(v) ?? 0;
}
