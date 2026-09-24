/**
 * Order price / bracket-offset → ticks conversion.
 *
 * Shared by the trading route and the copy-trading orchestrator so a copied
 * order is converted to engine ticks EXACTLY as a directly-submitted one is —
 * one source of truth, no drift. Bracket offsets in DOLLARS depend on quantity,
 * so `offsetToTicks` takes the (per-account) qty; copy trading recomputes it per
 * follower to preserve the intended distance.
 */
import {
  microsToTicks,
  priceToTicks,
  requireInstrument,
  ticksPerPoint,
  MICROS,
} from '@atlas/instruments';

export type OffsetUnit = 'TICKS' | 'POINTS' | 'DOLLARS';
export interface LevelOffset {
  readonly unit: OffsetUnit;
  readonly value: number;
}

type Spec = ReturnType<typeof requireInstrument>;

/** A decimal price → ticks; null/undefined passes through as null. */
export function toTicks(spec: Spec, price: number | null | undefined): number | null {
  if (price === null || price === undefined) return null;
  return priceToTicks(spec, price);
}

/** A bracket offset (ticks / points / dollars) → ticks for the given quantity. */
export function offsetToTicks(spec: Spec, offset: LevelOffset | null | undefined, qty: number): number | null {
  if (!offset) return null;
  switch (offset.unit) {
    case 'TICKS':
      return Math.max(1, Math.round(offset.value));
    case 'POINTS':
      return Math.max(1, Math.round(offset.value * ticksPerPoint(spec)));
    case 'DOLLARS': {
      const ticks = microsToTicks(spec, Math.round(offset.value * MICROS), qty);
      return ticks > 0 ? ticks : null;
    }
  }
}
