/**
 * The payout engine's pure arithmetic — no database, no clock, no I/O.
 *
 * Every money decision a payout makes is a function of authoritative inputs the
 * caller reads (account balances, per-day stats, the pinned product policy) and
 * nothing else. Keeping it pure makes it exhaustively unit-testable and lets the
 * DB-bound service AND the economics simulator share the exact same accounting,
 * so a simulated payout and a real one can never diverge in their maths.
 *
 * Money is integer micro-dollars throughout. Never a float.
 */
import { z } from 'zod';

export const MICROS = 1_000_000;

export type PayoutModel = 'CORE' | 'SELECT' | 'DAILY';

/**
 * The payout terms of ONE immutable product version.
 *
 * Stored opaquely in `account_profile_versions.config.payoutRules` and pinned to
 * an account for its life. Nothing here is hard-coded in logic; the machine
 * reads this policy from the account's pinned version.
 */
export const payoutPolicySchema = z.object({
  model: z.enum(['CORE', 'SELECT', 'DAILY']),
  /** 0.90 = 90% of the gross goes to the trader. */
  profitSplitPercent: z.number().min(0).max(1),
  activationFeeMicros: z.number().int().nonnegative().default(0),
  /** A day is a WINNING day when its net realized P&L reaches this. */
  winningDayThresholdMicros: z.number().int().nonnegative().default(150 * MICROS),
  requiredWinningDays: z.number().int().nonnegative().default(5),
  /**
   * Consistency gate for PAYOUT eligibility (best day / total net). null = none.
   * Distinct from evaluation consistency (which lives in the rule config).
   * Select uses 0.40; Core/Daily leave it null.
   */
  payoutConsistencyThreshold: z.number().min(0.01).max(1).nullable().default(null),
  /** DAILY only: profit that must remain in the account, never withdrawable. */
  fundedBufferMicros: z.number().int().nonnegative().default(0),
  requestCaps: z.object({
    minRequestMicros: z.number().int().nonnegative(),
    /**
     * Progressive maxima by 1-based payout ordinal; the LAST entry applies to
     * every payout at or beyond its index (the "established trader" cap). A
     * single-element array is a flat cap.
     */
    maxRequestMicrosByOrdinal: z.array(z.number().int().positive()).min(1),
  }),
});

export type PayoutPolicy = z.infer<typeof payoutPolicySchema>;

export function parsePayoutPolicy(raw: unknown): PayoutPolicy {
  return payoutPolicySchema.parse(raw);
}

/** Machine-readable eligibility reasons — never vague strings in business logic. */
export type PayoutReasonCode =
  | 'ELIGIBLE'
  | 'INSUFFICIENT_WINNING_DAYS'
  | 'CONSISTENCY_NOT_MET'
  | 'BUFFER_NOT_MET'
  | 'BELOW_MINIMUM'
  | 'ABOVE_MAXIMUM'
  | 'INSUFFICIENT_WITHDRAWABLE_PROFIT'
  | 'ACCOUNT_FAILED'
  | 'ACCOUNT_LOCKED'
  | 'RISK_HOLD'
  | 'FRAUD_HOLD'
  | 'MANUAL_REVIEW'
  | 'ALREADY_PENDING';

/** One finalized trading day for an account. `netMicros = ending - starting`. */
export interface DayStat {
  readonly tradeDate: string; // YYYY-MM-DD
  readonly netMicros: number;
}

/**
 * Banker's rounding (round half to even) for the split. The firm share is the
 * exact complement of the trader share, so the two ALWAYS reconcile to the gross
 * with zero drift — the rounding remainder is absorbed by the firm, never lost.
 */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

export interface SplitAccounting {
  readonly grossEligibleMicros: number;
  readonly traderShareMicros: number;
  readonly firmShareMicros: number;
  readonly balanceAdjustmentMicros: number;
  readonly feesMicros: number;
  readonly actualPayoutMicros: number;
}

/**
 * Split a gross payout into the trader's share and the firm's, exactly.
 *
 * The FULL gross leaves the account balance (the firm's share is the firm's
 * revenue, not a balance the trader keeps). The trader receives their share.
 */
export function splitAccounting(grossEligibleMicros: number, profitSplitPercent: number): SplitAccounting {
  if (grossEligibleMicros < 0) throw new Error('gross cannot be negative');
  const traderShareMicros = roundHalfEven(grossEligibleMicros * profitSplitPercent);
  const firmShareMicros = grossEligibleMicros - traderShareMicros; // exact complement
  return {
    grossEligibleMicros,
    traderShareMicros,
    firmShareMicros,
    balanceAdjustmentMicros: grossEligibleMicros,
    feesMicros: 0,
    actualPayoutMicros: traderShareMicros,
  };
}

/** Total net profit on a funded account. May be zero or negative. */
export function totalNetProfitMicros(balanceMicros: number, startingBalanceMicros: number): number {
  return balanceMicros - startingBalanceMicros;
}

/** Gross withdrawable: profit above the protected buffer, floored at zero. */
export function grossWithdrawableMicros(
  balanceMicros: number,
  startingBalanceMicros: number,
  protectedMicros: number,
): number {
  return Math.max(0, totalNetProfitMicros(balanceMicros, startingBalanceMicros) - protectedMicros);
}

/** The max-request cap for a given 1-based payout ordinal (progressive-aware). */
export function capForOrdinal(policy: PayoutPolicy, ordinal: number): number {
  const caps = policy.requestCaps.maxRequestMicrosByOrdinal;
  const index = Math.max(0, Math.min(ordinal - 1, caps.length - 1));
  return caps[index]!;
}

/** Qualifying winning days strictly after the cycle-start date. */
export function countQualifyingWinningDays(
  days: readonly DayStat[],
  cycleStartDate: string | null,
  thresholdMicros: number,
): number {
  return days.filter(
    (d) => d.netMicros >= thresholdMicros && (cycleStartDate === null || d.tradeDate > cycleStartDate),
  ).length;
}

export function bestDayMicros(days: readonly DayStat[]): number {
  return days.reduce((best, d) => Math.max(best, d.netMicros), 0);
}

/** best day / total net. null when there is no positive profit to divide by. */
export function consistencyRatio(bestDay: number, totalNet: number): number | null {
  if (totalNet <= 0) return null;
  return bestDay / totalNet;
}

export interface EligibilityInput {
  readonly policy: PayoutPolicy;
  readonly balanceMicros: number;
  readonly startingBalanceMicros: number;
  /** Finalized days for the funded account (whole life). */
  readonly days: readonly DayStat[];
  /** Start boundary of the current cycle (exclusive). null = account start. */
  readonly cycleStartDate: string | null;
  /** DAILY: whether daily-mode has already been unlocked on this cycle. */
  readonly dailyModeUnlocked: boolean;
  /** accounts.status — FAILED/LOCKED short-circuit. */
  readonly accountStatus: string;
  /** accounts.adminHold — LOCKED/DISABLED/ARCHIVED short-circuit. */
  readonly adminHold: string | null;
  /** An operator hold on the payout aggregate/account, if any. */
  readonly hold: 'RISK' | 'FRAUD' | 'MANUAL' | null;
  /** A non-terminal request already exists for this account. */
  readonly hasPendingRequest: boolean;
}

export interface PayoutEligibility {
  readonly state: 'ELIGIBLE' | 'NOT_ELIGIBLE';
  readonly reasonCodes: PayoutReasonCode[];
  readonly grossWithdrawableMicros: number;
  readonly qualifyingWinningDays: number;
  readonly bestDayMicros: number;
  readonly consistencyRatio: number | null;
  readonly bufferEstablished: boolean;
  /** Whether daily-mode is (now) unlocked, for DAILY. */
  readonly dailyModeUnlocked: boolean;
  readonly minRequestMicros: number;
  readonly maxRequestMicros: number;
}

/**
 * The whole eligibility decision, as a pure function of authoritative inputs.
 *
 * Never fails an account for being ineligible — it reports every reason so the
 * trader sees them all. The service re-runs this inside the approval lock; it is
 * never trusted from a stale read.
 */
export function evaluatePayoutEligibility(
  input: EligibilityInput,
  nextOrdinal: number,
): PayoutEligibility {
  const { policy } = input;
  const protectedMicros = policy.fundedBufferMicros;
  const withdrawable = grossWithdrawableMicros(
    input.balanceMicros,
    input.startingBalanceMicros,
    protectedMicros,
  );
  const winDays = countQualifyingWinningDays(
    input.days,
    input.cycleStartDate,
    policy.winningDayThresholdMicros,
  );
  const best = bestDayMicros(input.days);
  const totalNet = totalNetProfitMicros(input.balanceMicros, input.startingBalanceMicros);
  const consistency = consistencyRatio(best, totalNet);
  // A zero buffer is always "established"; otherwise the account's profit must
  // have reached the buffer at least once (measured on current total net).
  const bufferEstablished =
    policy.fundedBufferMicros === 0 || totalNet >= policy.fundedBufferMicros;
  const minReq = policy.requestCaps.minRequestMicros;
  const maxReq = capForOrdinal(policy, nextOrdinal);

  const reasons: PayoutReasonCode[] = [];

  // Account-level blocks first — they override everything.
  if (input.accountStatus === 'FAILED') reasons.push('ACCOUNT_FAILED');
  if (input.accountStatus === 'LOCKED' || input.adminHold === 'LOCKED' || input.adminHold === 'DISABLED' || input.adminHold === 'ARCHIVED') {
    reasons.push('ACCOUNT_LOCKED');
  }
  if (input.hold === 'RISK') reasons.push('RISK_HOLD');
  if (input.hold === 'FRAUD') reasons.push('FRAUD_HOLD');
  if (input.hold === 'MANUAL') reasons.push('MANUAL_REVIEW');
  if (input.hasPendingRequest) reasons.push('ALREADY_PENDING');

  // Model gates.
  const dailyUnlockedNow =
    policy.model === 'DAILY'
      ? input.dailyModeUnlocked || (winDays >= policy.requiredWinningDays && bufferEstablished)
      : false;

  if (policy.model === 'DAILY') {
    if (!dailyUnlockedNow) {
      if (winDays < policy.requiredWinningDays) reasons.push('INSUFFICIENT_WINNING_DAYS');
      if (!bufferEstablished) reasons.push('BUFFER_NOT_MET');
    }
  } else {
    if (winDays < policy.requiredWinningDays) reasons.push('INSUFFICIENT_WINNING_DAYS');
    if (policy.payoutConsistencyThreshold !== null) {
      // Consistency only blocks once there is profit to measure; with no profit
      // the withdrawable gate already stops the payout.
      if (consistency !== null && consistency > policy.payoutConsistencyThreshold) {
        reasons.push('CONSISTENCY_NOT_MET');
      }
    }
  }

  // Money gate: can the trader even meet the minimum request?
  if (withdrawable < minReq) reasons.push('INSUFFICIENT_WITHDRAWABLE_PROFIT');

  const eligible = reasons.length === 0;
  return {
    state: eligible ? 'ELIGIBLE' : 'NOT_ELIGIBLE',
    reasonCodes: eligible ? ['ELIGIBLE'] : reasons,
    grossWithdrawableMicros: withdrawable,
    qualifyingWinningDays: winDays,
    bestDayMicros: best,
    consistencyRatio: consistency,
    bufferEstablished,
    dailyModeUnlocked: dailyUnlockedNow,
    minRequestMicros: minReq,
    maxRequestMicros: maxReq,
  };
}

export type PayoutResolution =
  | { readonly ok: true; readonly accounting: SplitAccounting; readonly balanceAfterMicros: number }
  | { readonly ok: false; readonly reason: PayoutReasonCode };

/**
 * Resolve a concrete request amount against eligibility into the exact
 * accounting, or a rejection reason. Never returns a gross above what is
 * permitted; the caller applies the returned balance adjustment atomically.
 */
export function resolvePayoutRequest(
  eligibility: PayoutEligibility,
  policy: PayoutPolicy,
  requestedGrossMicros: number,
  balanceMicros: number,
): PayoutResolution {
  if (eligibility.state !== 'ELIGIBLE') {
    return { ok: false, reason: eligibility.reasonCodes[0] ?? 'INSUFFICIENT_WITHDRAWABLE_PROFIT' };
  }
  if (requestedGrossMicros < eligibility.minRequestMicros) return { ok: false, reason: 'BELOW_MINIMUM' };
  if (requestedGrossMicros > eligibility.maxRequestMicros) return { ok: false, reason: 'ABOVE_MAXIMUM' };
  if (requestedGrossMicros > eligibility.grossWithdrawableMicros) {
    return { ok: false, reason: 'INSUFFICIENT_WITHDRAWABLE_PROFIT' };
  }
  const accounting = splitAccounting(requestedGrossMicros, policy.profitSplitPercent);
  return { ok: true, accounting, balanceAfterMicros: balanceMicros - accounting.balanceAdjustmentMicros };
}
