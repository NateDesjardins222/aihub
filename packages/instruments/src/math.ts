/**
 * Instrument-aware price and money arithmetic.
 *
 * Every function here takes an InstrumentSpec. There is deliberately no default
 * tick size and no default tick value anywhere in the codebase.
 */
import type { InstrumentSpec } from '@atlas/contracts';

/** Micro-dollars per dollar. All money in the system is an integer of these. */
export const MICROS = 1_000_000;

export function dollarsToMicros(dollars: number): number {
  return Math.round(dollars * MICROS);
}

export function microsToDollars(micros: number): number {
  return micros / MICROS;
}

/** 10 ** pricePrecision — the integer scale a decimal price is expressed in. */
export function priceScale(spec: InstrumentSpec): number {
  return 10 ** spec.pricePrecision;
}

/** Decimal tick size, e.g. 0.25 for NQ. For display and vendor interop only. */
export function tickSize(spec: InstrumentSpec): number {
  return spec.tickSizeScaled / priceScale(spec);
}

/**
 * Convert a decimal price to integer ticks, rounding to the nearest valid tick.
 * Rounding is half-away-from-zero so that snapping is symmetric around zero.
 */
export function priceToTicks(spec: InstrumentSpec, price: number): number {
  const scaled = Math.round(price * priceScale(spec));
  return Math.round(scaled / spec.tickSizeScaled);
}

/** Convert integer ticks back to a decimal price. Exact for all listed products. */
export function ticksToPrice(spec: InstrumentSpec, ticks: number): number {
  return (ticks * spec.tickSizeScaled) / priceScale(spec);
}

/** True when a decimal price lands exactly on a valid tick boundary. */
export function isValidTickPrice(spec: InstrumentSpec, price: number): boolean {
  const scaled = Math.round(price * priceScale(spec));
  // Guard against a price with more decimals than the instrument supports.
  if (Math.abs(price * priceScale(spec) - scaled) > 1e-6) return false;
  return scaled % spec.tickSizeScaled === 0;
}

/** Snap an arbitrary price to the nearest tick, returning a decimal price. */
export function snapPrice(spec: InstrumentSpec, price: number): number {
  return ticksToPrice(spec, priceToTicks(spec, price));
}

export function formatPrice(spec: InstrumentSpec, price: number): string {
  return price.toFixed(spec.pricePrecision);
}

export function formatTicks(spec: InstrumentSpec, ticks: number): string {
  return formatPrice(spec, ticksToPrice(spec, ticks));
}

/**
 * Dollar value, in micro-dollars, of a tick movement for a given quantity.
 * This is the single function every P&L path must go through.
 */
export function ticksToMicros(spec: InstrumentSpec, ticks: number, qty: number): number {
  return ticks * qty * spec.tickValueMicros;
}

/** Dollar value in micro-dollars of a movement expressed in full points. */
export function pointsToMicros(spec: InstrumentSpec, points: number, qty: number): number {
  return Math.round(points * qty * spec.pointValueMicros);
}

/** How many ticks a given dollar risk corresponds to, for a quantity. Floors. */
export function microsToTicks(spec: InstrumentSpec, micros: number, qty: number): number {
  if (qty <= 0) return 0;
  return Math.floor(micros / (qty * spec.tickValueMicros));
}

/** Ticks in one full point of price movement. */
export function ticksPerPoint(spec: InstrumentSpec): number {
  return priceScale(spec) / spec.tickSizeScaled;
}

/** Round-turn cost (both sides) for a quantity, micro-dollars. */
export function roundTurnFeesMicros(spec: InstrumentSpec, qty: number): number {
  return 2 * perSideFeesMicros(spec, qty);
}

/** Commission + exchange fees for one side, micro-dollars. */
export function perSideFeesMicros(spec: InstrumentSpec, qty: number): number {
  return qty * (spec.commissionPerSideMicros + spec.exchangeFeesPerSideMicros);
}

/**
 * Signed P&L in micro-dollars for closing `qty` of a position.
 * `direction` is +1 for a long being closed, -1 for a short being closed.
 */
export function realizedPnlMicros(
  spec: InstrumentSpec,
  entryTicks: number,
  exitTicks: number,
  qty: number,
  direction: 1 | -1,
): number {
  return ticksToMicros(spec, (exitTicks - entryTicks) * direction, qty);
}

/**
 * Contract-limit weight. A prop firm that counts 10 micros as 1 full contract
 * sets `microsCountAsFraction`; otherwise every contract counts as one.
 */
export function contractWeight(spec: InstrumentSpec, qty: number, microsAsFraction: boolean): number {
  if (!microsAsFraction || !spec.isMicro) return qty;
  return qty / 10;
}

export function formatMicros(micros: number, opts?: { sign?: boolean }): string {
  const dollars = micros / MICROS;
  const sign = opts?.sign && dollars > 0 ? '+' : '';
  const abs = Math.abs(dollars);
  const body = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${dollars < 0 ? '-' : sign}$${body}`;
}
