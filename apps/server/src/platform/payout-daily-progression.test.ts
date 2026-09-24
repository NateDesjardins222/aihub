/**
 * Daily payout progressive qualifying-balance rule (Milestone 6).
 *
 * Each successive DAILY payout must qualify at a STRICTLY higher account balance
 * than the balance used for the previous approved Daily payout. The threshold is
 * snapshotted at the exactly-once approval boundary and never re-derived from the
 * mutable current balance. Pure-core cases prove the decision; service cases prove
 * the snapshot, its persistence across the debit, the approval-time authority, and
 * account completion at the fifth payout. CORE and SELECT are unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb, type Database } from '../db/client.js';
import { accounts, dailyAccountStats, payoutRequests, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { SYSTEM_ACTOR } from './actor.js';
import { approvePayout, getPayoutEligibility, markPaid, markProcessing, requestPayout, PayoutError } from './payouts.js';
import { evaluatePayoutEligibility, type EligibilityInput, type PayoutPolicy } from './payout-core.js';

const M = 1_000_000;
const $ = (d: number) => d * M;

// ---------------------------------------------------------------------------
// Pure-core cases (no DB): the decision itself.
// ---------------------------------------------------------------------------

function policy(model: 'CORE' | 'SELECT' | 'DAILY'): PayoutPolicy {
  return {
    model,
    profitSplitPercent: 0.9,
    activationFeeMicros: 0,
    winningDayThresholdMicros: $(150),
    requiredWinningDays: 0,
    payoutConsistencyThreshold: null,
    fundedBufferMicros: 0,
    requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(5000)] },
  };
}

function baseInput(over: Partial<EligibilityInput> & { balanceMicros: number }): EligibilityInput {
  return {
    policy: policy('DAILY'),
    balanceMicros: over.balanceMicros,
    startingBalanceMicros: $(50_000),
    days: [],
    cycleStartDate: null,
    dailyModeUnlocked: true,
    accountStatus: 'ACTIVE',
    adminHold: null,
    hold: null,
    hasPendingRequest: false,
    previousDailyQualifyingBalanceMicros: null,
    paidCycleCount: 0,
    maxPayoutCycles: 5,
    ...over,
  };
}

describe('DAILY progression — pure decision', () => {
  it('first payout has no previous threshold (rule inert)', () => {
    const e = evaluatePayoutEligibility(baseInput({ balanceMicros: $(54_350), previousDailyQualifyingBalanceMicros: null }), 1);
    expect(e.reasonCodes).not.toContain('DAILY_BALANCE_PROGRESSION_NOT_MET');
    expect(e.previousDailyQualifyingBalanceMicros).toBeNull();
    expect(e.requiredNextQualifyingBalanceMicros).toBeNull();
  });

  it('second payout at the EXACT previous balance is rejected', () => {
    const e = evaluatePayoutEligibility(baseInput({ balanceMicros: $(54_350), previousDailyQualifyingBalanceMicros: $(54_350) }), 2);
    expect(e.reasonCodes).toContain('DAILY_BALANCE_PROGRESSION_NOT_MET');
    expect(e.state).toBe('NOT_ELIGIBLE');
  });

  it('one micro-dollar below the previous balance is rejected', () => {
    const e = evaluatePayoutEligibility(baseInput({ balanceMicros: $(54_350) - 1, previousDailyQualifyingBalanceMicros: $(54_350) }), 2);
    expect(e.reasonCodes).toContain('DAILY_BALANCE_PROGRESSION_NOT_MET');
  });

  it('one micro-dollar above the previous balance passes the progression rule', () => {
    const e = evaluatePayoutEligibility(baseInput({ balanceMicros: $(54_350) + 1, previousDailyQualifyingBalanceMicros: $(54_350) }), 2);
    expect(e.reasonCodes).not.toContain('DAILY_BALANCE_PROGRESSION_NOT_MET');
  });

  it('reports previous / current / required-next thresholds for the UI', () => {
    const e = evaluatePayoutEligibility(baseInput({ balanceMicros: $(60_000), previousDailyQualifyingBalanceMicros: $(54_350) }), 2);
    expect(e.previousDailyQualifyingBalanceMicros).toBe($(54_350));
    expect(e.currentQualifyingBalanceMicros).toBe($(60_000));
    expect(e.requiredNextQualifyingBalanceMicros).toBe($(54_350) + 1);
  });

  it('CORE is unaffected by the progression rule', () => {
    const e = evaluatePayoutEligibility(
      baseInput({ balanceMicros: $(54_350), previousDailyQualifyingBalanceMicros: $(54_350), policy: policy('CORE') }),
      2,
    );
    expect(e.reasonCodes).not.toContain('DAILY_BALANCE_PROGRESSION_NOT_MET');
    expect(e.previousDailyQualifyingBalanceMicros).toBeNull();
  });

  it('SELECT is unaffected by the progression rule', () => {
    const e = evaluatePayoutEligibility(
      baseInput({ balanceMicros: $(54_350), previousDailyQualifyingBalanceMicros: $(54_350), policy: policy('SELECT') }),
      2,
    );
    expect(e.reasonCodes).not.toContain('DAILY_BALANCE_PROGRESSION_NOT_MET');
  });

  it('reaching the max payout cycles blocks further payouts', () => {
    const e = evaluatePayoutEligibility(baseInput({ balanceMicros: $(60_000), paidCycleCount: 5, maxPayoutCycles: 5 }), 6);
    expect(e.reasonCodes).toContain('MAX_CYCLES_REACHED');
  });

  it('below the max payout cycles does not block', () => {
    const e = evaluatePayoutEligibility(baseInput({ balanceMicros: $(60_000), paidCycleCount: 4, maxPayoutCycles: 5 }), 5);
    expect(e.reasonCodes).not.toContain('MAX_CYCLES_REACHED');
  });
});

// ---------------------------------------------------------------------------
// Service cases (real DB): the snapshot, persistence, and completion.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let db: Database;
let organizationId: string;
let seq = 0;

function fundedConfig(model: 'CORE' | 'SELECT' | 'DAILY', sizeMicros: number) {
  return {
    rules: {
      accountSizeMicros: sizeMicros, profitTargetMicros: 0, maxLossMicros: $(4000), drawdownType: 'STATIC' as const,
      trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const,
      consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0,
      maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50,
      microsCountAsFraction: false, flattenOnBreach: true,
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 50, perInstrument: {} },
    display: { startingBalanceMicros: sizeMicros },
    payoutRules: {
      model, profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5,
      payoutConsistencyThreshold: model === 'SELECT' ? 0.4 : null, fundedBufferMicros: model === 'DAILY' ? $(2000) : 0,
      requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(5000)] },
    },
    fundedDestinationKey: null, whopPlanId: null,
  };
}

async function makeUser(): Promise<string> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `dailyprog-${seq}-${Date.now()}@test.local`, passwordHash: await hashPassword('x'), displayName: 'Daily Prog', organizationId }).returning();
  return u!.id;
}

/** A Daily funded account, buffer-established and unlocked, at a given balance. */
async function makeDaily(balance: number): Promise<string> {
  const userId = await makeUser();
  const { accountId } = await provisionAccount(db, { organizationId, userId, profileKey: 'htf-daily-50k-prog' });
  await db.update(accounts).set({
    balanceMicros: balance, startingBalanceMicros: $(50_000), dayStartBalanceMicros: balance, dayStartEquityMicros: balance,
    highWaterMarkMicros: Math.max(balance, $(50_000)), activatedAt: new Date('2026-02-01T00:00:00Z'),
  }).where(eq(accounts.id, accountId));
  for (let i = 0; i < 5; i += 1) {
    const date = `2026-03-${String(i + 1).padStart(2, '0')}`;
    await db.insert(dailyAccountStats).values({
      accountId, tradeDate: date, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_000) + $(200),
      highEquityMicros: $(50_000) + $(200), lowEquityMicros: $(50_000), counted: true,
    });
  }
  return accountId;
}

async function setBalance(accountId: string, balance: number): Promise<void> {
  await db.update(accounts).set({ balanceMicros: balance, dayStartBalanceMicros: balance, dayStartEquityMicros: balance }).where(eq(accounts.id, accountId));
}
async function userOf(accountId: string): Promise<string> {
  const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return a!.userId;
}
/** Drive a payout all the way to PAID, returning the request id. */
async function payOut(accountId: string, gross: number, key: string): Promise<string> {
  const userId = await userOf(accountId);
  const req = await requestPayout(db, { accountId, userId, requestedGrossMicros: gross, idempotencyKey: key, actor: SYSTEM_ACTOR });
  await approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
  await markProcessing(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
  await markPaid(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
  return req.id;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: 'htf-daily-50k-prog', name: 'Daily 50K Prog', accountType: 'FUNDED_SIM', config: fundedConfig('DAILY', $(50_000)) });
  await publishProfileVersion(db, { organizationId, key: 'htf-core-50k-prog', name: 'Core 50K Prog', accountType: 'FUNDED_SIM', config: fundedConfig('CORE', $(50_000)) });
});
afterAll(async () => { await app.close(); });

describe('DAILY progression — service (real DB)', () => {
  it('the first approval snapshots the qualifying balance (pre-debit)', async () => {
    const acct = await makeDaily($(54_350));
    const id = await payOut(acct, $(500), `p1-${acct}`);
    const [row] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, id));
    expect(row!.qualifyingBalanceAtApproval).toBe($(54_350));
  });

  it('the snapshot survives the debit that lowers the balance', async () => {
    const acct = await makeDaily($(54_350));
    await payOut(acct, $(500), `p1-${acct}`); // balance now 53,850
    const elig = await getPayoutEligibility(db, acct);
    expect(elig.eligibility.previousDailyQualifyingBalanceMicros).toBe($(54_350));
    // The stored threshold is the pre-debit balance, not the current balance.
    expect(elig.account.balanceMicros).toBe($(53_850));
  });

  it('a second payout at the exact previous qualifying balance is rejected at approval', async () => {
    const acct = await makeDaily($(54_350));
    await payOut(acct, $(500), `p1-${acct}`);
    // Trade back up to exactly the previous qualifying balance.
    await setBalance(acct, $(54_350));
    const userId = await userOf(acct);
    await expect(
      requestPayout(db, { accountId: acct, userId, requestedGrossMicros: $(300), idempotencyKey: `p2-${acct}`, actor: SYSTEM_ACTOR }),
    ).rejects.toMatchObject({ reason: 'DAILY_BALANCE_PROGRESSION_NOT_MET' });
  });

  it('a second payout below the previous qualifying balance is rejected', async () => {
    const acct = await makeDaily($(54_350));
    await payOut(acct, $(500), `p1-${acct}`);
    await setBalance(acct, $(54_349));
    const userId = await userOf(acct);
    await expect(
      requestPayout(db, { accountId: acct, userId, requestedGrossMicros: $(300), idempotencyKey: `p2-${acct}`, actor: SYSTEM_ACTOR }),
    ).rejects.toMatchObject({ reason: 'DAILY_BALANCE_PROGRESSION_NOT_MET' });
  });

  it('a second payout strictly above the previous qualifying balance is accepted', async () => {
    const acct = await makeDaily($(54_350));
    await payOut(acct, $(500), `p1-${acct}`);
    await setBalance(acct, $(56_000)); // strictly above 54,350
    const userId = await userOf(acct);
    const req = await requestPayout(db, { accountId: acct, userId, requestedGrossMicros: $(300), idempotencyKey: `p2-${acct}`, actor: SYSTEM_ACTOR });
    const approved = await approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
    expect(approved.state).toBe('APPROVED');
    expect(approved.qualifyingBalanceAtApproval).toBe($(56_000));
  });

  it('a duplicate approval does not change the stored snapshot', async () => {
    const acct = await makeDaily($(54_350));
    const userId = await userOf(acct);
    const req = await requestPayout(db, { accountId: acct, userId, requestedGrossMicros: $(500), idempotencyKey: `p1-${acct}`, actor: SYSTEM_ACTOR });
    await approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
    await setBalance(acct, $(99_000)); // move the balance; a re-approve must not re-snapshot
    const again = await approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
    expect(again.qualifyingBalanceAtApproval).toBe($(54_350));
  });

  it('CORE accounts are never blocked by the progression rule', async () => {
    const userId = await makeUser();
    const { accountId } = await provisionAccount(db, { organizationId, userId, profileKey: 'htf-core-50k-prog' });
    await db.update(accounts).set({
      balanceMicros: $(53_000), startingBalanceMicros: $(50_000), dayStartBalanceMicros: $(53_000), dayStartEquityMicros: $(53_000),
      highWaterMarkMicros: $(53_000), activatedAt: new Date('2026-02-01T00:00:00Z'),
    }).where(eq(accounts.id, accountId));
    for (let i = 0; i < 5; i += 1) {
      await db.insert(dailyAccountStats).values({ accountId, tradeDate: `2026-03-0${i + 1}`, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true });
    }
    await payOut(accountId, $(500), `c1-${accountId}`);
    await setBalance(accountId, $(52_500)); // below the first payout's balance
    const userId2 = await userOf(accountId);
    // Core has no progression gate; a fresh cycle just needs winning days again.
    const elig = await getPayoutEligibility(db, accountId);
    expect(elig.eligibility.reasonCodes).not.toContain('DAILY_BALANCE_PROGRESSION_NOT_MET');
    void userId2;
  });

  it('the fifth paid payout completes the account and blocks a sixth', async () => {
    const acct = await makeDaily($(54_000));
    // Five payouts, each qualifying strictly higher than the last.
    for (let n = 1; n <= 5; n += 1) {
      await setBalance(acct, $(54_000) + n * $(1000));
      await payOut(acct, $(300), `pc${n}-${acct}`);
    }
    const [a] = await db.select().from(accounts).where(eq(accounts.id, acct));
    expect(a!.status).toBe('COMPLETED');
    // A sixth is blocked by the max-cycles cap.
    await setBalance(acct, $(70_000));
    const elig = await getPayoutEligibility(db, acct);
    expect(elig.eligibility.reasonCodes).toContain('MAX_CYCLES_REACHED');
    expect(elig.eligibility.state).toBe('NOT_ELIGIBLE');
  });
});
