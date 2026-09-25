/*
 * Happy Trader Funding — the AUTHORITATIVE product model (single source of truth).
 *
 * Phase 3 (Authoritative Product Model + Seed Reconciliation). This module is the
 * ONE place that turns the commercial catalog (FAMILIES / ALL_ACCOUNTS in
 * product-catalog.ts) into the exact persisted product configuration the runtime
 * consumes: the rule config the engine enforces, the payout policy the payout
 * engine reads, the display price checkout shows, and the funded destination a
 * pass provisions.
 *
 * Before Phase 3 the DB seed re-derived these numbers with its own formulas
 * (`0.06 * size`, `0.04 * size`, STATIC drawdown, a size-bucketed maxContracts),
 * which silently diverged from the catalog and the public site. Now the seed, the
 * reconciliation, the economics engine and the parity tests all build their
 * product definition from THIS module, so a Happy Trader product means exactly one
 * thing everywhere.
 *
 * This module contains NO server or database dependency: it emits plain data. The
 * server validates that data through `profileConfigSchema` / `payoutPolicySchema`,
 * and a parity test asserts the emitted config round-trips those schemas — that is
 * the single validator link, so the emitted shape can never drift from the schema
 * the runtime enforces.
 */
import {
  ACTIVATION_FEE_USD,
  ALL_ACCOUNTS,
  FAMILIES,
  MIN_PAYOUT_REQUEST_USD,
  REQUIRED_WINNING_DAYS,
  WINNING_DAY_THRESHOLD_USD,
  payoutCapUsd,
  type AccountConfig,
  type FamilyKey,
} from './product-catalog.js';

/** Micro-dollars per dollar. Money is integer micro-dollars everywhere. */
export const MICROS = 1_000_000;

/**
 * The drawdown model for every ACTIVE Happy Trader V1 evaluation and funded
 * product. Confirmed by the launch spec: end-of-day trailing, never STATIC. The
 * floor ratchets only at the finalized day roll and never moves backward (see
 * packages/core rules `advanceDrawdown`).
 */
export const EVAL_DRAWDOWN_TYPE = 'EOD_TRAILING' as const;

/**
 * Contract-limit equivalence: 10 micro contracts count as 1 mini. The commercial
 * representation is minis/micros; the runtime enforces a single mini-equivalent
 * cap (`maxContracts` = minis) with `microsCountAsFraction` true, so a micro
 * weighs 1/10 (see @atlas/instruments `contractWeight`). Every catalog account
 * satisfies `micros === minis * MICROS_PER_MINI`; `assertContractLimitInvariant`
 * enforces that at module load so the two representations can never disagree.
 */
export const MICROS_PER_MINI = 10;

/**
 * The maximum number of PAID payout cycles across the funded lifecycle. A global
 * constant (also `MAX_PAYOUT_CYCLES` in the server payout core); after the 5th
 * PAID cycle the account becomes COMPLETED. Failed/rejected/cancelled requests do
 * not count.
 */
export const MAX_PAID_PAYOUT_CYCLES = 5;

/**
 * EOD-trailing lock threshold, in micro-dollars above the starting balance, where
 * the trailing floor stops following the high-water mark. null = the floor trails
 * to the high-water mark for the life of the account (the literal reading of the
 * locked spec, which states an EOD trailing drawdown amount and no lock point).
 *
 * NOTE (DECISION REQUIRED, see docs/company/DECISION_LOG.md DR-11): whether a
 * launch product should instead lock the trailing floor once the account is up by
 * the drawdown amount (a common industry convention) is NOT established by the
 * locked spec. null is used as the faithful, fail-safe reading (the floor keeps
 * trailing, which is stricter for the firm's risk); it is not invented policy and
 * is flagged for an explicit owner decision.
 */
export const EVAL_TRAILING_LOCK_AT_MICROS: number | null = null;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Stable machine key for a commercial evaluation product, e.g. `htf-core-50k`. */
export function htfEvalKey(family: FamilyKey, account: AccountConfig): string {
  return `htf-${family.toLowerCase()}-${sizeK(account)}k`;
}

/** Stable machine key for the funded destination, e.g. `htf-core-50k-funded`. */
export function htfFundedKey(family: FamilyKey, account: AccountConfig): string {
  return `${htfEvalKey(family, account)}-funded`;
}

/** Account size in thousands (25, 50, 100, 300). */
export function sizeK(account: AccountConfig): number {
  return account.sizeUsd / 1000;
}

function label(family: FamilyKey, account: AccountConfig): string {
  const proper = family.charAt(0) + family.slice(1).toLowerCase();
  // The flagship 300K Core carries the Gold name; every other product is plain.
  return family === 'CORE' && account.gold ? 'Core Gold' : proper;
}

// ---------------------------------------------------------------------------
// Config shapes (plain data; validated by the server's zod schemas)
// ---------------------------------------------------------------------------

export interface HtfRuleConfig {
  readonly accountSizeMicros: number;
  readonly profitTargetMicros: number;
  readonly maxLossMicros: number;
  readonly drawdownType: 'STATIC' | 'INTRADAY_TRAILING' | 'EOD_TRAILING';
  readonly trailingLockAtMicros: number | null;
  readonly dailyLossLimitMicros: number | null;
  readonly dailyLossPolicy: 'LOCK_DAY' | 'FAIL';
  readonly consistencyFormula: 'BEST_DAY_OVER_TOTAL' | 'BEST_DAY_OVER_TARGET';
  readonly consistencyThreshold: number | null;
  readonly minTradingDays: number;
  readonly minWinningDays: number;
  readonly maxTradingDays: number | null;
  readonly minDailyPnlToCountMicros: number;
  readonly minWinningDayPnlMicros: number;
  readonly maxContracts: number;
  readonly microsCountAsFraction: boolean;
  readonly flattenOnBreach: boolean;
}

export interface HtfPayoutRules {
  readonly model: FamilyKey;
  readonly profitSplitPercent: number;
  readonly activationFeeMicros: number;
  readonly winningDayThresholdMicros: number;
  readonly requiredWinningDays: number;
  readonly payoutConsistencyThreshold: number | null;
  readonly fundedBufferMicros: number;
  readonly requestCaps: { readonly minRequestMicros: number; readonly maxRequestMicrosByOrdinal: number[] };
}

export interface HtfProfileConfig {
  readonly rules: HtfRuleConfig;
  readonly execution: null;
  readonly instruments: { allowed: null; maxContracts: null; perInstrument: Record<string, number> };
  readonly display: { startingBalanceMicros: number; priceMicros?: number };
  readonly payoutRules: HtfPayoutRules;
  readonly fundedDestinationKey: string | null;
  readonly whopPlanId: string | null;
}

export interface HtfProfile {
  readonly key: string;
  readonly name: string;
  readonly accountType: 'EVALUATION' | 'FUNDED_SIM';
  /** The commercial catalog family. */
  readonly family: FamilyKey;
  /** true for the 10 commercial evaluation products; false for funded destinations. */
  readonly commercial: boolean;
  readonly config: HtfProfileConfig;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Family consistency percentages, read once from the catalog. The dependency
 * direction is one-way: product-catalog -> product-model (the catalog never
 * imports from here).
 */
const FAMILY_PCT: Record<FamilyKey, { eval: number; funded: number | null }> = Object.fromEntries(
  FAMILIES.map((fam) => [fam.key, { eval: fam.evalConsistencyPct, funded: fam.fundedConsistencyPct }]),
) as Record<FamilyKey, { eval: number; funded: number | null }>;

/** Evaluation consistency threshold as a fraction (0.5 / 0.4). */
function evalConsistency(family: FamilyKey): number {
  return FAMILY_PCT[family].eval / 100;
}

/** Funded/payout consistency threshold as a fraction, or null. */
function fundedConsistency(family: FamilyKey): number | null {
  const pct = FAMILY_PCT[family].funded;
  return pct === null ? null : pct / 100;
}

function ruleConfig(account: AccountConfig, family: FamilyKey, opts: { funded: boolean }): HtfRuleConfig {
  return {
    accountSizeMicros: account.sizeUsd * MICROS,
    // Funded destinations have no profit target (the evaluation is already passed).
    profitTargetMicros: opts.funded ? 0 : account.targetUsd * MICROS,
    maxLossMicros: account.eodDrawdownUsd * MICROS,
    drawdownType: EVAL_DRAWDOWN_TYPE,
    trailingLockAtMicros: EVAL_TRAILING_LOCK_AT_MICROS,
    // No daily loss limit on any Happy Trader V1 family (the Daily family's
    // discipline is the payout buffer + balance progression, not a daily stop).
    dailyLossLimitMicros: null,
    dailyLossPolicy: 'LOCK_DAY',
    consistencyFormula: 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: evalConsistency(family),
    minTradingDays: 0,
    minWinningDays: 0,
    maxTradingDays: null,
    minDailyPnlToCountMicros: 0,
    minWinningDayPnlMicros: WINNING_DAY_THRESHOLD_USD * MICROS,
    // Contract limit: minis are the mini-equivalent cap; micros count as 1/10.
    maxContracts: account.minis,
    microsCountAsFraction: true,
    flattenOnBreach: true,
  };
}

function payoutRules(account: AccountConfig, family: FamilyKey): HtfPayoutRules {
  return {
    model: family,
    profitSplitPercent: 0.9,
    activationFeeMicros: ACTIVATION_FEE_USD * MICROS,
    winningDayThresholdMicros: WINNING_DAY_THRESHOLD_USD * MICROS,
    requiredWinningDays: REQUIRED_WINNING_DAYS,
    payoutConsistencyThreshold: fundedConsistency(family),
    fundedBufferMicros: (account.bufferUsd ?? 0) * MICROS,
    requestCaps: {
      minRequestMicros: MIN_PAYOUT_REQUEST_USD * MICROS,
      maxRequestMicrosByOrdinal: [payoutCapUsd(account.sizeUsd) * MICROS],
    },
  };
}

/** The commercial evaluation profile for a catalog account. */
export function buildEvalProfile(family: FamilyKey, account: AccountConfig): HtfProfile {
  const key = htfEvalKey(family, account);
  return {
    key,
    name: `HTF ${label(family, account)} ${sizeK(account)}K`,
    accountType: 'EVALUATION',
    family,
    commercial: true,
    config: {
      rules: ruleConfig(account, family, { funded: false }),
      execution: null,
      instruments: { allowed: null, maxContracts: null, perInstrument: {} },
      display: { startingBalanceMicros: account.sizeUsd * MICROS, priceMicros: account.priceUsd * MICROS },
      payoutRules: payoutRules(account, family),
      fundedDestinationKey: htfFundedKey(family, account),
      whopPlanId: `plan_${key.replace(/-/g, '_')}`,
    },
  };
}

/** The funded destination profile a pass provisions. Internal, never sold. */
export function buildFundedProfile(family: FamilyKey, account: AccountConfig): HtfProfile {
  return {
    key: htfFundedKey(family, account),
    name: `HTF ${label(family, account)} ${sizeK(account)}K (Funded)`,
    accountType: 'FUNDED_SIM',
    family,
    commercial: false,
    config: {
      rules: ruleConfig(account, family, { funded: true }),
      execution: null,
      instruments: { allowed: null, maxContracts: null, perInstrument: {} },
      display: { startingBalanceMicros: account.sizeUsd * MICROS },
      payoutRules: payoutRules(account, family),
      fundedDestinationKey: null,
      whopPlanId: null,
    },
  };
}

/** The 10 commercial evaluation products, cheapest first. */
export function htfEvalProfiles(): HtfProfile[] {
  return ALL_ACCOUNTS.map((a) => buildEvalProfile(a.family, a));
}

/** The 10 funded destination profiles. */
export function htfFundedProfiles(): HtfProfile[] {
  return ALL_ACCOUNTS.map((a) => buildFundedProfile(a.family, a));
}

/** Every Happy Trader profile the runtime should carry: 10 eval + 10 funded. */
export function htfAllProfiles(): HtfProfile[] {
  return [...htfEvalProfiles(), ...htfFundedProfiles()];
}

/** The machine keys of the legacy Atlas templates that must be RETIRED (never deleted). */
export const LEGACY_RETIRED_KEYS: readonly string[] = [
  'evaluation-50k',
  'evaluation-100k',
  'evaluation-150k',
  'intraday-trailing-50k',
  'static-100k',
  'practice-100k',
];

/**
 * The internal practice profile key retained for the terminal's default practice
 * account (`registerDefaultPractice` and dev seeds provision it). PRACTICE type,
 * status INTERNAL — never a commercial product.
 */
export const INTERNAL_PRACTICE_KEY = 'practice-150k';

// ---------------------------------------------------------------------------
// Invariants (enforced at module load, so a bad edit fails loudly)
// ---------------------------------------------------------------------------

/** Every account's micros count must be exactly minis × MICROS_PER_MINI. */
export function assertContractLimitInvariant(): void {
  for (const a of ALL_ACCOUNTS) {
    if (a.micros !== a.minis * MICROS_PER_MINI) {
      throw new Error(
        `Contract-limit invariant violated for ${a.family} ${a.size}: ` +
          `${a.micros} micros != ${a.minis} minis × ${MICROS_PER_MINI}.`,
      );
    }
  }
}

assertContractLimitInvariant();
