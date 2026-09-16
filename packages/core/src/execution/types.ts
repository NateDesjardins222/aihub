/** Order types as the execution engine sees them. Prices are integer ticks. */
import type { OrderStatus, OrderType, Side, TimeInForce } from '@atlas/contracts';

export type BracketRole = 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'STANDALONE';

export interface EngineOrder {
  readonly id: string;
  readonly accountId: string;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly qty: number;
  readonly filledQty: number;
  /**
   * Sum of price x qty x tickValue over every fill, in micro-dollars. Average
   * fill price is derived from it, so it never accumulates rounding error.
   */
  readonly fillNotionalMicros: number;
  readonly type: OrderType;
  readonly limitTicks: number | null;
  readonly stopTicks: number | null;
  readonly tif: TimeInForce;
  readonly status: OrderStatus;
  /** A stop-limit that has triggered behaves as a limit from then on. */
  readonly stopTriggered: boolean;
  /**
   * True once the order has been evaluated at least once without filling.
   *
   * A limit is only "marketable on arrival" on its first look; after that it is
   * resting and fills at its own price. Conflating the two hands the trader
   * price improvement the market never offered.
   */
  readonly hasRested: boolean;
  /**
   * Exchange time at which this order started resting, or null before it does.
   *
   * A bar's extremes may only fill an order that was already working when that
   * bar opened. Without this, an order placed at 10:04 fills from the 10:03 bar
   * - a price that traded before the order existed. On a delayed feed that is
   * not a corner case: the newest bar the server holds is always minutes old.
   */
  readonly restedMarketTs: number | null;
  readonly ocoGroupId: string | null;
  readonly parentOrderId: string | null;
  readonly bracketRole: BracketRole;
  readonly trailTicks: number | null;
  /** Best price seen since a trailing stop became active, in ticks. */
  readonly trailAnchorTicks: number | null;
  /** Wall-clock time from which this order may fill; models submission latency. */
  readonly eligibleAt: number;
  /** Trading date the order was created on, for DAY expiry. */
  readonly tradingDate: string | null;
  readonly rejectReason: string | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const OPEN_STATUSES: readonly OrderStatus[] = ['WORKING', 'PARTIALLY_FILLED', 'CANCEL_PENDING'];

export function isOpen(order: EngineOrder): boolean {
  return OPEN_STATUSES.includes(order.status);
}

export function isTerminal(order: EngineOrder): boolean {
  return (
    order.status === 'FILLED' ||
    order.status === 'CANCELED' ||
    order.status === 'REJECTED' ||
    order.status === 'EXPIRED'
  );
}

export function remainingQty(order: EngineOrder): number {
  return Math.max(0, order.qty - order.filledQty);
}

/** Signed quantity this order contributes to a position when filled. */
export function signedQty(order: EngineOrder, qty: number): number {
  return order.side === 'BUY' ? qty : -qty;
}

/** Average fill price in ticks, or null before the first fill. */
export function avgFillTicks(order: EngineOrder, tickValueMicros: number): number | null {
  if (order.filledQty === 0) return null;
  return order.fillNotionalMicros / (order.filledQty * tickValueMicros);
}

/** The market view the engine reacts to. Every price is in integer ticks. */
export interface MarketSnapshot {
  readonly symbol: string;
  /** Exchange timestamp of this observation. Never the server clock. */
  readonly exchangeTs: number;
  readonly lastTicks: number | null;
  readonly bidTicks: number | null;
  readonly askTicks: number | null;
  /**
   * A bar that has just closed. Its extremes are prices that genuinely traded,
   * which is the only way a delayed feed can fill a resting order it never
   * sampled.
   */
  readonly bar: {
    /** Bar open time, exchange epoch ms. */
    readonly startTs: number;
    /** Bar end time, exchange epoch ms: the first instant NOT in the bar. */
    readonly endTs: number;
    readonly openTicks: number;
    readonly highTicks: number;
    readonly lowTicks: number;
    readonly closeTicks: number;
    readonly volume: number;
  } | null;
}

export interface FillDecision {
  readonly qty: number;
  readonly priceTicks: number;
  /** Adverse slippage included in priceTicks, in ticks. Positive is adverse. */
  readonly slippageTicks: number;
  readonly liquidity: 'MAKER' | 'TAKER';
  /** Why this fill happened, for the audit trail. */
  readonly reason: string;
  /**
   * True when the order executed against a market that was already beyond its
   * price, rather than by resting until the market arrived.
   *
   * This distinction survives partial fills. An order that is marketable stays
   * marketable, so its remainder keeps taking the market's price; marking it
   * "rested" after its first partial would fill the balance at its own limit —
   * a price the market may never have traded.
   */
  readonly marketable: boolean;
}
