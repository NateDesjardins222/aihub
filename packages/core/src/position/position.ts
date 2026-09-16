/**
 * Position mathematics.
 *
 * A position is held as a signed quantity plus a signed COST BASIS in
 * micro-dollars, rather than as a decimal average entry price. That choice is
 * what makes the arithmetic exact:
 *
 *   - average entry is frequently a fraction of a tick (buy 1 @ 100, 1 @ 101),
 *     and storing it as a float lets rounding error accumulate across every
 *     subsequent fill;
 *   - cost basis is an integer sum of integers, so it never drifts;
 *   - one formula covers both directions, with no long/short branch to get
 *     wrong: unrealized = mark x qty x tickValue - costBasis.
 *
 * Average entry is then a derived, display-only value.
 */
import type { InstrumentSpec } from '@atlas/contracts';

export interface PositionState {
  readonly symbol: string;
  /** Signed: positive is long, negative is short, zero is flat. */
  readonly qty: number;
  /**
   * Signed notional paid (long) or received (short) for the OPEN quantity,
   * in micro-dollars. Long 2 @ 100 ticks on a $5 tick = +1,000 * 1e6.
   */
  readonly costBasisMicros: number;
  readonly realizedPnlMicros: number;
  readonly feesMicros: number;
  /** Exchange timestamp of the fill that opened the current position. */
  readonly openedAt: number | null;
  /** Exchange timestamp of the most recent fill. */
  readonly updatedAt: number | null;
}

export function flatPosition(symbol: string): PositionState {
  return {
    symbol,
    qty: 0,
    costBasisMicros: 0,
    realizedPnlMicros: 0,
    feesMicros: 0,
    openedAt: null,
    updatedAt: null,
  };
}

export type PositionSide = 'LONG' | 'SHORT' | 'FLAT';

export function sideOf(qty: number): PositionSide {
  if (qty > 0) return 'LONG';
  if (qty < 0) return 'SHORT';
  return 'FLAT';
}

/**
 * Average entry in ticks, derived from the cost basis. Fractional by nature.
 * Returns 0 when flat, which callers must treat as "no entry" rather than
 * a price of zero.
 */
export function avgEntryTicks(spec: InstrumentSpec, position: PositionState): number {
  if (position.qty === 0) return 0;
  return position.costBasisMicros / (position.qty * spec.tickValueMicros);
}

/** Notional value of the open position at a mark, in micro-dollars. */
export function markValueMicros(
  spec: InstrumentSpec,
  position: PositionState,
  markTicks: number,
): number {
  return markTicks * position.qty * spec.tickValueMicros;
}

/**
 * Open P&L at a mark, in micro-dollars. Direction-agnostic: the sign of qty
 * carries it.
 */
export function unrealizedPnlMicros(
  spec: InstrumentSpec,
  position: PositionState,
  markTicks: number | null,
): number {
  if (position.qty === 0 || markTicks === null) return 0;
  return markValueMicros(spec, position, markTicks) - position.costBasisMicros;
}

/** Open P&L expressed in ticks for one contract, for display. */
export function openTicks(
  spec: InstrumentSpec,
  position: PositionState,
  markTicks: number | null,
): number {
  if (position.qty === 0 || markTicks === null) return 0;
  const direction = position.qty > 0 ? 1 : -1;
  return (markTicks - avgEntryTicks(spec, position)) * direction;
}

/** A completed round-trip produced by reducing or closing a position. */
export interface ClosedLot {
  readonly symbol: string;
  readonly side: 'LONG' | 'SHORT';
  readonly qty: number;
  /** Average entry of the portion closed, in ticks (may be fractional). */
  readonly entryTicks: number;
  readonly exitTicks: number;
  readonly grossPnlMicros: number;
  readonly openedAt: number | null;
  readonly closedAt: number;
}

export interface ApplyFillInput {
  /** Signed fill quantity: positive buys, negative sells. */
  readonly signedQty: number;
  readonly priceTicks: number;
  readonly feesMicros: number;
  readonly exchangeTs: number;
}

export interface ApplyFillResult {
  readonly position: PositionState;
  /** Realized P&L produced by this fill alone, before fees. */
  readonly grossRealizedMicros: number;
  /** Round-trips completed by this fill. A reversal closes one and opens another. */
  readonly closedLots: readonly ClosedLot[];
  /** True when the fill flipped the position through zero. */
  readonly reversed: boolean;
}

/**
 * Apply one fill.
 *
 * Handles every case uniformly: opening, adding, reducing, closing, and
 * reversing through zero. A reversal is treated as a full close followed by a
 * fresh open, which is what the exchange's own position accounting does and
 * what makes the resulting trade history readable.
 */
export function applyFill(
  spec: InstrumentSpec,
  position: PositionState,
  fill: ApplyFillInput,
): ApplyFillResult {
  if (fill.signedQty === 0) {
    return { position, grossRealizedMicros: 0, closedLots: [], reversed: false };
  }

  const opening = position.qty === 0;
  const sameDirection = !opening && Math.sign(fill.signedQty) === Math.sign(position.qty);

  // --- increasing an existing position, or opening a new one ---------------
  if (opening || sameDirection) {
    const added = fill.priceTicks * fill.signedQty * spec.tickValueMicros;
    return {
      position: {
        ...position,
        qty: position.qty + fill.signedQty,
        costBasisMicros: position.costBasisMicros + added,
        feesMicros: position.feesMicros + fill.feesMicros,
        openedAt: opening ? fill.exchangeTs : position.openedAt,
        updatedAt: fill.exchangeTs,
      },
      grossRealizedMicros: 0,
      closedLots: [],
      reversed: false,
    };
  }

  // --- reducing, closing, or reversing ------------------------------------
  const openQty = Math.abs(position.qty);
  const fillQty = Math.abs(fill.signedQty);
  const closedQty = Math.min(openQty, fillQty);
  const direction = Math.sign(position.qty); // +1 long, -1 short

  // Portion of the cost basis being retired. On a FULL close this is the whole
  // basis exactly, so a completed round-trip carries no rounding residue.
  const signedClosed = closedQty * direction;
  const costBasisClosed =
    closedQty === openQty
      ? position.costBasisMicros
      : Math.round((position.costBasisMicros * signedClosed) / position.qty);

  const proceeds = fill.priceTicks * -signedClosed * spec.tickValueMicros;
  // proceeds is what we receive for removing signedClosed from the position;
  // removing +1 of a long is a sale, hence the negation.
  const grossRealized = -proceeds - costBasisClosed;

  const entryTicksOfLot = costBasisClosed / (signedClosed * spec.tickValueMicros);
  const closedLot: ClosedLot = {
    symbol: position.symbol,
    side: direction > 0 ? 'LONG' : 'SHORT',
    qty: closedQty,
    entryTicks: entryTicksOfLot,
    exitTicks: fill.priceTicks,
    grossPnlMicros: grossRealized,
    openedAt: position.openedAt,
    closedAt: fill.exchangeTs,
  };

  const remainingQty = position.qty - signedClosed;
  const remainingBasis = position.costBasisMicros - costBasisClosed;

  // Straight reduction or exact close.
  if (fillQty <= openQty) {
    const nowFlat = remainingQty === 0;
    return {
      position: {
        ...position,
        qty: remainingQty,
        // Guard against a residual basis surviving a flat position.
        costBasisMicros: nowFlat ? 0 : remainingBasis,
        realizedPnlMicros: position.realizedPnlMicros + grossRealized,
        feesMicros: position.feesMicros + fill.feesMicros,
        openedAt: nowFlat ? null : position.openedAt,
        updatedAt: fill.exchangeTs,
      },
      grossRealizedMicros: grossRealized,
      closedLots: [closedLot],
      reversed: false,
    };
  }

  // Reversal: the close consumed the old position, the surplus opens a new one
  // in the opposite direction at the same price.
  const surplus = fill.signedQty + signedClosed; // signed, in the new direction
  return {
    position: {
      ...position,
      qty: surplus,
      costBasisMicros: fill.priceTicks * surplus * spec.tickValueMicros,
      realizedPnlMicros: position.realizedPnlMicros + grossRealized,
      feesMicros: position.feesMicros + fill.feesMicros,
      openedAt: fill.exchangeTs,
      updatedAt: fill.exchangeTs,
    },
    grossRealizedMicros: grossRealized,
    closedLots: [closedLot],
    reversed: true,
  };
}

/** The signed quantity that would flatten a position. */
export function flattenQty(position: PositionState): number {
  return -position.qty;
}

/** The signed quantity that would reverse a position to the same size. */
export function reverseQty(position: PositionState): number {
  return -2 * position.qty;
}
