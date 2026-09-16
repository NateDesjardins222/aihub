/** Trading domain contracts. The server is authoritative for every value here. */

export type Side = 'BUY' | 'SELL';
export type PositionSide = 'LONG' | 'SHORT' | 'FLAT';

export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT' | 'TRAILING_STOP';

export type TimeInForce = 'DAY' | 'GTC' | 'IOC' | 'FOK';

/** Full order lifecycle. Every transition is written to the audit log. */
export type OrderStatus =
  | 'CREATED'
  | 'VALIDATING'
  | 'WORKING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCEL_PENDING'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED';

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
];

export type BracketRole = 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'STANDALONE';

export interface Order {
  readonly id: string;
  readonly accountId: string;
  /** Client-supplied idempotency key. Unique per account. */
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly qty: number;
  readonly filledQty: number;
  readonly type: OrderType;
  /** Limit price in integer ticks. Null for market/stop-market. */
  readonly limitTicks: number | null;
  /** Stop trigger price in integer ticks. Null for market/limit. */
  readonly stopTicks: number | null;
  readonly tif: TimeInForce;
  readonly status: OrderStatus;
  /** Weighted average fill price in ticks, null until first fill. */
  readonly avgFillTicks: number | null;
  readonly ocoGroupId: string | null;
  readonly parentOrderId: string | null;
  readonly bracketRole: BracketRole;
  /** Trailing distance in ticks, for TRAILING_STOP. */
  readonly trailTicks: number | null;
  /** Best price reached since activation, in ticks; drives the trail. */
  readonly trailAnchorTicks: number | null;
  readonly rejectReason: string | null;
  /** Optimistic-concurrency version; incremented on every mutation. */
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Execution {
  readonly id: string;
  readonly orderId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly qty: number;
  readonly priceTicks: number;
  /** Commission + exchange fees for this fill, micro-dollars (always >= 0). */
  readonly feesMicros: number;
  /** Realized P&L attributable to this fill, micro-dollars (signed). */
  readonly realizedPnlMicros: number;
  readonly execTime: number;
  readonly seq: number;
  readonly liquidity: 'MAKER' | 'TAKER';
  /** Slippage applied by the fill model, in ticks (signed, adverse is positive). */
  readonly slippageTicks: number;
}

export interface Position {
  readonly id: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly side: PositionSide;
  /** Always non-negative; side carries the direction. */
  readonly qty: number;
  /** Weighted average entry in ticks. 0 when flat. */
  readonly avgEntryTicks: number;
  readonly realizedPnlMicros: number;
  readonly feesMicros: number;
  readonly openedAt: number | null;
  readonly updatedAt: number;
  readonly version: number;
}

/** A position enriched with live mark data. Computed, never stored. */
export interface PositionView extends Position {
  readonly markTicks: number | null;
  readonly unrealizedPnlMicros: number;
  readonly openPnlTicks: number;
  readonly stopOrderId: string | null;
  readonly targetOrderId: string | null;
}

/** A completed round-trip, produced when a position is reduced or closed. */
export interface Trade {
  readonly id: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly side: PositionSide;
  readonly qty: number;
  readonly entryTicks: number;
  readonly exitTicks: number;
  readonly entryTime: number;
  readonly exitTime: number;
  readonly grossPnlMicros: number;
  readonly feesMicros: number;
  readonly netPnlMicros: number;
}

export interface BracketConfig {
  /** Distance from entry in ticks. Exactly one of ticks/points/dollars is resolved server-side. */
  readonly stopLossTicks?: number | null;
  readonly takeProfitTicks?: number | null;
  readonly trailingStopTicks?: number | null;
}

export interface OrderRequest {
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
  readonly bracket?: BracketConfig | null;
}

export interface OrderModifyRequest {
  readonly accountId: string;
  readonly orderId: string;
  readonly qty?: number;
  readonly limitTicks?: number | null;
  readonly stopTicks?: number | null;
  readonly trailTicks?: number | null;
  /** Version the client believed it was modifying. Rejects stale drag operations. */
  readonly expectedVersion?: number;
}

/** Machine-readable rejection reasons. The UI maps these to copy; never parse strings. */
export type RejectReason =
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_FAILED'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_PASSED'
  | 'UNKNOWN_INSTRUMENT'
  | 'MARKET_CLOSED'
  | 'MARKET_DATA_STALE'
  | 'MARKET_DATA_UNAVAILABLE'
  | 'INVALID_QUANTITY'
  | 'INVALID_PRICE'
  | 'INVALID_TICK'
  | 'MISSING_LIMIT_PRICE'
  | 'MISSING_STOP_PRICE'
  | 'UNSUPPORTED_ORDER_TYPE'
  | 'STOP_ON_WRONG_SIDE'
  | 'LIMIT_ON_WRONG_SIDE'
  | 'MAX_CONTRACTS_EXCEEDED'
  | 'POSITION_LIMIT_EXCEEDED'
  | 'DAILY_LOSS_LIMIT'
  | 'MAX_LOSS_LIMIT'
  | 'TRAILING_DRAWDOWN_BREACH'
  | 'DUPLICATE_ORDER'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_NOT_MODIFIABLE'
  | 'STALE_ORDER_VERSION'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface RiskRejection {
  readonly reason: RejectReason;
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}
