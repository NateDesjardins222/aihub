/**
 * Pure unit tests for `rulesFromVersionConfig` — the safe extractor that reads a
 * pinned version's `config.rules` into the portal rule view (Product Rebuild
 * Phase 2, PV2-1). No database: this is deterministic parsing of authoritative
 * config, degrading to nulls rather than throwing.
 */
import { describe, expect, it } from 'vitest';
import { rulesFromVersionConfig } from './portal-accounts.js';

const M = 1_000_000;

const REAL_CONFIG = {
  rules: {
    accountSizeMicros: 50_000 * M,
    profitTargetMicros: 3_000 * M,
    maxLossMicros: 2_000 * M,
    drawdownType: 'EOD_TRAILING',
    trailingLockAtMicros: 0,
    dailyLossLimitMicros: null,
    dailyLossPolicy: 'LOCK_DAY',
    consistencyFormula: 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: 0.5,
    minTradingDays: 0,
    minWinningDays: 0,
    maxTradingDays: null,
    minDailyPnlToCountMicros: 0,
    minWinningDayPnlMicros: 150 * M,
    maxContracts: 5,
    microsCountAsFraction: true,
    flattenOnBreach: true,
  },
  display: { startingBalanceMicros: 50_000 * M, priceMicros: 95 * M },
};

describe('rulesFromVersionConfig', () => {
  it('reads every authoritative rule field from a real config', () => {
    const r = rulesFromVersionConfig(REAL_CONFIG);
    expect(r).toEqual({
      profitTargetMicros: 3_000 * M,
      maxLossMicros: 2_000 * M,
      drawdownType: 'EOD_TRAILING',
      trailingLockAtMicros: 0,
      consistencyFormula: 'BEST_DAY_OVER_TOTAL',
      consistencyThreshold: 0.5,
      minWinningDays: 0,
      minWinningDayPnlMicros: 150 * M,
      maxContracts: 5,
    });
  });

  it('passes through a funded target of 0 (already passed — deliberately not null)', () => {
    const r = rulesFromVersionConfig({ rules: { ...REAL_CONFIG.rules, profitTargetMicros: 0 } });
    expect(r!.profitTargetMicros).toBe(0);
  });

  it('never throws — degrades to null for missing / malformed config', () => {
    expect(rulesFromVersionConfig(null)).toBeNull();
    expect(rulesFromVersionConfig(undefined)).toBeNull();
    expect(rulesFromVersionConfig(42)).toBeNull();
    expect(rulesFromVersionConfig('nope')).toBeNull();
    expect(rulesFromVersionConfig({})).toBeNull(); // no rules key
    expect(rulesFromVersionConfig({ rules: null })).toBeNull();
    expect(rulesFromVersionConfig({ rules: 'bad' })).toBeNull();
  });

  it('degrades individual missing / wrong-typed fields to null, keeps valid ones', () => {
    const r = rulesFromVersionConfig({
      rules: {
        profitTargetMicros: 6_000 * M,
        // maxLossMicros missing
        drawdownType: 123, // wrong type
        consistencyThreshold: 'x', // wrong type
        maxContracts: 3,
      },
    });
    expect(r).toEqual({
      profitTargetMicros: 6_000 * M,
      maxLossMicros: null,
      drawdownType: null,
      trailingLockAtMicros: null,
      consistencyFormula: null,
      consistencyThreshold: null,
      minWinningDays: null,
      minWinningDayPnlMicros: null,
      maxContracts: 3,
    });
  });

  it('rejects non-finite numbers (NaN / Infinity) as null', () => {
    const r = rulesFromVersionConfig({ rules: { profitTargetMicros: NaN, maxLossMicros: Infinity } });
    expect(r!.profitTargetMicros).toBeNull();
    expect(r!.maxLossMicros).toBeNull();
  });
});
