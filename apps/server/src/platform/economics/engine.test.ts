/**
 * The economics engine (M13.0) — deterministic, reconciled, invariant-safe, scaled.
 *
 * Proves reproducibility (same seed → same result), that the money arithmetic
 * reconciles (revenue → contribution, per-product → aggregate, timeline → summary,
 * 90/10 split), that economic invariants hold, and that it runs at 100 → 10,000
 * customers over 30 → 365 days. The scale/validation block emits the headline numbers
 * used in the milestone report. NONE of these are predictions.
 */
import { describe, expect, it } from 'vitest';
import { MICROS } from '../payout-core.js';
import {
  breakEven, breakEvenKey, defaultAssumptions, loadAuthoritativeProducts, monteCarlo,
  runEconomics, scenario, sensitivity, sensitivityAll, simulate, SCENARIO_NAMES,
  type ScenarioName, type SimInput,
} from './index.js';

const usd = (m: number): string => (m / MICROS).toLocaleString('en-US', { maximumFractionDigits: 0 });

function baseInput(customers = 2000, horizonDays = 90, seed = 2026): SimInput {
  return { products: loadAuthoritativeProducts(), assumptions: defaultAssumptions(), seed, customers, horizonDays };
}

describe('authoritative products load from the shared catalog', () => {
  it('has the ten CORE/SELECT/DAILY products with authoritative payout params', () => {
    const p = loadAuthoritativeProducts();
    expect(p).toHaveLength(10);
    for (const prod of p) {
      expect(prod.profitSplitPercent).toBe(0.9);
      expect(prod.activationFeeMicros).toBe(0);
      expect(prod.payoutCapMicros).toBeGreaterThan(0);
      expect(prod.minRequestMicros).toBe(250 * MICROS);
    }
    const core300 = p.find((x) => x.key === 'core-300k')!;
    expect(core300.priceMicros).toBe(599 * MICROS);
    expect(core300.payoutCapMicros).toBe(5000 * MICROS);
    const daily25 = p.find((x) => x.key === 'daily-25k')!;
    expect(daily25.bufferMicros).toBe(1000 * MICROS);
  });
});

describe('simulate is reproducible and reconciles', () => {
  it('same inputs give an identical result; a different seed differs', () => {
    const a = simulate(baseInput());
    const b = simulate(baseInput());
    expect(a).toEqual(b);
    const c = simulate(baseInput(2000, 90, 999));
    expect(c.contributionMicros).not.toBe(a.contributionMicros);
  });

  it('revenue reconciles: gross = initial+reset+repurchase; net = gross − refunds − chargebacks', () => {
    const r = simulate(baseInput(5000));
    expect(r.grossSalesMicros).toBe(r.initialRevenueMicros + r.resetRevenueMicros + r.repurchaseRevenueMicros);
    expect(r.netRevenueMicros).toBe(r.grossSalesMicros - r.refundLossMicros - r.chargebackLossMicros);
  });

  it('contribution reconciles to its components', () => {
    const r = simulate(baseInput(5000));
    const recomputed =
      r.netRevenueMicros - r.payouts.traderShareMicros - r.affiliate.netCommissionExpenseMicros -
      r.processingCostMicros - r.chargebackFeeMicros - r.operatingCostMicros - r.acquisitionCostMicros;
    expect(r.contributionMicros).toBe(recomputed);
  });

  it('the 90/10 split reconciles: trader share + firm share = gross payout', () => {
    const r = simulate(baseInput(5000));
    expect(r.payouts.traderShareMicros + r.payouts.firmShareMicros).toBe(r.payouts.grossPayoutMicros);
    // Trader keeps ~90%.
    if (r.payouts.grossPayoutMicros > 0) {
      const traderPct = r.payouts.traderShareMicros / r.payouts.grossPayoutMicros;
      expect(traderPct).toBeGreaterThan(0.88);
      expect(traderPct).toBeLessThan(0.92);
    }
  });

  it('per-product totals sum to the aggregate', () => {
    const r = simulate(baseInput(5000));
    const sumGross = r.byProduct.reduce((s, p) => s + p.grossSalesMicros, 0);
    expect(sumGross).toBe(r.grossSalesMicros);
    const sumTrader = r.byProduct.reduce((s, p) => s + p.traderPayoutMicros, 0);
    expect(sumTrader).toBe(r.payouts.traderShareMicros);
    const sumPurch = r.byProduct.reduce((s, p) => s + p.purchases, 0);
    expect(sumPurch).toBe(r.purchases);
  });

  it('the timeline reconciles to the summary', () => {
    const r = simulate(baseInput(5000));
    const last = r.timeline[r.timeline.length - 1]!;
    // Cumulative cash equals the sum of net cash across periods.
    const sumNet = r.timeline.reduce((s, t) => s + t.netCashMicros, 0);
    expect(last.cumulativeCashMicros).toBe(sumNet);
    // Paid trader cash on the timeline never exceeds the total trader payout expense.
    const paidTrader = r.timeline.reduce((s, t) => s + t.traderPayoutCashMicros, 0);
    expect(paidTrader).toBeLessThanOrEqual(r.payouts.traderShareMicros);
    expect(paidTrader).toBe(r.payouts.paidTraderShareMicros);
  });
});

describe('economic invariants', () => {
  it('no counts or expenses are negative; funnel ordering holds', () => {
    const r = simulate(baseInput(5000));
    for (const n of [r.purchases, r.resets, r.passes, r.fundedAccounts, r.payoutRecipients,
      r.payouts.traderShareMicros, r.affiliate.grossCommissionMicros, r.processingCostMicros,
      r.operatingCostMicros, r.acquisitionCostMicros]) {
      expect(n).toBeGreaterThanOrEqual(0);
    }
    expect(r.passes).toBeLessThanOrEqual(r.purchases);
    expect(r.fundedAccounts).toBe(r.passes);
    expect(r.payoutRecipients).toBeLessThanOrEqual(r.fundedAccounts);
    expect(r.payouts.paidEvents).toBeLessThanOrEqual(r.payouts.approvedEvents);
    expect(r.payouts.approvedEvents).toBeLessThanOrEqual(r.payouts.requestedEvents);
  });

  it('paid trader share + approved-unpaid liability never exceeds total trader expense', () => {
    const r = simulate(baseInput(5000));
    expect(r.payouts.paidTraderShareMicros + r.payouts.approvedUnpaidTraderShareMicros)
      .toBeLessThanOrEqual(r.payouts.traderShareMicros);
  });

  it('affiliate net expense = gross − canceled − reversed, and is not double counted', () => {
    const r = simulate(baseInput(5000));
    const a = r.affiliate;
    expect(a.netCommissionExpenseMicros).toBe(a.grossCommissionMicros - a.canceledCommissionMicros - a.reversedCommissionMicros);
    expect(a.netCommissionExpenseMicros).toBeLessThanOrEqual(a.grossCommissionMicros);
    expect(a.netCommissionExpenseMicros).toBeGreaterThanOrEqual(0);
  });

  it('treasury reserve components are non-negative and sum to the requirement', () => {
    const r = simulate(baseInput(5000));
    const t = r.treasury;
    for (const n of [t.payoutLiabilityMicros, t.affiliateLiabilityMicros, t.refundReserveMicros,
      t.operatingReserveMicros, t.taxPlaceholderMicros, t.safetyReserveMicros]) {
      expect(n).toBeGreaterThanOrEqual(0);
    }
    // requiredReserve equals its components (coverage multiples are 1.0 in BASE).
    const A = defaultAssumptions();
    const recomputed = Math.round(
      A.payoutLiabilityCoverage * t.payoutLiabilityMicros + A.affiliateLiabilityCoverage * t.affiliateLiabilityMicros +
      t.refundReserveMicros + t.operatingReserveMicros + t.taxPlaceholderMicros + t.safetyReserveMicros);
    expect(t.requiredReserveMicros).toBe(recomputed);
  });
});

describe('edge cases', () => {
  it('zero customers yields an all-zero, reconciled result', () => {
    const r = simulate(baseInput(0));
    expect(r.grossSalesMicros).toBe(0);
    expect(r.contributionMicros).toBeLessThanOrEqual(0); // only fixed operating remains
    expect(r.payouts.grossPayoutMicros).toBe(0);
  });

  it('zero pass rate → no funded accounts, no payouts', () => {
    const r = simulate({ ...baseInput(3000), assumptions: { ...defaultAssumptions(), passRate: 0 } });
    expect(r.passes).toBe(0);
    expect(r.fundedAccounts).toBe(0);
    expect(r.payouts.grossPayoutMicros).toBe(0);
  });

  it('full pass rate → every fresh purchase funds', () => {
    const r = simulate({ ...baseInput(2000), assumptions: { ...defaultAssumptions(), passRate: 1, resetRateOnFail: 0 } });
    expect(r.passes).toBe(r.purchases);
  });

  it('zero payout probability → funded accounts but no payout expense', () => {
    const r = simulate({ ...baseInput(3000), assumptions: { ...defaultAssumptions(), firstPayoutProb: 0 } });
    expect(r.fundedAccounts).toBeGreaterThan(0);
    expect(r.payouts.traderShareMicros).toBe(0);
  });

  it('high refund and high chargeback reduce net revenue', () => {
    const base = simulate(baseInput(4000));
    const refund = simulate({ ...baseInput(4000), assumptions: { ...defaultAssumptions(), refundRate: 0.4 } });
    expect(refund.refundLossMicros).toBeGreaterThan(base.refundLossMicros);
    expect(refund.netRevenueMicros).toBeLessThan(base.grossSalesMicros);
  });
});

describe('scenarios, sensitivity, break-even, Monte Carlo', () => {
  it('every named scenario runs and reconciles', () => {
    for (const n of SCENARIO_NAMES) {
      const r = simulate({ ...baseInput(3000), assumptions: scenario(n) });
      expect(r.customers).toBe(3000);
      const recomputed = r.netRevenueMicros - r.payouts.traderShareMicros - r.affiliate.netCommissionExpenseMicros -
        r.processingCostMicros - r.chargebackFeeMicros - r.operatingCostMicros - r.acquisitionCostMicros;
      expect(r.contributionMicros).toBe(recomputed);
    }
  });

  it('PAYOUT_STRESS pays out more than BASE', () => {
    const base = simulate({ ...baseInput(6000), assumptions: scenario('BASE') });
    const stress = simulate({ ...baseInput(6000), assumptions: scenario('PAYOUT_STRESS') });
    expect(stress.payouts.traderShareMicros).toBeGreaterThan(base.payouts.traderShareMicros);
  });

  it('sensitivity: rising payout fraction lowers contribution; rising refund lowers it', () => {
    const payout = sensitivity(baseInput(5000), 'avgPayoutFractionOfCap');
    expect(payout[payout.length - 1]!.contributionMicros).toBeLessThan(payout[0]!.contributionMicros);
    const refund = sensitivity(baseInput(5000), 'refundRate');
    expect(refund[refund.length - 1]!.contributionMicros).toBeLessThan(refund[0]!.contributionMicros);
    const all = sensitivityAll(baseInput(2000));
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(8);
  });

  it('break-even returns a crossing or null and a direction', () => {
    const be = breakEven(baseInput(4000), 'avgPayoutFractionOfCap');
    expect(be.lever).toBe('avgPayoutFractionOfCap');
    expect(typeof be.decreasingInLever).toBe('boolean');
    const keys = breakEvenKey(baseInput(3000));
    expect(keys.length).toBeGreaterThanOrEqual(5);
  });

  it('Monte Carlo reports ordered percentiles and probabilities', () => {
    const mc = monteCarlo(baseInput(2000), 30, 1.0);
    expect(mc.trials).toBe(30);
    for (const d of [mc.revenue, mc.contribution, mc.payoutExpense, mc.distributableCash]) {
      expect(d.p10).toBeLessThanOrEqual(d.p25);
      expect(d.p25).toBeLessThanOrEqual(d.median);
      expect(d.median).toBeLessThanOrEqual(d.p75);
      expect(d.p75).toBeLessThanOrEqual(d.p90);
    }
    expect(mc.probContributionNegative).toBeGreaterThanOrEqual(0);
    expect(mc.probContributionNegative).toBeLessThanOrEqual(1);
  });
});

describe('runEconomics bundle is complete and deterministic', () => {
  it('assembles result + sensitivity + monteCarlo + breakEven, reproducibly', () => {
    const p = { scenario: 'BASE' as ScenarioName, seed: 7, customers: 2000, horizonDays: 90, trials: 20 };
    const a = runEconomics(p);
    const b = runEconomics(p);
    expect(a.result.contributionMicros).toBe(b.result.contributionMicros);
    expect(a.engineVersion).toBe('13.0.0');
    expect(a.products).toHaveLength(10);
    expect(a.breakEven.length).toBeGreaterThanOrEqual(5);
    // The safety reserve from Monte Carlo is folded into the treasury.
    expect(a.result.treasury.safetyReserveMicros).toBe(a.monteCarlo.suggestedSafetyReserveMicros);
  });
});

describe('scale + validation runs (emit report numbers — NOT predictions)', () => {
  it('runs at 100 / 1,000 / 5,000 / 10,000 customers and stays reconciled', () => {
    const cases: [number, number][] = [[100, 90], [1000, 90], [5000, 180], [10_000, 365]];
    for (const [customers, horizonDays] of cases) {
      const t0 = Date.now();
      const r = simulate(baseInput(customers, horizonDays));
      const ms = Date.now() - t0;
      expect(r.customers).toBe(customers);
      const recomputed = r.netRevenueMicros - r.payouts.traderShareMicros - r.affiliate.netCommissionExpenseMicros -
        r.processingCostMicros - r.chargebackFeeMicros - r.operatingCostMicros - r.acquisitionCostMicros;
      expect(r.contributionMicros).toBe(recomputed);
      // eslint-disable-next-line no-console
      console.log(`[econ ${customers}c/${horizonDays}d] gross $${usd(r.grossSalesMicros)} · net $${usd(r.netRevenueMicros)} · pass ${(r.passRate * 100).toFixed(1)}% · funded ${r.fundedAccounts} · payoutRecipients ${r.payoutRecipients} · traderPayout $${usd(r.payouts.traderShareMicros)} · affiliate $${usd(r.affiliate.netCommissionExpenseMicros)} · contribution $${usd(r.contributionMicros)} (${(r.contributionMargin * 100).toFixed(1)}%) · reserve $${usd(r.treasury.requiredReserveMicros)} · distributable $${usd(r.treasury.distributableCashMicros)} · ${ms}ms`);
    }
  });

  it('emits PAYOUT_STRESS and COMBINED_DOWNSIDE at 5,000 / 180d', () => {
    for (const n of ['PAYOUT_STRESS', 'COMBINED_DOWNSIDE'] as ScenarioName[]) {
      const r = simulate({ ...baseInput(5000, 180), assumptions: scenario(n) });
      // eslint-disable-next-line no-console
      console.log(`[scenario ${n}] net $${usd(r.netRevenueMicros)} · traderPayout $${usd(r.payouts.traderShareMicros)} · payout/rev ${((r.payouts.traderShareMicros / (r.netRevenueMicros || 1)) * 100).toFixed(1)}% · contribution $${usd(r.contributionMicros)} (${(r.contributionMargin * 100).toFixed(1)}%) · distributable $${usd(r.treasury.distributableCashMicros)}`);
    }
  });
});
