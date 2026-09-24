/**
 * Happy Trader Funding — the internal economics simulator.
 *
 * A synthetic what-if model for stress-testing the account products. It NEVER
 * reads or writes production trader/account data; it is a pure function of
 * (assumptions, seed). It shares the exact 90/10 split accounting with the real
 * payout engine (`splitAccounting`) so a simulated payout and a real one can
 * never diverge in their maths.
 *
 * Money is integer micro-dollars. The PRNG is seeded and reproducible, so every
 * result is exactly recomputable from its inputs — nothing is buried.
 */
import { MICROS, splitAccounting } from './payout-core.js';

// -- seeded PRNG (mulberry32) — reproducible across runs and machines --------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SimModel = 'CORE' | 'SELECT' | 'DAILY';

/** One product in the mix. Every number is an explicit assumption. */
export interface SimProduct {
  key: string;
  model: SimModel;
  sizeMicros: number;
  priceMicros: number;
  /** Relative weight in the purchase mix. */
  weight: number;
  /** Probability a purchase passes the evaluation. */
  passRate: number;
  /** Probability a funded account reaches its first payout (survives). */
  fundedSurvival: number;
  /** Probability a surviving funded account takes a first payout. */
  firstPayoutProb: number;
  /** Probability of each subsequent payout (geometric), capped by maxPayouts. */
  repeatPayoutProb: number;
  maxPayouts: number;
  /** Progressive per-ordinal payout caps (last = established). */
  payoutCapsMicros: number[];
  minRequestMicros: number;
  /** Mean payout as a fraction of the ordinal cap (0..1). */
  avgPayoutFractionOfCap: number;
  /** SELECT: fraction of payout attempts blocked by consistency. */
  consistencyBlockRate: number;
  profitSplitPercent: number;
}

export interface Assumptions {
  products: SimProduct[];
  processingPct: number; // payment processing, as fraction of revenue
  fraudPct: number; // chargeback/fraud, as fraction of revenue
  platformCostPerPurchaseMicros: number; // market-data/platform per purchase
  supportCostPerPurchaseMicros: number; // support/KYC per purchase
  cacPctOfRevenue: number; // customer acquisition cost
  fixedCostsMicros: number; // amortized across the whole run
}

export interface ProductResult {
  key: string;
  model: SimModel;
  sizeMicros: number;
  purchases: number;
  grossRevenueMicros: number;
  passes: number;
  fundedAccounts: number;
  payoutRecipients: number;
  payoutEvents: number;
  grossTraderPayoutsMicros: number; // trader share = the firm's payout expense
  firmRetainedSplitMicros: number; // the firm's 10% of gross payouts
}

export interface SimResult {
  purchases: number;
  grossRevenueMicros: number;
  avgRevenuePerPurchaseMicros: number;
  passes: number;
  passRate: number;
  fundedAccounts: number;
  payoutRecipients: number;
  purchaseToPayoutPct: number;
  payoutEvents: number;
  grossTraderPayoutsMicros: number;
  firmRetainedSplitMicros: number;
  payoutToRevenuePct: number;
  processingCostMicros: number;
  fraudCostMicros: number;
  platformCostMicros: number;
  supportCostMicros: number;
  cacMicros: number;
  fixedCostsMicros: number;
  contributionMicros: number;
  contributionMargin: number;
  byProduct: ProductResult[];
}

/** A bounded, right-skewed payout draw within [min, cap]. */
function drawPayout(rng: () => number, minMicros: number, capMicros: number, meanFraction: number): number {
  if (capMicros <= minMicros) return minMicros;
  // Two uniforms averaged then nudged toward the mean fraction — cheap, bounded,
  // slightly skewed. Deterministic given the rng.
  const u = (rng() + rng()) / 2;
  const frac = Math.min(1, Math.max(0, meanFraction * 0.6 + u * 0.8));
  return Math.round(minMicros + frac * (capMicros - minMicros));
}

function capForOrdinal(caps: number[], ordinal: number): number {
  return caps[Math.max(0, Math.min(ordinal - 1, caps.length - 1))]!;
}

/** Run the funnel for N purchases. O(N), integer money, deterministic on seed. */
export function simulate(assumptions: Assumptions, seed: number, purchases: number): SimResult {
  const rng = mulberry32(seed);
  const products = assumptions.products;
  const totalWeight = products.reduce((s, p) => s + p.weight, 0);

  const per = new Map<string, ProductResult>();
  for (const p of products) {
    per.set(p.key, {
      key: p.key,
      model: p.model,
      sizeMicros: p.sizeMicros,
      purchases: 0,
      grossRevenueMicros: 0,
      passes: 0,
      fundedAccounts: 0,
      payoutRecipients: 0,
      payoutEvents: 0,
      grossTraderPayoutsMicros: 0,
      firmRetainedSplitMicros: 0,
    });
  }

  const pickProduct = (): SimProduct => {
    let r = rng() * totalWeight;
    for (const p of products) {
      r -= p.weight;
      if (r <= 0) return p;
    }
    return products[products.length - 1]!;
  };

  for (let i = 0; i < purchases; i += 1) {
    const p = pickProduct();
    const acc = per.get(p.key)!;
    acc.purchases += 1;
    acc.grossRevenueMicros += p.priceMicros;
    if (rng() >= p.passRate) continue; // did not pass
    acc.passes += 1;
    acc.fundedAccounts += 1;
    if (rng() >= p.fundedSurvival) continue; // funded but churned before payout
    if (rng() >= p.firstPayoutProb) continue; // survived but no first payout

    // First payout, then repeats (geometric, capped).
    let ordinal = 0;
    let took = false;
    let takeAnother = true;
    while (takeAnother && ordinal < p.maxPayouts) {
      ordinal += 1;
      // SELECT consistency can block an attempt (not a failure — just no payout).
      if (p.model === 'SELECT' && rng() < p.consistencyBlockRate) {
        takeAnother = rng() < p.repeatPayoutProb;
        continue;
      }
      const cap = capForOrdinal(p.payoutCapsMicros, ordinal);
      const gross = drawPayout(rng, p.minRequestMicros, cap, p.avgPayoutFractionOfCap);
      const split = splitAccounting(gross, p.profitSplitPercent);
      acc.payoutEvents += 1;
      acc.grossTraderPayoutsMicros += split.traderShareMicros;
      acc.firmRetainedSplitMicros += split.firmShareMicros;
      took = true;
      takeAnother = rng() < p.repeatPayoutProb;
    }
    if (took) acc.payoutRecipients += 1;
  }

  return aggregate(assumptions, [...per.values()], purchases);
}

function aggregate(assumptions: Assumptions, byProduct: ProductResult[], purchases: number): SimResult {
  let grossRevenue = 0;
  let passes = 0;
  let funded = 0;
  let recipients = 0;
  let events = 0;
  let traderPayouts = 0;
  let firmSplit = 0;
  for (const r of byProduct) {
    grossRevenue += r.grossRevenueMicros;
    passes += r.passes;
    funded += r.fundedAccounts;
    recipients += r.payoutRecipients;
    events += r.payoutEvents;
    traderPayouts += r.grossTraderPayoutsMicros;
    firmSplit += r.firmRetainedSplitMicros;
  }
  const processing = Math.round(grossRevenue * assumptions.processingPct);
  const fraud = Math.round(grossRevenue * assumptions.fraudPct);
  const platform = purchases * assumptions.platformCostPerPurchaseMicros;
  const support = purchases * assumptions.supportCostPerPurchaseMicros;
  const cac = Math.round(grossRevenue * assumptions.cacPctOfRevenue);
  const fixed = assumptions.fixedCostsMicros;
  // Contribution: revenue minus the trader payouts (the firm's payout expense)
  // and all costs. The firm's 10% split is already retained in revenue terms and
  // is NOT an expense — the expense is only the trader's share that leaves.
  const contribution = grossRevenue - traderPayouts - processing - fraud - platform - support - cac - fixed;
  return {
    purchases,
    grossRevenueMicros: grossRevenue,
    avgRevenuePerPurchaseMicros: purchases > 0 ? Math.round(grossRevenue / purchases) : 0,
    passes,
    passRate: purchases > 0 ? passes / purchases : 0,
    fundedAccounts: funded,
    payoutRecipients: recipients,
    purchaseToPayoutPct: purchases > 0 ? recipients / purchases : 0,
    payoutEvents: events,
    grossTraderPayoutsMicros: traderPayouts,
    firmRetainedSplitMicros: firmSplit,
    payoutToRevenuePct: grossRevenue > 0 ? traderPayouts / grossRevenue : 0,
    processingCostMicros: processing,
    fraudCostMicros: fraud,
    platformCostMicros: platform,
    supportCostMicros: support,
    cacMicros: cac,
    fixedCostsMicros: fixed,
    contributionMicros: contribution,
    contributionMargin: grossRevenue > 0 ? contribution / grossRevenue : 0,
    byProduct,
  };
}

// -- sensitivity -------------------------------------------------------------

export interface SensitivityPoint {
  factor: number; // e.g. 1.2 for +20%
  contributionMicros: number;
  contributionMargin: number;
}

/** Sweep a single lever and report the contribution-margin curve. */
export function sensitivity(
  assumptions: Assumptions,
  seed: number,
  purchases: number,
): {
  payoutExpense: SensitivityPoint[];
  passRate: SensitivityPoint[];
  cac: SensitivityPoint[];
} {
  const payoutFactors = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75, 2];
  const passFactors = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75, 2];
  const cacLevels = [0.1, 0.15, 0.2, 0.25, 0.3];

  const base = simulate(assumptions, seed, purchases);

  const payoutExpense = payoutFactors.map((f) => {
    const contribution = base.grossRevenueMicros - Math.round(base.grossTraderPayoutsMicros * f) -
      base.processingCostMicros - base.fraudCostMicros - base.platformCostMicros - base.supportCostMicros -
      base.cacMicros - base.fixedCostsMicros;
    return { factor: f, contributionMicros: contribution, contributionMargin: base.grossRevenueMicros > 0 ? contribution / base.grossRevenueMicros : 0 };
  });

  const passRate = passFactors.map((f) => {
    const scaled: Assumptions = { ...assumptions, products: assumptions.products.map((p) => ({ ...p, passRate: Math.min(1, p.passRate * f) })) };
    const r = simulate(scaled, seed, purchases);
    return { factor: f, contributionMicros: r.contributionMicros, contributionMargin: r.contributionMargin };
  });

  const cac = cacLevels.map((level) => {
    const contribution = base.grossRevenueMicros - base.grossTraderPayoutsMicros - base.processingCostMicros -
      base.fraudCostMicros - base.platformCostMicros - base.supportCostMicros -
      Math.round(base.grossRevenueMicros * level) - base.fixedCostsMicros;
    return { factor: level, contributionMicros: contribution, contributionMargin: base.grossRevenueMicros > 0 ? contribution / base.grossRevenueMicros : 0 };
  });

  return { payoutExpense, passRate, cac };
}

// -- Monte Carlo -------------------------------------------------------------

export interface Distribution {
  mean: number;
  median: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
    return sorted[idx]!;
  };
  const mean = values.reduce((s, v) => s + v, 0) / (values.length || 1);
  return { mean: Math.round(mean), median: q(0.5), p5: q(0.05), p25: q(0.25), p75: q(0.75), p95: q(0.95) };
}

export interface MonteCarloResult {
  trials: number;
  purchasesPerTrial: number;
  revenue: Distribution;
  payoutExpense: Distribution;
  contribution: Distribution;
  contributionMarginBps: Distribution; // margin × 10000 to keep integers
  fundedAccounts: Distribution;
  payoutRecipients: Distribution;
}

/** Seeded Monte Carlo: each trial redraws the funnel; distributions reported. */
export function monteCarlo(
  assumptions: Assumptions,
  seed: number,
  trials: number,
  purchasesPerTrial: number,
): MonteCarloResult {
  const revenue: number[] = [];
  const payoutExpense: number[] = [];
  const contribution: number[] = [];
  const margin: number[] = [];
  const funded: number[] = [];
  const recipients: number[] = [];
  for (let t = 0; t < trials; t += 1) {
    const r = simulate(assumptions, seed + t * 2654435761, purchasesPerTrial);
    revenue.push(r.grossRevenueMicros);
    payoutExpense.push(r.grossTraderPayoutsMicros);
    contribution.push(r.contributionMicros);
    margin.push(Math.round(r.contributionMargin * 10000));
    funded.push(r.fundedAccounts);
    recipients.push(r.payoutRecipients);
  }
  return {
    trials,
    purchasesPerTrial,
    revenue: distribution(revenue),
    payoutExpense: distribution(payoutExpense),
    contribution: distribution(contribution),
    contributionMarginBps: distribution(margin),
    fundedAccounts: distribution(funded),
    payoutRecipients: distribution(recipients),
  };
}

// -- reserve model -----------------------------------------------------------

/**
 * Illustrative required reserve — NOT accounting or legal advice. Assumptions
 * visible: reserve ≈ max(pendingApproved, expectedNearTerm) + multiplier × tail.
 */
export function reserveModel(
  pendingApprovedMicros: number,
  expectedNearTermMicros: number,
  payoutExpense: Distribution,
  stressMultiplier: number,
): { reserveMicros: number; tailMicros: number; basisMicros: number } {
  const tail = Math.max(0, payoutExpense.p95 - payoutExpense.mean);
  const basis = Math.max(pendingApprovedMicros, expectedNearTermMicros);
  return { reserveMicros: Math.round(basis + stressMultiplier * tail), tailMicros: tail, basisMicros: basis };
}

// -- default assumptions (BASE) + scenarios ----------------------------------

const $ = (d: number) => d * MICROS;

/** The BASE scenario — the locked product prices with plausible funnel defaults. */
export function baseAssumptions(): Assumptions {
  // Defaults reflect roughly published prop-firm funnels: ~1 in 10 evaluations
  // pass, a minority of funded accounts survive to a first payout, and payout
  // sizes are a fraction of the cap. Every number here is an editable assumption
  // — this is the BASE the owner tunes, not a claim of truth.
  const core = (size: number, price: number, cap: number, min: number): SimProduct => ({
    key: `core-${size / 1000}k`, model: 'CORE', sizeMicros: $(size), priceMicros: $(price), weight: 1,
    passRate: 0.1, fundedSurvival: 0.4, firstPayoutProb: 0.5, repeatPayoutProb: 0.4, maxPayouts: 6,
    payoutCapsMicros: [$(cap)], minRequestMicros: $(min), avgPayoutFractionOfCap: 0.5, consistencyBlockRate: 0, profitSplitPercent: 0.9,
  });
  const select = (size: number, price: number, cap: number, min: number): SimProduct => ({
    key: `select-${size / 1000}k`, model: 'SELECT', sizeMicros: $(size), priceMicros: $(price), weight: 0.8,
    passRate: 0.12, fundedSurvival: 0.42, firstPayoutProb: 0.52, repeatPayoutProb: 0.42, maxPayouts: 6,
    payoutCapsMicros: [$(cap)], minRequestMicros: $(min), avgPayoutFractionOfCap: 0.5, consistencyBlockRate: 0.25, profitSplitPercent: 0.9,
  });
  const daily = (size: number, price: number, cap: number, min: number): SimProduct => ({
    key: `daily-${size / 1000}k`, model: 'DAILY', sizeMicros: $(size), priceMicros: $(price), weight: 0.7,
    passRate: 0.13, fundedSurvival: 0.4, firstPayoutProb: 0.55, repeatPayoutProb: 0.45, maxPayouts: 10,
    payoutCapsMicros: [$(cap)], minRequestMicros: $(min), avgPayoutFractionOfCap: 0.5, consistencyBlockRate: 0, profitSplitPercent: 0.9,
  });
  return {
    products: [
      core(25_000, 65, 1000, 250), core(50_000, 95, 2000, 250), core(100_000, 170, 3000, 500), core(300_000, 599, 5000, 500),
      select(25_000, 85, 2000, 250), select(50_000, 135, 2000, 250), select(100_000, 230, 3000, 500),
      daily(25_000, 90, 1000, 250), daily(50_000, 145, 2000, 250), daily(100_000, 250, 3000, 500),
    ],
    processingPct: 0.04,
    fraudPct: 0.02,
    platformCostPerPurchaseMicros: $(3),
    supportCostPerPurchaseMicros: $(4),
    cacPctOfRevenue: 0.2,
    fixedCostsMicros: $(0),
  };
}

export type ScenarioName =
  | 'BASE' | 'GOOD_FOR_FIRM' | 'GOOD_FOR_TRADER' | 'HIGH_PASS_RATE' | 'HIGH_PAYOUT_RATE'
  | 'HIGH_REPEAT_PAYOUT' | 'HIGH_CAC' | 'HIGH_FRAUD' | 'DAILY_PAYOUT_STRESS' | 'SELECT_HIGH_SKILL';

/** A named scenario is an override set over BASE — nothing hidden. */
export function scenario(name: ScenarioName): Assumptions {
  const a = baseAssumptions();
  const map = (fn: (p: SimProduct) => SimProduct): Assumptions => ({ ...a, products: a.products.map(fn) });
  switch (name) {
    case 'BASE': return a;
    case 'GOOD_FOR_FIRM': return { ...map((p) => ({ ...p, passRate: p.passRate * 0.8, firstPayoutProb: p.firstPayoutProb * 0.8 })), cacPctOfRevenue: 0.12 };
    case 'GOOD_FOR_TRADER': return map((p) => ({ ...p, passRate: Math.min(1, p.passRate * 1.4), firstPayoutProb: Math.min(1, p.firstPayoutProb * 1.3), repeatPayoutProb: Math.min(1, p.repeatPayoutProb * 1.3) }));
    case 'HIGH_PASS_RATE': return map((p) => ({ ...p, passRate: Math.min(1, p.passRate * 1.6) }));
    case 'HIGH_PAYOUT_RATE': return map((p) => ({ ...p, firstPayoutProb: Math.min(1, p.firstPayoutProb * 1.5) }));
    case 'HIGH_REPEAT_PAYOUT': return map((p) => ({ ...p, repeatPayoutProb: Math.min(0.95, p.repeatPayoutProb * 1.6) }));
    case 'HIGH_CAC': return { ...a, cacPctOfRevenue: 0.35 };
    case 'HIGH_FRAUD': return { ...a, fraudPct: 0.08 };
    case 'DAILY_PAYOUT_STRESS': return map((p) => (p.model === 'DAILY' ? { ...p, firstPayoutProb: 0.8, repeatPayoutProb: 0.7, avgPayoutFractionOfCap: 0.8 } : p));
    case 'SELECT_HIGH_SKILL': return map((p) => (p.model === 'SELECT' ? { ...p, passRate: Math.min(1, p.passRate * 1.5), consistencyBlockRate: 0.1, repeatPayoutProb: Math.min(0.95, p.repeatPayoutProb * 1.3) } : p));
  }
}

// -- payout-cap experiment ---------------------------------------------------

export type CapSchedule = 'CONSERVATIVE' | 'CURRENT' | 'GENEROUS';

/** Apply a cap schedule (progressive-aware) to the assumptions' products. */
export function withCapSchedule(a: Assumptions, sched: CapSchedule): Assumptions {
  const scale = sched === 'CONSERVATIVE' ? 0.6 : sched === 'GENEROUS' ? 1.6 : 1;
  return {
    ...a,
    products: a.products.map((p) => ({
      ...p,
      // Progressive by default under GENEROUS: grow the cap per ordinal.
      payoutCapsMicros: sched === 'GENEROUS'
        ? [p.payoutCapsMicros[0]!, Math.round(p.payoutCapsMicros[0]! * 1.4), Math.round(p.payoutCapsMicros[0]! * 1.8), Math.round(p.payoutCapsMicros[0]! * 2.2)]
        : p.payoutCapsMicros.map((c) => Math.round(c * scale)),
    })),
  };
}
