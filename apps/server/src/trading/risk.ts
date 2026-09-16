/**
 * Pre-trade risk gate.
 *
 * Every order passes through here before the engine sees it. The checks are
 * ordered cheapest-first, and each returns a MACHINE-READABLE reason so the UI
 * can explain a rejection without parsing prose.
 *
 * Milestone 3 covers the instrument, market and sizing checks. The prop-firm
 * rules — daily loss limit, trailing drawdown, consistency, pass and fail — are
 * Milestone 8; the pipeline is laid out so they slot in without restructuring,
 * and the ones already enforceable are enforced.
 */
import type { InstrumentSpec, RejectReason } from '@atlas/contracts';
import { getMarketState, isValidTickPrice, ticksToPrice } from '@atlas/instruments';
import { contractWeight } from '@atlas/instruments';
import type { PositionState } from '@atlas/core';
import type { Freshness } from '../marketdata/quote-store.js';

export interface RiskAccount {
  readonly id: string;
  readonly status: string;
  readonly maxContracts: number;
  readonly microsCountAsFraction: boolean;
}

export interface RiskRequest {
  readonly side: 'BUY' | 'SELL';
  readonly qty: number;
  readonly type: string;
  readonly limitTicks: number | null;
  readonly stopTicks: number | null;
}

export interface RiskContext {
  readonly account: RiskAccount;
  readonly spec: InstrumentSpec;
  readonly freshness: Freshness;
  readonly position: PositionState;
  /** Absolute contracts already open across every symbol, weighted. */
  readonly openContracts: number;
  readonly lastTicks: number | null;
  /**
   * The EXCHANGE's clock, taken from the market data itself.
   *
   * Session checks must use this rather than the server clock. Replaying a past
   * session is the whole reason replay exists, and a wall-clock check would
   * refuse every order in it because "the market is closed right now". It also
   * makes the check correct for a delayed feed, whose newest data is minutes
   * behind the wall clock and can sit on the other side of a session boundary.
   */
  readonly marketNow: number;
  /** Wall clock, used only where real elapsed time matters. */
  readonly now: number;
}

export interface RiskRejection {
  readonly reason: RejectReason;
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}

const ACCOUNT_STATUS_REASON: Record<string, RejectReason> = {
  FAILED: 'ACCOUNT_FAILED',
  PASSED: 'ACCOUNT_PASSED',
  LOCKED: 'ACCOUNT_LOCKED',
  SUSPENDED: 'ACCOUNT_LOCKED',
};

export function checkOrder(ctx: RiskContext, request: RiskRequest): RiskRejection | null {
  const { account, spec } = ctx;

  // --- account state ------------------------------------------------------
  if (account.status !== 'ACTIVE' && account.status !== 'GOAL_REACHED') {
    return {
      reason: ACCOUNT_STATUS_REASON[account.status] ?? 'ACCOUNT_INACTIVE',
      message: `Account is ${account.status.replace('_', ' ').toLowerCase()}.`,
    };
  }

  // --- instrument and market ---------------------------------------------
  if (!spec.supportedOrderTypes.includes(request.type as never)) {
    return {
      reason: 'UNSUPPORTED_ORDER_TYPE',
      message: `${spec.root} does not support ${request.type} orders.`,
    };
  }

  // --- data availability --------------------------------------------------
  // Checked BEFORE the session, because with no data at all we cannot say
  // anything about the session either, and "no market data" is the more
  // actionable answer than "the market is closed".
  if (ctx.freshness.state === 'NO_DATA' || ctx.lastTicks === null) {
    return {
      reason: 'MARKET_DATA_UNAVAILABLE',
      message: 'No market data for this instrument yet.',
    };
  }

  const market = getMarketState(spec, ctx.marketNow);
  if (market.state !== 'OPEN') {
    return {
      reason: 'MARKET_CLOSED',
      message: `${spec.root} is ${market.state.toLowerCase()}${market.reason ? `: ${market.reason}` : ''}.`,
      detail: { marketState: market.state, reason: market.reason },
    };
  }

  // Trading against a price the market has moved away from is how a simulator
  // teaches habits that lose money live.
  //
  // Judged on the quote's AGE, not only on the freshness state: that state
  // reports MARKET_CLOSED whenever the server's clock says the session is shut,
  // which on a ten-minute-delayed feed hides the fact that the feed froze at
  // the close while its own clock still shows the session open. The frozen
  // price must not fill orders for the ten minutes that follow.
  const overAge =
    ctx.freshness.ageMs !== null && ctx.freshness.ageMs > ctx.freshness.thresholdMs;
  if (ctx.freshness.state === 'STALE' || overAge) {
    // Say WHY it stopped. A feed that froze because the session shut is a
    // closed market, not a broken feed, and the trader can act on the
    // difference: one of them ends at a known time.
    const closed = ctx.freshness.state === 'MARKET_CLOSED';
    return {
      reason: closed ? 'MARKET_CLOSED' : 'MARKET_DATA_STALE',
      message: closed
        ? `${spec.root} is closed: the feed stopped updating at the session break.`
        : 'Market data is stale. Order entry is disabled until the feed recovers.',
      detail: {
        ageMs: ctx.freshness.ageMs,
        thresholdMs: ctx.freshness.thresholdMs,
        freshness: ctx.freshness.state,
      },
    };
  }

  // --- quantity -----------------------------------------------------------
  if (!Number.isInteger(request.qty) || request.qty <= 0) {
    return { reason: 'INVALID_QUANTITY', message: 'Quantity must be a positive whole number.' };
  }
  if (request.qty < spec.minOrderQty || request.qty > spec.maxOrderQty) {
    return {
      reason: 'INVALID_QUANTITY',
      message: `${spec.root} accepts ${spec.minOrderQty}-${spec.maxOrderQty} contracts per order.`,
      detail: { min: spec.minOrderQty, max: spec.maxOrderQty },
    };
  }

  // --- prices -------------------------------------------------------------
  const priceChecks: Array<[number | null, string]> = [
    [request.limitTicks, 'limit'],
    [request.stopTicks, 'stop'],
  ];
  for (const [ticks, label] of priceChecks) {
    if (ticks === null) continue;
    if (!Number.isFinite(ticks) || ticks <= 0) {
      return { reason: 'INVALID_PRICE', message: `The ${label} price is not a valid price.` };
    }
    const price = ticksToPrice(spec, ticks);
    if (!isValidTickPrice(spec, price)) {
      return {
        reason: 'INVALID_TICK',
        message: `${spec.root} trades in increments of ${spec.tickSizeScaled / 10 ** spec.pricePrecision}.`,
        detail: { price },
      };
    }
  }

  if ((request.type === 'LIMIT' || request.type === 'STOP_LIMIT') && request.limitTicks === null) {
    return { reason: 'MISSING_LIMIT_PRICE', message: 'A limit order needs a limit price.' };
  }
  if ((request.type === 'STOP_MARKET' || request.type === 'STOP_LIMIT') && request.stopTicks === null) {
    return { reason: 'MISSING_STOP_PRICE', message: 'A stop order needs a stop price.' };
  }

  // A stop on the wrong side of the market would elect instantly and behave as
  // a market order, which is never what the trader meant.
  if (request.stopTicks !== null && ctx.lastTicks !== null) {
    if (request.side === 'BUY' && request.stopTicks <= ctx.lastTicks) {
      return {
        reason: 'STOP_ON_WRONG_SIDE',
        message: 'A buy stop must sit above the market.',
        detail: { stopTicks: request.stopTicks, lastTicks: ctx.lastTicks },
      };
    }
    if (request.side === 'SELL' && request.stopTicks >= ctx.lastTicks) {
      return {
        reason: 'STOP_ON_WRONG_SIDE',
        message: 'A sell stop must sit below the market.',
        detail: { stopTicks: request.stopTicks, lastTicks: ctx.lastTicks },
      };
    }
  }

  // --- position sizing ----------------------------------------------------
  // Only the quantity that would INCREASE exposure counts. A trader at their
  // limit must always be able to close.
  const signed = request.side === 'BUY' ? request.qty : -request.qty;
  const increasing = increasingQty(ctx.position.qty, signed);
  if (increasing > 0) {
    const weight = contractWeight(spec, increasing, account.microsCountAsFraction);
    const projected = ctx.openContracts + weight;
    if (projected > account.maxContracts + 1e-9) {
      return {
        reason: 'MAX_CONTRACTS_EXCEEDED',
        message: `This would take you to ${round2(projected)} of ${account.maxContracts} contracts.`,
        detail: { projected: round2(projected), limit: account.maxContracts },
      };
    }
  }

  return null;
}

/**
 * How much of a fill would grow exposure rather than reduce it.
 *
 * Selling 5 against a long 3 increases exposure by 2, not 5: the first 3 close
 * the position. Counting the whole order would stop a trader from reversing.
 */
export function increasingQty(positionQty: number, signedOrderQty: number): number {
  if (signedOrderQty === 0) return 0;
  if (positionQty === 0) return Math.abs(signedOrderQty);
  if (Math.sign(positionQty) === Math.sign(signedOrderQty)) return Math.abs(signedOrderQty);
  return Math.max(0, Math.abs(signedOrderQty) - Math.abs(positionQty));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
