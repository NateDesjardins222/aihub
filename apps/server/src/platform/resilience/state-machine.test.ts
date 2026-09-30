/**
 * Engineering Resilience Phase 3 — state-machine fuzzing (FAST tier + corpus + determinism).
 *
 * Seeded generation drives the lifecycle+payout state machine through valid, invalid,
 * duplicate, stale and malformed actions against the REAL backend, running the full
 * invariant oracle (Phase-1 integrity checks + Phase-2 reconciliation) after each
 * meaningful transition. The FAST tier runs in canonical; MEDIUM/DEEP run behind an
 * env flag. Optimised for state space explored, not test count.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../db/client.js';
import { defaultOrganizationId } from '../provisioning.js';
import { publishProfileVersion } from '../profiles.js';
import { updateOpsConfig, closeCircuitBreaker } from '../payout-ops-config.js';
import { resetMockPayoutProvider } from '../payout-provider-registry.js';
import { SYSTEM_ACTOR } from '../actor.js';
import { runIntegrityChecks } from './integrity-checks.js';
import { runSeed, replaySteps, shrink, type Step } from './model/fuzzer.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
let handle: ReturnType<typeof createDb>;
let db: ReturnType<typeof createDb>['db'];
let organizationId: string;
const EVAL_KEY = `sm-eval-${Math.random().toString(36).slice(2, 7)}`;
const FUNDED_KEY = `sm-dest-${Math.random().toString(36).slice(2, 7)}`;

function fundedConfig() {
  return {
    rules: { accountSizeMicros: $(50_000), profitTargetMicros: 0, maxLossMicros: $(2_000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: false, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: $(50_000) },
    payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000), $(2000), $(2000), $(2000), $(2000)] } },
    fundedDestinationKey: null, whopPlanId: null,
  };
}
function evalConfig() {
  return {
    rules: { accountSizeMicros: $(50_000), profitTargetMicros: $(3_000), maxLossMicros: $(2_000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: $(50_000), priceMicros: 95 * M },
    payoutRules: null, fundedDestinationKey: FUNDED_KEY, whopPlanId: null,
  };
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['DATABASE_URL'] = url;
  process.env['HTF_AUTO_FUNDING'] = 'false';
  // A dedicated pool with NO background workers: the fuzzer drives the payout/
  // lifecycle domain directly and asserts a deterministic authoritative digest,
  // which a background OutboxWorker/PayoutOpsWorker mutating state would break.
  handle = createDb(url);
  db = handle.db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: FUNDED_KEY, name: 'SM Funded 50K', accountType: 'FUNDED_SIM', config: fundedConfig() });
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'SM Eval 50K', accountType: 'EVALUATION', config: evalConfig() });
  await updateOpsConfig(db, organizationId, { provider: 'MOCK', actor: SYSTEM_ACTOR });
  resetMockPayoutProvider();
  await closeCircuitBreaker(db, organizationId, 'sm reset', SYSTEM_ACTOR).catch(() => undefined);
}, 60000);

afterAll(async () => { await handle?.sql.end({ timeout: 5 }); });

// The committed regression corpus: a handful of named, valuable seeds.
const CORPUS: readonly number[] = [
  1, 7, 42, 101, 1234, 2718, 31337, 65537, 80085, 999983,
];

describe('Part II–VI — state-machine fuzz (FAST): invariants hold across generated sequences', () => {
  it('runs the seed corpus with the invariant oracle after every transition', async () => {
    resetMockPayoutProvider();
    let totalTransitions = 0;
    let totalChecks = 0;
    for (const seed of CORPUS) {
      const r = await runSeed(db, organizationId, EVAL_KEY, seed, { steps: 45, checkEvery: 1 });
      totalTransitions += r.transitions;
      totalChecks += r.checks;
      expect(r.digest).toMatch(/^[0-9a-f]{8}$/);
    }
    // Report state-space explored (visible in test output).
    // eslint-disable-next-line no-console
    console.log(`[fuzz FAST] seeds=${CORPUS.length} transitions=${totalTransitions} checks=${totalChecks}`);
    expect(totalTransitions).toBeGreaterThan(100);
  }, 180000);

  it('is deterministic: the same seed yields the same authoritative digest', async () => {
    resetMockPayoutProvider();
    const a = await runSeed(db, organizationId, EVAL_KEY, 4242, { steps: 40, checkEvery: 6 });
    resetMockPayoutProvider();
    const b = await runSeed(db, organizationId, EVAL_KEY, 4242, { steps: 40, checkEvery: 6 });
    expect(b.digest).toBe(a.digest);
    expect(b.transitions).toBe(a.transitions);
  }, 120000);

  it('the shrinker reduces a synthetic failing sequence deterministically', async () => {
    // Predicate: "fails" if the sequence contains a RESET step (a stand-in for a real
    // invariant reproduction). Proves remove-range delta debugging converges to the
    // minimal reproducing subsequence.
    const seq: Step[] = [
      { name: 'CREATE_CUSTOMER' }, { name: 'PROVISION_EVAL', a: 0 }, { name: 'FAIL_EVAL', a: 0 },
      { name: 'RESET', a: 0 }, { name: 'PROVISION_EVAL', a: 1 }, { name: 'CERTIFY', a: 0 },
    ];
    const reproduces = async (c: Step[]) => c.some((s) => s.name === 'RESET');
    const minimal = await shrink(seq, reproduces);
    expect(minimal).toHaveLength(1);
    expect(minimal[0]!.name).toBe('RESET');
  });

  it('post-corpus: the global integrity suite is clean', async () => {
    const findings = await runIntegrityChecks(db);
    // No P0/P1 corruption anywhere after the FAST corpus.
    expect(findings.filter((f) => f.severity === 'P0' || f.severity === 'P1')).toEqual([]);
  });
});

// MEDIUM tier: explicit, behind an env flag so canonical stays fast.
describe.runIf(process.env['RESILIENCE_DEEP'] === '1')('MEDIUM — deep fuzz soak', () => {
  it('runs many seeds at higher depth', async () => {
    resetMockPayoutProvider();
    let totalTransitions = 0;
    const SEEDS = Number(process.env['RESILIENCE_SEEDS'] ?? 200);
    const STEPS = Number(process.env['RESILIENCE_STEPS'] ?? 200);
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const r = await runSeed(db, organizationId, EVAL_KEY, seed * 7919, { steps: STEPS, checkEvery: 5, reconcile: false });
      totalTransitions += r.transitions;
    }
    // eslint-disable-next-line no-console
    console.log(`[fuzz MEDIUM] seeds=${SEEDS} steps=${STEPS} transitions=${totalTransitions}`);
    const findings = await runIntegrityChecks(db);
    expect(findings.filter((f) => f.severity === 'P0' || f.severity === 'P1')).toEqual([]);
  }, 3_600_000);
});

// Keep the replay entrypoint referenced (used by the failure-reproduction workflow).
void replaySteps;
