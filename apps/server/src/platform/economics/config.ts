/**
 * Economics engine — configuration seam (M13.0).
 *
 * Two categories of numbers, kept rigorously apart (docs/economics/ASSUMPTIONS.md):
 *
 *   CATEGORY A — AUTHORITATIVE. The real Happy Trader product/payout parameters.
 *     Loaded from the single shared catalog (@atlas/contracts) and the pure payout
 *     engine (payout-core.ts). NEVER a second copy — `loadAuthoritativeProducts()`
 *     derives everything from those sources.
 *
 *   CATEGORY B — ASSUMPTIONS. Trader behaviour, cost and growth inputs. Happy Trader
 *     has not launched at scale, so these are NOT facts: they are explicit, labelled,
 *     versioned, editable inputs. Nothing here is presented as historical data.
 *
 * Money is integer micro-dollars everywhere (the same unit as payout-core).
 */
import { z } from 'zod';
import {
  ACTIVATION_FEE_USD,
  FAMILIES,
  MIN_PAYOUT_REQUEST_USD,
  PROFIT_SPLIT_PCT,
  REQUIRED_WINNING_DAYS,
  WINNING_DAY_THRESHOLD_USD,
  payoutCapUsd,
  bufferUsdOf,
  type FamilyKey,
} from '@atlas/contracts';
import { MAX_PAYOUT_CYCLES, MICROS } from '../payout-core.js';

/**
 * The engine's own version and the model version. Bumped when the engine's maths
 * or the assumption schema change, so a stored run is interpretable forever.
 */
export const ENGINE_VERSION = '13.0.0';
export const MODEL_VERSION = '13.0.0';

const $ = (usd: number): number => Math.round(usd * MICROS);

// ---------------------------------------------------------------------------
// CATEGORY A — authoritative product parameters (derived, never re-typed).
// ---------------------------------------------------------------------------

export interface AuthoritativeProduct {
  /** Stable key, e.g. "core-100k". */
  readonly key: string;
  readonly family: FamilyKey;
  readonly familyName: string;
  /** Size label, e.g. "100K". */
  readonly size: string;
  readonly sizeMicros: number;
  /** One-time evaluation price. */
  readonly priceMicros: number;
  /** Payout request cap for this size (flat per size). */
  readonly payoutCapMicros: number;
  readonly minRequestMicros: number;
  /** Trader profit split as a fraction 0..1 (0.90). */
  readonly profitSplitPercent: number;
  readonly activationFeeMicros: number;
  /** Daily loss buffer (0 for Core/Select). */
  readonly bufferMicros: number;
  readonly gold: boolean;
}

/** Firm-wide authoritative constants surfaced for callers/labels. */
export const AUTHORITATIVE = {
  maxPayoutCycles: MAX_PAYOUT_CYCLES,
  requiredWinningDays: REQUIRED_WINNING_DAYS,
  winningDayThresholdMicros: $(WINNING_DAY_THRESHOLD_USD),
  profitSplitPercent: PROFIT_SPLIT_PCT / 100,
  activationFeeMicros: $(ACTIVATION_FEE_USD),
  minRequestMicros: $(MIN_PAYOUT_REQUEST_USD),
} as const;

/**
 * The authoritative ten products, derived from the shared catalog + payout params.
 * This is the "reuse existing configuration" path; there is no second copy of the
 * numbers here. (When a public DB `/catalog` endpoint exists, a DB-backed loader can
 * replace this while keeping the same shape.)
 */
export function loadAuthoritativeProducts(): AuthoritativeProduct[] {
  const out: AuthoritativeProduct[] = [];
  for (const fam of FAMILIES) {
    for (const a of fam.accounts) {
      out.push({
        key: `${fam.key.toLowerCase()}-${a.size.toLowerCase()}`,
        family: fam.key,
        familyName: fam.name,
        size: a.size,
        sizeMicros: $(a.sizeUsd),
        priceMicros: $(a.priceUsd),
        payoutCapMicros: $(payoutCapUsd(a.sizeUsd)),
        minRequestMicros: $(MIN_PAYOUT_REQUEST_USD),
        profitSplitPercent: PROFIT_SPLIT_PCT / 100,
        activationFeeMicros: $(ACTIVATION_FEE_USD),
        bufferMicros: $(bufferUsdOf(a)),
        gold: a.gold ?? false,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CATEGORY B — assumptions (explicit, editable, versioned; NOT facts).
// ---------------------------------------------------------------------------

export type ArrivalPattern = 'LINEAR' | 'FRONT_LOADED' | 'RAMP' | 'SPIKE';
export type AcquisitionModel = 'ORGANIC' | 'PAID' | 'AFFILIATE' | 'MIXED';

/** A named operating-cost line (fixed monthly and/or variable). */
export interface OperatingCostLine {
  readonly label: string;
  /** Fixed cost per 30-day month, in micros. */
  readonly fixedMonthlyMicros: number;
  /** Variable cost per acquired customer, in micros. */
  readonly perCustomerMicros: number;
  /** Variable cost per payout event, in micros. */
  readonly perPayoutMicros: number;
}

export interface Assumptions {
  /** Free-form label for the assumption set (e.g. "BASE"). */
  readonly label: string;
  /** Relative purchase-mix weight per product key. Missing keys default to 1. */
  readonly productMixWeights: Readonly<Record<string, number>>;

  // ---- funnel (per purchased evaluation) ----
  /** P(evaluation passes). */
  readonly passRate: number;
  /** On a failed evaluation, P(customer buys a reset of the SAME account). */
  readonly resetRateOnFail: number;
  /** On a failed evaluation (no reset), P(customer repurchases a NEW evaluation). */
  readonly repurchaseRateOnFail: number;
  /** Maximum resets a single customer will buy for one failed account. */
  readonly maxResetsPerAccount: number;
  /** Maximum fresh repurchases a single customer will make after churned fails. */
  readonly maxRepurchases: number;
  /** P(a funded account survives to become payout-eligible). */
  readonly fundedSurvivalToPayout: number;
  /** P(an eligible funded account takes a first payout). */
  readonly firstPayoutProb: number;
  /** P(each subsequent payout), geometric, capped by maxPayoutCycles. */
  readonly repeatPayoutProb: number;
  /** Mean payout as a fraction of the ordinal cap (0..1). */
  readonly avgPayoutFractionOfCap: number;
  /** SELECT: fraction of payout attempts delayed by the consistency rule. */
  readonly selectConsistencyBlockRate: number;

  // ---- refunds & chargebacks (per purchase; separate concepts) ----
  readonly refundRate: number;
  readonly chargebackRate: number;
  /** Flat processor/bank fee charged on a chargeback, in micros. */
  readonly chargebackFeeMicros: number;

  // ---- payment processing (ASSUMPTION — not in production config) ----
  /** Processing fee as a fraction of the charged amount. */
  readonly processingPct: number;
  /** Fixed processing fee per transaction, in micros. */
  readonly processingFixedMicros: number;

  // ---- operating costs ----
  readonly operatingCosts: readonly OperatingCostLine[];

  // ---- customer acquisition ----
  readonly acquisitionModel: AcquisitionModel;
  /** Cash acquisition cost per acquired customer, in micros (paid channels). */
  readonly cacPerCustomerMicros: number;

  // ---- affiliate ----
  /** Fraction of customers attributed to an affiliate. */
  readonly affiliatePenetration: number;
  /** Commission rate as a fraction (authoritative default 0.15); editable here. */
  readonly affiliateCommissionRate: number;
  /** Commission maturity hold, in days (authoritative default 14). */
  readonly affiliateMaturityDays: number;
  /** Whether resets generate affiliate commission (authoritative default: false). */
  readonly affiliateCommissionOnResets: boolean;

  // ---- treasury / reserves ----
  /** Coverage multiple applied to outstanding (approved, unpaid) payout liability. */
  readonly payoutLiabilityCoverage: number;
  /** Coverage multiple applied to unpaid affiliate liability. */
  readonly affiliateLiabilityCoverage: number;
  /** Refund/chargeback reserve as a fraction of gross sales. */
  readonly refundReservePct: number;
  /** Operating reserve as a number of months of operating cost. */
  readonly operatingReserveMonths: number;
  /** Tax placeholder as a fraction of positive modeled contribution. */
  readonly taxPlaceholderPct: number;
  /** Safety reserve as a multiple of the Monte-Carlo payout tail (applied elsewhere). */
  readonly safetyReserveMultiplier: number;

  // ---- growth / timing ----
  readonly arrivalPattern: ArrivalPattern;
  /** Days from purchase to the first funded payout event (spread thereafter). */
  readonly firstPayoutLagDays: number;
  /** Days between successive payout events for one account. */
  readonly payoutIntervalDays: number;
  /** Days from an eligible affiliate commission to its cash payout. */
  readonly affiliatePayoutLagDays: number;
  /** Days from a purchase to a refund, when one happens. */
  readonly refundLagDays: number;
  /** Days from a purchase to a chargeback, when one happens. */
  readonly chargebackLagDays: number;
}

/**
 * BASE assumptions. Every value is an explicit, editable planning input — NOT a
 * measured Happy Trader number. The funnel figures reflect broadly-published
 * prop-firm patterns (roughly 1-in-10 evaluations pass, a minority of funded
 * accounts reach a payout). See docs/economics/ASSUMPTIONS.md.
 */
export function defaultAssumptions(): Assumptions {
  return {
    label: 'BASE',
    productMixWeights: {},
    passRate: 0.1,
    resetRateOnFail: 0.25,
    repurchaseRateOnFail: 0.15,
    maxResetsPerAccount: 2,
    maxRepurchases: 2,
    fundedSurvivalToPayout: 0.4,
    firstPayoutProb: 0.5,
    repeatPayoutProb: 0.4,
    avgPayoutFractionOfCap: 0.5,
    selectConsistencyBlockRate: 0.25,
    refundRate: 0.03,
    chargebackRate: 0.01,
    chargebackFeeMicros: $(15),
    processingPct: 0.045,
    processingFixedMicros: $(0.3),
    operatingCosts: [
      { label: 'Market data & execution', fixedMonthlyMicros: $(2_500), perCustomerMicros: $(1.5), perPayoutMicros: 0 },
      { label: 'Hosting, database & storage', fixedMonthlyMicros: $(1_500), perCustomerMicros: $(0.5), perPayoutMicros: 0 },
      { label: 'Email & SMS', fixedMonthlyMicros: $(200), perCustomerMicros: $(0.4), perPayoutMicros: 0 },
      { label: 'Identity / KYC', fixedMonthlyMicros: $(0), perCustomerMicros: $(1.0), perPayoutMicros: 0 },
      { label: 'Support', fixedMonthlyMicros: $(3_000), perCustomerMicros: $(2.0), perPayoutMicros: $(1.0) },
      { label: 'Payout-provider processing', fixedMonthlyMicros: $(0), perCustomerMicros: 0, perPayoutMicros: $(2.0) },
      { label: 'Software / services', fixedMonthlyMicros: $(1_200), perCustomerMicros: 0, perPayoutMicros: 0 },
      { label: 'Legal / compliance (placeholder)', fixedMonthlyMicros: $(1_000), perCustomerMicros: 0, perPayoutMicros: 0 },
    ],
    acquisitionModel: 'MIXED',
    cacPerCustomerMicros: $(12),
    affiliatePenetration: 0.35,
    affiliateCommissionRate: 0.15,
    affiliateMaturityDays: 14,
    affiliateCommissionOnResets: false,
    payoutLiabilityCoverage: 1.0,
    affiliateLiabilityCoverage: 1.0,
    refundReservePct: 0.04,
    operatingReserveMonths: 3,
    taxPlaceholderPct: 0.21,
    safetyReserveMultiplier: 1.0,
    arrivalPattern: 'LINEAR',
    firstPayoutLagDays: 45,
    payoutIntervalDays: 21,
    affiliatePayoutLagDays: 30,
    refundLagDays: 10,
    chargebackLagDays: 40,
  };
}

// ---- validation (for HTTP) -------------------------------------------------

const costLineSchema = z.object({
  label: z.string().min(1).max(80),
  fixedMonthlyMicros: z.number().int().min(0),
  perCustomerMicros: z.number().int().min(0),
  perPayoutMicros: z.number().int().min(0),
});

const frac = z.number().min(0).max(1);

export const assumptionsSchema = z.object({
  label: z.string().min(1).max(60),
  productMixWeights: z.record(z.string(), z.number().min(0)).default({}),
  passRate: frac,
  resetRateOnFail: frac,
  repurchaseRateOnFail: frac,
  maxResetsPerAccount: z.number().int().min(0).max(20),
  maxRepurchases: z.number().int().min(0).max(20),
  fundedSurvivalToPayout: frac,
  firstPayoutProb: frac,
  repeatPayoutProb: frac,
  avgPayoutFractionOfCap: frac,
  selectConsistencyBlockRate: frac,
  refundRate: frac,
  chargebackRate: frac,
  chargebackFeeMicros: z.number().int().min(0),
  processingPct: frac,
  processingFixedMicros: z.number().int().min(0),
  operatingCosts: z.array(costLineSchema).max(40),
  acquisitionModel: z.enum(['ORGANIC', 'PAID', 'AFFILIATE', 'MIXED']),
  cacPerCustomerMicros: z.number().int().min(0),
  affiliatePenetration: frac,
  affiliateCommissionRate: frac,
  affiliateMaturityDays: z.number().int().min(0).max(365),
  affiliateCommissionOnResets: z.boolean(),
  payoutLiabilityCoverage: z.number().min(0).max(10),
  affiliateLiabilityCoverage: z.number().min(0).max(10),
  refundReservePct: frac,
  operatingReserveMonths: z.number().min(0).max(36),
  taxPlaceholderPct: frac,
  safetyReserveMultiplier: z.number().min(0).max(10),
  arrivalPattern: z.enum(['LINEAR', 'FRONT_LOADED', 'RAMP', 'SPIKE']),
  firstPayoutLagDays: z.number().int().min(0).max(3650),
  payoutIntervalDays: z.number().int().min(1).max(3650),
  affiliatePayoutLagDays: z.number().int().min(0).max(3650),
  refundLagDays: z.number().int().min(0).max(3650),
  chargebackLagDays: z.number().int().min(0).max(3650),
}) satisfies z.ZodType<Assumptions>;
