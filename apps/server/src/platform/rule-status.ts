/**
 * Rule status — the deterministic, centralized thresholds the portal shows for a
 * trading account (docs/account-lifecycle-ux-v1.md §2). One module owns the
 * bands, so what a trader sees and what the engine enforces can never diverge and
 * no warning is invented without a documented threshold. Pure; money is micros.
 *
 * Never communicated by color alone: each band carries an explicit label and a
 * stable token the UI pairs with an icon and text.
 */

export type StatusBand = 'SAFE' | 'APPROACHING' | 'AT_RISK' | 'BREACHED';

export interface DrawdownStatus {
  balanceMicros: number;
  floorMicros: number;
  /** balance − floor; the room before the Maximum Loss Limit. Never below 0 shown. */
  headroomMicros: number;
  /** headroom as a fraction of the full MLL distance (starting − floor). Null if unknown. */
  headroomFraction: number | null;
  band: StatusBand;
}

/**
 * Drawdown band from headroom relative to the account's full MLL distance:
 *   Safe        headroom > 25% of the MLL distance
 *   Approaching 10%–25%
 *   At Risk     < 10% (but > 0)
 *   Breached    headroom ≤ 0
 * The MLL distance is (startingBalance − floor); when it is unknown or zero we
 * still classify Breached at/under the floor and Safe otherwise, but report a
 * null fraction rather than fabricate one.
 */
export function drawdownStatus(
  balanceMicros: number,
  floorMicros: number,
  startingBalanceMicros: number,
): DrawdownStatus {
  const headroom = balanceMicros - floorMicros;
  const mllDistance = startingBalanceMicros - floorMicros;
  const fraction = mllDistance > 0 ? headroom / mllDistance : null;
  let band: StatusBand;
  if (headroom <= 0) band = 'BREACHED';
  else if (fraction === null) band = 'SAFE';
  else if (fraction < 0.1) band = 'AT_RISK';
  else if (fraction < 0.25) band = 'APPROACHING';
  else band = 'SAFE';
  return {
    balanceMicros,
    floorMicros,
    headroomMicros: Math.max(0, headroom),
    headroomFraction: fraction,
    band,
  };
}

export interface ConsistencyStatus {
  /** best single day / total profit; null when total profit ≤ 0 (undefined). */
  ratio: number | null;
  /** The product's max allowed best-day share, if the product sets one. */
  thresholdFraction: number | null;
  /** true only when a threshold exists and the ratio is within it. */
  withinThreshold: boolean | null;
}

/**
 * Consistency = best-day profit / total profit, compared to the product's
 * threshold. Null ratio when there is no positive total profit yet (nothing to
 * be consistent about); null threshold when the product does not constrain it.
 */
export function consistencyStatus(
  bestDayProfitMicros: number,
  totalProfitMicros: number,
  thresholdFraction: number | null,
): ConsistencyStatus {
  const ratio = totalProfitMicros > 0 ? bestDayProfitMicros / totalProfitMicros : null;
  const withinThreshold =
    thresholdFraction === null || ratio === null ? null : ratio <= thresholdFraction;
  return { ratio, thresholdFraction, withinThreshold };
}
