/*
 * Happy Trader Funding — the authoritative product catalog (single source of truth).
 *
 * WHY THIS FILE EXISTS (and why it lives in @atlas/contracts): the CORE / SELECT /
 * DAILY families, their sizes, public prices and payout parameters previously lived
 * only in `apps/web/src/marketing/catalog.ts` (the public site) and, partially and
 * independently, in `apps/server/scripts/seed-htf-products.ts` (the DB seed). Two
 * copies of the same commercial rules can silently diverge. This module is the ONE
 * shared, typed source both the web app and the server (marketing site, DB seed, and
 * the economics engine) import, so a price or a payout cap is written down exactly
 * once.
 *
 * Every number here comes verbatim from the product specification and the existing
 * authoritative sources; nothing is invented. When the server grows a public
 * `/catalog` endpoint backed by the versioned product-config tables
 * (account_profiles / account_profile_versions), that DB catalog becomes the runtime
 * authority and this module becomes the code-level default/fallback — the types stay.
 *
 * KNOWN DIVERGENCE (reported, not silently reconciled — product rules are an owner
 * decision, see docs/economics/LIMITATIONS.md): the drawdown model here is EOD
 * trailing (`eodDrawdownUsd`), matching the public site, whereas the current DB seed
 * `evalRules` computes a STATIC drawdown at 4% of size for every family. The
 * economics engine does not depend on the drawdown mechanic (evaluation pass/fail is
 * an explicit assumption), so this does not affect modeled cash flows; it is flagged
 * for the owner to reconcile in a later product-rules milestone.
 */

export type FamilyKey = 'CORE' | 'SELECT' | 'DAILY';

export interface AccountConfig {
  /** Human size label, e.g. "25K" or "300K". */
  readonly size: string;
  /** Account size in whole dollars (buying-power / starting balance). */
  readonly sizeUsd: number;
  /** One-time evaluation price in whole dollars. */
  readonly priceUsd: number;
  /** Profit target in whole dollars. */
  readonly targetUsd: number;
  /** End-of-day trailing drawdown in whole dollars. */
  readonly eodDrawdownUsd: number;
  /** Contract limits. */
  readonly minis: number;
  readonly micros: number;
  /** Daily family only: the loss buffer that must be cleared before daily payouts. */
  readonly bufferUsd?: number;
  /** Marks the flagship gold account (300K Core). Gold accent is used ONLY here. */
  readonly gold?: boolean;
}

export interface Family {
  readonly key: FamilyKey;
  readonly name: string;
  /** One-line personality, used on the selector. */
  readonly tagline: string;
  /** A short paragraph describing who it is for. */
  readonly summary: string;
  /** Evaluation consistency requirement, as a percentage (e.g. 50 → "50%"). */
  readonly evalConsistencyPct: number;
  /** Funded / payout consistency requirement, or null when there is none. */
  readonly fundedConsistencyPct: number | null;
  /** Trader profit split, as a percentage. */
  readonly splitPct: number;
  /** One-time activation fee in whole dollars (0 across the board today). */
  readonly activationFeeUsd: number;
  /** The headline rule bullets, stated plainly and correctly. */
  readonly rules: readonly string[];
  readonly accounts: readonly AccountConfig[];
}

export const FAMILIES: readonly Family[] = [
  {
    key: 'CORE',
    name: 'Core',
    tagline: 'The straightforward path to funding.',
    summary:
      'A clean, no-surprises evaluation. No daily loss limit, no funded-side consistency rule — pass the target with 50% consistency, put in five winning days, and get funded on a 90% split.',
    evalConsistencyPct: 50,
    fundedConsistencyPct: null,
    splitPct: 90,
    activationFeeUsd: 0,
    rules: [
      '50% evaluation consistency',
      'No daily loss limit',
      'No funded consistency rule',
      'Five winning days of $150 or more',
      '90% trader profit split',
      '$0 activation fee',
    ],
    accounts: [
      { size: '25K', sizeUsd: 25_000, priceUsd: 65, targetUsd: 1_500, eodDrawdownUsd: 1_000, minis: 2, micros: 20 },
      { size: '50K', sizeUsd: 50_000, priceUsd: 95, targetUsd: 3_000, eodDrawdownUsd: 2_000, minis: 5, micros: 50 },
      { size: '100K', sizeUsd: 100_000, priceUsd: 170, targetUsd: 6_000, eodDrawdownUsd: 4_000, minis: 10, micros: 100 },
      { size: '300K', sizeUsd: 300_000, priceUsd: 599, targetUsd: 15_000, eodDrawdownUsd: 10_000, minis: 20, micros: 200, gold: true },
    ],
  },
  {
    key: 'SELECT',
    name: 'Select',
    tagline: 'Room to breathe, consistency that protects you.',
    summary:
      'A wider drawdown and a lower 40% consistency bar. On the funded side, exceeding consistency delays a payout rather than failing the account — so a single outsized day never costs you the account.',
    evalConsistencyPct: 40,
    fundedConsistencyPct: 40,
    splitPct: 90,
    activationFeeUsd: 0,
    rules: [
      '40% evaluation consistency',
      'No daily loss limit',
      '40% funded / payout consistency',
      'Exceeding consistency delays a payout — it does not fail the account',
      'Five winning days',
      '90% trader profit split',
      '$0 activation fee',
    ],
    accounts: [
      { size: '25K', sizeUsd: 25_000, priceUsd: 85, targetUsd: 1_500, eodDrawdownUsd: 1_250, minis: 3, micros: 30 },
      { size: '50K', sizeUsd: 50_000, priceUsd: 135, targetUsd: 3_000, eodDrawdownUsd: 2_500, minis: 7, micros: 70 },
      { size: '100K', sizeUsd: 100_000, priceUsd: 230, targetUsd: 6_000, eodDrawdownUsd: 5_000, minis: 15, micros: 150 },
    ],
  },
  {
    key: 'DAILY',
    name: 'Daily',
    tagline: 'Get paid as often as you perform.',
    summary:
      'Built for consistent daily performers. Clear five initial winning days and a loss buffer, and you unlock daily payout eligibility. Each successive payout requires your balance to have grown to a higher threshold first, so payouts scale with the account rather than draining it.',
    evalConsistencyPct: 40,
    fundedConsistencyPct: null,
    splitPct: 90,
    activationFeeUsd: 0,
    rules: [
      '40% evaluation consistency',
      'No daily loss limit',
      'No funded consistency rule',
      'Five initial winning days',
      'Daily payout eligibility once the buffer is cleared',
      'Each successive payout requires a higher balance threshold first',
      '90% trader profit split',
      '$0 activation fee',
    ],
    accounts: [
      { size: '25K', sizeUsd: 25_000, priceUsd: 90, targetUsd: 1_500, eodDrawdownUsd: 1_000, minis: 2, micros: 20, bufferUsd: 1_000 },
      { size: '50K', sizeUsd: 50_000, priceUsd: 145, targetUsd: 3_000, eodDrawdownUsd: 2_000, minis: 5, micros: 50, bufferUsd: 2_000 },
      { size: '100K', sizeUsd: 100_000, priceUsd: 250, targetUsd: 6_000, eodDrawdownUsd: 4_000, minis: 10, micros: 100, bufferUsd: 4_000 },
    ],
  },
];

export function family(key: FamilyKey): Family {
  const f = FAMILIES.find((x) => x.key === key);
  if (!f) throw new Error(`unknown family ${key}`);
  return f;
}

/** All ten accounts, flattened, cheapest first — for the full matrix. */
export const ALL_ACCOUNTS: readonly (AccountConfig & { family: FamilyKey; familyName: string })[] =
  FAMILIES.flatMap((f) => f.accounts.map((a) => ({ ...a, family: f.key, familyName: f.name })));

// ---------------------------------------------------------------------------
// Authoritative payout parameters (single source; consumed by the DB seed
// `seed-htf-products.ts` and by the economics engine). These mirror the payout
// engine's per-product `payoutRules` (apps/server/src/platform/payout-core.ts)
// and the launch caps documented in docs/account-lifecycle-ux-v1 §5.
// ---------------------------------------------------------------------------

/** Trader profit split, as a percentage (the trader keeps 90%). */
export const PROFIT_SPLIT_PCT = 90;
/** One-time activation fee in whole dollars ($0 across the board today). */
export const ACTIVATION_FEE_USD = 0;
/** Winning days required before a first payout. */
export const REQUIRED_WINNING_DAYS = 5;
/** A day counts as "winning" at or above this net, in whole dollars. */
export const WINNING_DAY_THRESHOLD_USD = 150;
/** Minimum payout request, in whole dollars. */
export const MIN_PAYOUT_REQUEST_USD = 250;

/**
 * Launch payout request caps by account size, in whole dollars
 * (docs/account-lifecycle-ux-v1 §5): 25K=$1,000, 50K=$2,000, 100K=$3,500,
 * 300K Gold=$5,000. A flat cap per size; the payout engine further composes the
 * request ceiling as min(eligible, this cap, 50% of eligible).
 */
export const PAYOUT_REQUEST_CAP_USD_BY_SIZE: Readonly<Record<number, number>> = {
  25_000: 1_000,
  50_000: 2_000,
  100_000: 3_500,
  300_000: 5_000,
};

/** The payout request cap for an account size, in whole dollars. */
export function payoutCapUsd(sizeUsd: number): number {
  const cap = PAYOUT_REQUEST_CAP_USD_BY_SIZE[sizeUsd];
  if (cap === undefined) throw new Error(`no payout cap configured for size ${sizeUsd}`);
  return cap;
}

/** The Daily loss buffer for an account, in whole dollars (0 for Core/Select). */
export function bufferUsdOf(a: AccountConfig): number {
  return a.bufferUsd ?? 0;
}

// ---- formatting -----------------------------------------------------------
const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** "$1,500" */
export function usd(n: number): string {
  return USD0.format(n);
}

/** "$65" for a price. */
export function price(n: number): string {
  return USD0.format(n);
}

/** "$25K", "$300K" — compact size label with a dollar sign. */
export function sizeLabel(a: AccountConfig): string {
  return `$${a.size}`;
}
