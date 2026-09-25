/**
 * Economics analysis (M13.0): sensitivity sweeps, seeded Monte Carlo distributions,
 * and break-even solving. All deterministic given (assumptions, seed).
 *
 * Percentile convention (docs/economics/SENSITIVITY.md): percentiles are of the raw
 * metric. For CONTRIBUTION and DISTRIBUTABLE CASH a LOW percentile (p10) is the BAD
 * (downside) outcome; for PAYOUT EXPENSE and RESERVE REQUIREMENT a HIGH percentile
 * (p90) is the bad outcome. Each distribution is labelled with its `worseTail`.
 */
import { type Assumptions } from './config.js';
import { simulate, type SimInput, type SimResult } from './engine.js';

export interface Distribution {
  worseTail: 'LOW' | 'HIGH';
  mean: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
}

function distribution(values: number[], worseTail: 'LOW' | 'HIGH'): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[idx]!;
  };
  const mean = Math.round(values.reduce((s, v) => s + v, 0) / (values.length || 1));
  return { worseTail, mean, p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9) };
}

export interface MonteCarloResult {
  trials: number;
  revenue: Distribution;
  payoutExpense: Distribution;
  contribution: Distribution;
  reserveRequirement: Distribution;
  distributableCash: Distribution;
  fundedAccounts: Distribution;
  /** Fraction of trials whose modeled contribution was negative. */
  probContributionNegative: number;
  /** Fraction of trials whose distributable cash was negative (liquidity stress). */
  probLiquidityStress: number;
  /** A safety reserve suggestion = multiplier × (p90 payout − mean payout). */
  suggestedSafetyReserveMicros: number;
}

/** Seeded Monte Carlo: each trial redraws the whole run. */
export function monteCarlo(input: SimInput, trials: number, safetyMultiplier: number): MonteCarloResult {
  const revenue: number[] = [];
  const payoutExpense: number[] = [];
  const contribution: number[] = [];
  const reserve: number[] = [];
  const distributable: number[] = [];
  const funded: number[] = [];
  let negContribution = 0;
  let liquidityStress = 0;
  for (let t = 0; t < trials; t += 1) {
    const r = simulate({ ...input, seed: input.seed + t * 2654435761 });
    revenue.push(r.netRevenueMicros);
    payoutExpense.push(r.payouts.traderShareMicros);
    contribution.push(r.contributionMicros);
    reserve.push(r.treasury.requiredReserveMicros);
    distributable.push(r.treasury.distributableCashMicros);
    funded.push(r.fundedAccounts);
    if (r.contributionMicros < 0) negContribution += 1;
    if (r.treasury.distributableCashMicros < 0) liquidityStress += 1;
  }
  const payoutDist = distribution(payoutExpense, 'HIGH');
  return {
    trials,
    revenue: distribution(revenue, 'LOW'),
    payoutExpense: payoutDist,
    contribution: distribution(contribution, 'LOW'),
    reserveRequirement: distribution(reserve, 'HIGH'),
    distributableCash: distribution(distributable, 'LOW'),
    fundedAccounts: distribution(funded, 'LOW'),
    probContributionNegative: trials > 0 ? negContribution / trials : 0,
    probLiquidityStress: trials > 0 ? liquidityStress / trials : 0,
    suggestedSafetyReserveMicros: Math.round(safetyMultiplier * Math.max(0, payoutDist.p90 - payoutDist.mean)),
  };
}

// ---- sensitivity -----------------------------------------------------------

export interface SensitivityPoint {
  value: number; // the lever value at this point
  contributionMicros: number;
  contributionMargin: number;
  netRevenueMicros: number;
  traderPayoutMicros: number;
}

export type Lever =
  | 'passRate' | 'firstPayoutProb' | 'repeatPayoutProb' | 'avgPayoutFractionOfCap'
  | 'refundRate' | 'chargebackRate' | 'affiliatePenetration' | 'cacPerCustomerMicros'
  | 'resetRateOnFail';

const LEVER_SWEEPS: Record<Lever, number[]> = {
  passRate: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4],
  firstPayoutProb: [0.2, 0.35, 0.5, 0.65, 0.8, 0.95],
  repeatPayoutProb: [0.1, 0.25, 0.4, 0.55, 0.7, 0.85],
  avgPayoutFractionOfCap: [0.2, 0.4, 0.5, 0.6, 0.8, 1],
  refundRate: [0, 0.02, 0.05, 0.1, 0.15, 0.2],
  chargebackRate: [0, 0.01, 0.03, 0.05, 0.08, 0.12],
  affiliatePenetration: [0, 0.2, 0.35, 0.5, 0.75, 1],
  cacPerCustomerMicros: [0, 10, 25, 50, 75, 100].map((d) => d * 1_000_000),
  resetRateOnFail: [0, 0.1, 0.25, 0.4, 0.6, 0.8],
};

function withLever(a: Assumptions, lever: Lever, value: number): Assumptions {
  if (lever === 'cacPerCustomerMicros') {
    return { ...a, cacPerCustomerMicros: value, acquisitionModel: a.acquisitionModel === 'ORGANIC' ? 'PAID' : a.acquisitionModel };
  }
  return { ...a, [lever]: value } as Assumptions;
}

/** Sweep a single lever and report the contribution curve. */
export function sensitivity(input: SimInput, lever: Lever): SensitivityPoint[] {
  return LEVER_SWEEPS[lever].map((value) => {
    const r = simulate({ ...input, assumptions: withLever(input.assumptions, lever, value) });
    return {
      value,
      contributionMicros: r.contributionMicros,
      contributionMargin: r.contributionMargin,
      netRevenueMicros: r.netRevenueMicros,
      traderPayoutMicros: r.payouts.traderShareMicros,
    };
  });
}

/** Sweep every lever (used by the owner view + validation). */
export function sensitivityAll(input: SimInput): Record<Lever, SensitivityPoint[]> {
  const out = {} as Record<Lever, SensitivityPoint[]>;
  (Object.keys(LEVER_SWEEPS) as Lever[]).forEach((lever) => { out[lever] = sensitivity(input, lever); });
  return out;
}

// ---- break-even ------------------------------------------------------------

export interface BreakEven {
  lever: Lever;
  /** The lever value where modeled contribution crosses zero, or null if it never does in range. */
  breakEvenValue: number | null;
  /** Direction: does contribution DECREASE as the lever rises? */
  decreasingInLever: boolean;
  baselineContributionMicros: number;
}

/**
 * Find where contribution crosses zero for a lever, by scanning a fine grid and
 * linearly interpolating the crossing. Deterministic (fixed seed per point).
 */
export function breakEven(input: SimInput, lever: Lever, steps = 40): BreakEven {
  const sweep = LEVER_SWEEPS[lever];
  const lo = sweep[0]!;
  const hi = sweep[sweep.length - 1]!;
  const base = simulate(input);
  let prevX = lo;
  let prevY = simulate({ ...input, assumptions: withLever(input.assumptions, lever, lo) }).contributionMicros;
  const firstY = prevY;
  let crossing: number | null = null;
  for (let i = 1; i <= steps; i += 1) {
    const x = lo + ((hi - lo) * i) / steps;
    const y = simulate({ ...input, assumptions: withLever(input.assumptions, lever, x) }).contributionMicros;
    if ((prevY >= 0 && y < 0) || (prevY < 0 && y >= 0)) {
      const t = prevY === y ? 0 : prevY / (prevY - y);
      crossing = prevX + (x - prevX) * t;
      break;
    }
    prevX = x; prevY = y;
  }
  const lastY = simulate({ ...input, assumptions: withLever(input.assumptions, lever, hi) }).contributionMicros;
  return { lever, breakEvenValue: crossing, decreasingInLever: lastY < firstY, baselineContributionMicros: base.contributionMicros };
}

/** Break-even across the levers most likely to threaten the business. */
export function breakEvenKey(input: SimInput): BreakEven[] {
  const levers: Lever[] = ['firstPayoutProb', 'repeatPayoutProb', 'avgPayoutFractionOfCap', 'refundRate', 'chargebackRate', 'cacPerCustomerMicros', 'affiliatePenetration'];
  return levers.map((l) => breakEven(input, l));
}
