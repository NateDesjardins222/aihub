/**
 * Product integrity — the authoritative Happy Trader V1 catalog.
 *
 * These are the guard rails that fail loudly if any product source drifts from
 * the locked commercial model again. They assert the built profiles (the single
 * source the seed, reconciliation and economics all consume) against the exact
 * locked values, so a future edit that changes a price, a drawdown, a contract
 * limit or the drawdown TYPE in only one place breaks the build.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_ACCOUNTS,
  EVAL_DRAWDOWN_TYPE,
  MAX_PAID_PAYOUT_CYCLES,
  MICROS,
  MICROS_PER_MINI,
  buildEvalProfile,
  buildFundedProfile,
  htfEvalProfiles,
  htfFundedProfiles,
} from './index.js';

/** The locked V1 catalog, transcribed from the phase spec (dollars). */
const LOCKED = [
  { id: 'htf-core-25k', family: 'CORE', price: 65, target: 1_500, dd: 1_000, minis: 2, micros: 20, evalC: 0.5, fundedC: null, buffer: 0, cap: 1_000 },
  { id: 'htf-core-50k', family: 'CORE', price: 95, target: 3_000, dd: 2_000, minis: 5, micros: 50, evalC: 0.5, fundedC: null, buffer: 0, cap: 2_000 },
  { id: 'htf-core-100k', family: 'CORE', price: 170, target: 6_000, dd: 4_000, minis: 10, micros: 100, evalC: 0.5, fundedC: null, buffer: 0, cap: 3_500 },
  { id: 'htf-core-300k', family: 'CORE', price: 599, target: 15_000, dd: 10_000, minis: 20, micros: 200, evalC: 0.5, fundedC: null, buffer: 0, cap: 5_000 },
  { id: 'htf-select-25k', family: 'SELECT', price: 85, target: 1_500, dd: 1_250, minis: 3, micros: 30, evalC: 0.4, fundedC: 0.4, buffer: 0, cap: 1_000 },
  { id: 'htf-select-50k', family: 'SELECT', price: 135, target: 3_000, dd: 2_500, minis: 7, micros: 70, evalC: 0.4, fundedC: 0.4, buffer: 0, cap: 2_000 },
  { id: 'htf-select-100k', family: 'SELECT', price: 230, target: 6_000, dd: 5_000, minis: 15, micros: 150, evalC: 0.4, fundedC: 0.4, buffer: 0, cap: 3_500 },
  { id: 'htf-daily-25k', family: 'DAILY', price: 90, target: 1_500, dd: 1_000, minis: 2, micros: 20, evalC: 0.4, fundedC: null, buffer: 1_000, cap: 1_000 },
  { id: 'htf-daily-50k', family: 'DAILY', price: 145, target: 3_000, dd: 2_000, minis: 5, micros: 50, evalC: 0.4, fundedC: null, buffer: 2_000, cap: 2_000 },
  { id: 'htf-daily-100k', family: 'DAILY', price: 250, target: 6_000, dd: 4_000, minis: 10, micros: 100, evalC: 0.4, fundedC: null, buffer: 4_000, cap: 3_500 },
] as const;

const evals = htfEvalProfiles();
const byId = new Map(evals.map((p) => [p.key, p]));

describe('authoritative commercial catalog', () => {
  it('has exactly 10 commercial evaluation products', () => {
    expect(evals).toHaveLength(10);
    expect(evals.every((p) => p.commercial && p.accountType === 'EVALUATION')).toBe(true);
  });

  it('has unique, deterministic, expected stable IDs', () => {
    const ids = evals.map((p) => p.key).sort();
    expect(new Set(ids).size).toBe(10);
    expect(ids).toEqual([...LOCKED].map((l) => l.id).sort());
  });

  it('MAX_PAID_PAYOUT_CYCLES is 5', () => {
    expect(MAX_PAID_PAYOUT_CYCLES).toBe(5);
  });

  for (const l of LOCKED) {
    describe(l.id, () => {
      const p = byId.get(l.id)!;
      it('exists', () => expect(p).toBeTruthy());
      it('price', () => expect(p.config.display.priceMicros).toBe(l.price * MICROS));
      it('profit target', () => expect(p.config.rules.profitTargetMicros).toBe(l.target * MICROS));
      it('drawdown amount', () => expect(p.config.rules.maxLossMicros).toBe(l.dd * MICROS));
      it('drawdown TYPE is EOD_TRAILING', () => expect(p.config.rules.drawdownType).toBe('EOD_TRAILING'));
      it('evaluation consistency', () => expect(p.config.rules.consistencyThreshold).toBe(l.evalC));
      it('funded/payout consistency', () =>
        expect(p.config.payoutRules.payoutConsistencyThreshold).toBe(l.fundedC));
      it('contract limit = minis, micros fraction on', () => {
        expect(p.config.rules.maxContracts).toBe(l.minis);
        expect(p.config.rules.microsCountAsFraction).toBe(true);
      });
      it('winning days 5 @ $150', () => {
        expect(p.config.payoutRules.requiredWinningDays).toBe(5);
        expect(p.config.payoutRules.winningDayThresholdMicros).toBe(150 * MICROS);
        expect(p.config.rules.minWinningDayPnlMicros).toBe(150 * MICROS);
      });
      it('payout cap', () =>
        expect(p.config.payoutRules.requestCaps.maxRequestMicrosByOrdinal).toEqual([l.cap * MICROS]));
      it('90/10 split', () => expect(p.config.payoutRules.profitSplitPercent).toBe(0.9));
      it('$0 activation', () => expect(p.config.payoutRules.activationFeeMicros).toBe(0));
      it('daily buffer', () => expect(p.config.payoutRules.fundedBufferMicros).toBe(l.buffer * MICROS));
      it('no daily loss limit', () => expect(p.config.rules.dailyLossLimitMicros).toBeNull());
    });
  }
});

describe('regression guards', () => {
  it('CORE 300K Gold is 15000 / 10000 (NOT 18000 / 12000)', () => {
    const g = byId.get('htf-core-300k')!;
    expect(g.config.rules.profitTargetMicros).toBe(15_000 * MICROS);
    expect(g.config.rules.maxLossMicros).toBe(10_000 * MICROS);
    expect(g.name).toContain('Gold');
  });

  it('SELECT drawdowns are 1250 / 2500 / 5000 (5%, NOT 4%)', () => {
    expect(byId.get('htf-select-25k')!.config.rules.maxLossMicros).toBe(1_250 * MICROS);
    expect(byId.get('htf-select-50k')!.config.rules.maxLossMicros).toBe(2_500 * MICROS);
    expect(byId.get('htf-select-100k')!.config.rules.maxLossMicros).toBe(5_000 * MICROS);
  });

  it('every commercial product uses EOD_TRAILING', () => {
    expect(evals.every((p) => p.config.rules.drawdownType === EVAL_DRAWDOWN_TYPE)).toBe(true);
    expect(EVAL_DRAWDOWN_TYPE).toBe('EOD_TRAILING');
  });
});

describe('contract-limit invariant (minis/micros)', () => {
  it('every account has micros === minis × 10', () => {
    for (const a of ALL_ACCOUNTS) expect(a.micros).toBe(a.minis * MICROS_PER_MINI);
    expect(MICROS_PER_MINI).toBe(10);
  });
});

describe('funded destinations', () => {
  const funded = htfFundedProfiles();
  it('are 10, internal (not commercial), zero target', () => {
    expect(funded).toHaveLength(10);
    expect(funded.every((p) => !p.commercial && p.accountType === 'FUNDED_SIM')).toBe(true);
    expect(funded.every((p) => p.config.rules.profitTargetMicros === 0)).toBe(true);
  });
  it('mirror the evaluation drawdown amount + type', () => {
    const f = buildFundedProfile('CORE', ALL_ACCOUNTS.find((a) => a.family === 'CORE' && a.sizeUsd === 50_000)!);
    const e = buildEvalProfile('CORE', ALL_ACCOUNTS.find((a) => a.family === 'CORE' && a.sizeUsd === 50_000)!);
    expect(f.config.rules.maxLossMicros).toBe(e.config.rules.maxLossMicros);
    expect(f.config.rules.drawdownType).toBe('EOD_TRAILING');
    expect(f.config.fundedDestinationKey).toBeNull();
    expect(f.config.display.priceMicros).toBeUndefined();
  });
});
