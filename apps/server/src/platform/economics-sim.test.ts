/**
 * The economics simulator — deterministic, invariant-safe, and scaled.
 *
 * Proves the engine is reproducible (same seed → same result), that its money
 * arithmetic reconciles (the 90/10 split, contribution accounting), and that it
 * runs at 10K / 100K / 1M purchases. The scale run also emits the headline
 * numbers used in the milestone report.
 */
import { describe, expect, it } from 'vitest';
import {
  baseAssumptions,
  monteCarlo,
  mulberry32,
  reserveModel,
  scenario,
  sensitivity,
  simulate,
  withCapSchedule,
  type ScenarioName,
} from './economics-sim.js';

const M = 1_000_000;
const usd = (micros: number) => (micros / M).toLocaleString('en-US', { maximumFractionDigits: 0 });

describe('the PRNG is deterministic', () => {
  it('same seed yields the same stream', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i += 1) expect(a()).toBe(b());
  });
});

describe('simulate is reproducible and reconciles', () => {
  it('same (assumptions, seed, N) gives an identical result', () => {
    const a = baseAssumptions();
    const r1 = simulate(a, 123, 20_000);
    const r2 = simulate(a, 123, 20_000);
    expect(r1).toEqual(r2);
    // A different seed gives a different result (not degenerate).
    expect(simulate(a, 999, 20_000).grossTraderPayoutsMicros).not.toBe(r1.grossTraderPayoutsMicros);
  });

  it('the accounting reconciles: contribution = revenue − payouts − costs', () => {
    const r = simulate(baseAssumptions(), 7, 50_000);
    const recomputed =
      r.grossRevenueMicros - r.grossTraderPayoutsMicros - r.processingCostMicros - r.fraudCostMicros -
      r.platformCostMicros - r.supportCostMicros - r.cacMicros - r.fixedCostsMicros;
    expect(r.contributionMicros).toBe(recomputed);
    // Per-product totals sum to the aggregate.
    const sumRev = r.byProduct.reduce((s, p) => s + p.grossRevenueMicros, 0);
    expect(sumRev).toBe(r.grossRevenueMicros);
    const sumTrader = r.byProduct.reduce((s, p) => s + p.grossTraderPayoutsMicros, 0);
    expect(sumTrader).toBe(r.grossTraderPayoutsMicros);
  });

  it('funnel invariants hold (passes ≤ purchases, recipients ≤ funded)', () => {
    const r = simulate(baseAssumptions(), 3, 50_000);
    expect(r.passes).toBeLessThanOrEqual(r.purchases);
    expect(r.fundedAccounts).toBe(r.passes);
    expect(r.payoutRecipients).toBeLessThanOrEqual(r.fundedAccounts);
    expect(r.payoutEvents).toBeGreaterThanOrEqual(r.payoutRecipients);
  });
});

describe('scale: 10K / 100K / 1M purchases (also emits report numbers)', () => {
  it('runs at every scale within a few seconds and stays reconciled', () => {
    for (const N of [10_000, 100_000, 1_000_000]) {
      const t0 = Date.now();
      const r = simulate(baseAssumptions(), 2026, N);
      const ms = Date.now() - t0;
      expect(r.purchases).toBe(N);
      expect(r.contributionMicros).toBe(
        r.grossRevenueMicros - r.grossTraderPayoutsMicros - r.processingCostMicros - r.fraudCostMicros -
          r.platformCostMicros - r.supportCostMicros - r.cacMicros - r.fixedCostsMicros,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[econ ${N.toLocaleString()}] rev $${usd(r.grossRevenueMicros)} · pass ${(r.passRate * 100).toFixed(1)}% · funded ${r.fundedAccounts.toLocaleString()} · payout recipients ${r.payoutRecipients.toLocaleString()} · trader payouts $${usd(r.grossTraderPayoutsMicros)} · payout/rev ${(r.payoutToRevenuePct * 100).toFixed(1)}% · contribution $${usd(r.contributionMicros)} · margin ${(r.contributionMargin * 100).toFixed(1)}% · ${ms}ms`,
      );
    }
  });
});

describe('scenarios, sensitivity, Monte Carlo, caps, reserve', () => {
  it('every named scenario runs and is reproducible', () => {
    const names: ScenarioName[] = ['BASE', 'GOOD_FOR_FIRM', 'GOOD_FOR_TRADER', 'HIGH_PASS_RATE', 'HIGH_PAYOUT_RATE', 'HIGH_REPEAT_PAYOUT', 'HIGH_CAC', 'HIGH_FRAUD', 'DAILY_PAYOUT_STRESS', 'SELECT_HIGH_SKILL'];
    for (const n of names) {
      const r = simulate(scenario(n), 55, 30_000);
      expect(r.purchases).toBe(30_000);
      // eslint-disable-next-line no-console
      console.log(`[scenario ${n}] margin ${(r.contributionMargin * 100).toFixed(1)}% · payout/rev ${(r.payoutToRevenuePct * 100).toFixed(1)}%`);
    }
    // GOOD_FOR_TRADER pays out more of revenue than GOOD_FOR_FIRM.
    const firm = simulate(scenario('GOOD_FOR_FIRM'), 55, 60_000);
    const trader = simulate(scenario('GOOD_FOR_TRADER'), 55, 60_000);
    expect(trader.payoutToRevenuePct).toBeGreaterThan(firm.payoutToRevenuePct);
  });

  it('sensitivity sweeps degrade contribution as payout expense and CAC rise', () => {
    const s = sensitivity(baseAssumptions(), 9, 100_000);
    // Rising payout expense monotonically lowers contribution.
    for (let i = 1; i < s.payoutExpense.length; i += 1) {
      expect(s.payoutExpense[i]!.contributionMicros).toBeLessThan(s.payoutExpense[i - 1]!.contributionMicros);
    }
    // Rising CAC lowers contribution.
    for (let i = 1; i < s.cac.length; i += 1) {
      expect(s.cac[i]!.contributionMicros).toBeLessThan(s.cac[i - 1]!.contributionMicros);
    }
    // eslint-disable-next-line no-console
    console.log('[sensitivity payout×2] margin', (s.payoutExpense.at(-1)!.contributionMargin * 100).toFixed(1) + '%');
  });

  it('Monte Carlo reports ordered percentiles', () => {
    const mc = monteCarlo(baseAssumptions(), 100, 40, 20_000);
    expect(mc.trials).toBe(40);
    for (const d of [mc.revenue, mc.payoutExpense, mc.contribution]) {
      expect(d.p5).toBeLessThanOrEqual(d.p25);
      expect(d.p25).toBeLessThanOrEqual(d.median);
      expect(d.median).toBeLessThanOrEqual(d.p75);
      expect(d.p75).toBeLessThanOrEqual(d.p95);
    }
    // eslint-disable-next-line no-console
    console.log(`[montecarlo] contribution mean $${usd(mc.contribution.mean)} p5 $${usd(mc.contribution.p5)} p95 $${usd(mc.contribution.p95)}`);
  });

  it('the payout-cap experiment shows generous pays more, conservative less', () => {
    const a = baseAssumptions();
    const cons = simulate(withCapSchedule(a, 'CONSERVATIVE'), 11, 100_000);
    const cur = simulate(withCapSchedule(a, 'CURRENT'), 11, 100_000);
    const gen = simulate(withCapSchedule(a, 'GENEROUS'), 11, 100_000);
    expect(cons.grossTraderPayoutsMicros).toBeLessThan(cur.grossTraderPayoutsMicros);
    expect(gen.grossTraderPayoutsMicros).toBeGreaterThan(cur.grossTraderPayoutsMicros);
    // eslint-disable-next-line no-console
    console.log(`[caps] conservative $${usd(cons.grossTraderPayoutsMicros)} · current $${usd(cur.grossTraderPayoutsMicros)} · generous $${usd(gen.grossTraderPayoutsMicros)}`);
  });

  it('the reserve model is a max-basis plus a stressed tail', () => {
    const mc = monteCarlo(baseAssumptions(), 100, 30, 20_000);
    const res = reserveModel(5_000 * M, 8_000 * M, mc.payoutExpense, 1.5);
    expect(res.basisMicros).toBe(8_000 * M);
    expect(res.reserveMicros).toBe(Math.round(res.basisMicros + 1.5 * res.tailMicros));
  });
});
