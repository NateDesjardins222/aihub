/**
 * The production payout engine, against the real database.
 *
 * Money-safety is the whole point: the balance is debited exactly once at
 * approval, a duplicate or concurrent approval never double-debits, a rejected
 * payout never touches the balance, the ledger reconstructs the accounting, and
 * Core/Select/Daily eligibility behaves as specified. These run the real service
 * (transactions, advisory locks, the append-only ledger trigger), not a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb, type Database } from '../db/client.js';
import { accounts, dailyAccountStats, payoutLedger, payoutRequests, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { SYSTEM_ACTOR } from './actor.js';
import {
  approvePayout,
  cancelPayout,
  getPayoutEligibility,
  markPaid,
  markProcessing,
  rejectPayout,
  requestPayout,
  PayoutError,
} from './payouts.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
let app: FastifyInstance;
let db: Database;
let organizationId: string;
let seq = 0;

function fundedConfig(model: 'CORE' | 'SELECT' | 'DAILY', sizeMicros: number, overrides: Record<string, unknown> = {}) {
  return {
    rules: {
      accountSizeMicros: sizeMicros,
      profitTargetMicros: 0,
      maxLossMicros: $(2000),
      drawdownType: 'STATIC' as const,
      trailingLockAtMicros: null,
      dailyLossLimitMicros: null,
      dailyLossPolicy: 'LOCK_DAY' as const,
      consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const,
      consistencyThreshold: null,
      minTradingDays: 0,
      minWinningDays: 0,
      maxTradingDays: null,
      minDailyPnlToCountMicros: 0,
      minWinningDayPnlMicros: 1,
      maxContracts: 50,
      microsCountAsFraction: false,
      flattenOnBreach: true,
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 50, perInstrument: {} },
    display: { startingBalanceMicros: sizeMicros },
    payoutRules: {
      model,
      profitSplitPercent: 0.9,
      activationFeeMicros: 0,
      winningDayThresholdMicros: $(150),
      requiredWinningDays: 5,
      payoutConsistencyThreshold: model === 'SELECT' ? 0.4 : null,
      fundedBufferMicros: model === 'DAILY' ? $(2000) : 0,
      requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] },
      ...overrides,
    },
    fundedDestinationKey: null,
    whopPlanId: null,
  };
}

async function makeUser(): Promise<string> {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({ email: `payout-${seq}-${Date.now()}@test.local`, passwordHash: await hashPassword('x'), displayName: 'Payout Test', organizationId })
    .returning();
  return u!.id;
}

/** A funded account at a given balance, with `winDays` qualifying $200 days. */
async function makeFunded(
  key: string,
  opts: { balance: number; starting?: number; winDays?: number; bestExtra?: number },
): Promise<string> {
  const userId = await makeUser();
  const { accountId } = await provisionAccount(db, { organizationId, userId, profileKey: key });
  const starting = opts.starting ?? $(50_000);
  await db
    .update(accounts)
    .set({
      balanceMicros: opts.balance,
      startingBalanceMicros: starting,
      dayStartBalanceMicros: opts.balance,
      dayStartEquityMicros: opts.balance,
      highWaterMarkMicros: Math.max(opts.balance, starting),
      activatedAt: new Date('2026-02-01T00:00:00Z'),
    })
    .where(eq(accounts.id, accountId));
  const days = opts.winDays ?? 0;
  for (let i = 0; i < days; i += 1) {
    const date = `2026-03-${String(i + 1).padStart(2, '0')}`;
    const net = $(200);
    await db.insert(dailyAccountStats).values({
      accountId,
      tradeDate: date,
      startingBalanceMicros: $(50_000),
      endingBalanceMicros: $(50_000) + net,
      highEquityMicros: $(50_000) + net,
      lowEquityMicros: $(50_000),
      counted: true,
    });
  }
  if (opts.bestExtra) {
    await db.insert(dailyAccountStats).values({
      accountId,
      tradeDate: '2026-03-20',
      startingBalanceMicros: $(50_000),
      endingBalanceMicros: $(50_000) + opts.bestExtra,
      highEquityMicros: $(50_000) + opts.bestExtra,
      lowEquityMicros: $(50_000),
      counted: true,
    });
  }
  return accountId;
}

async function ledgerRows(payoutId: string) {
  return db.select().from(payoutLedger).where(eq(payoutLedger.payoutRequestId, payoutId));
}
async function balanceOf(accountId: string): Promise<number> {
  const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return a!.balanceMicros;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: 'htf-core-50k-t', name: 'Core 50K T', accountType: 'FUNDED_SIM', config: fundedConfig('CORE', $(50_000)) });
  await publishProfileVersion(db, { organizationId, key: 'htf-select-50k-t', name: 'Select 50K T', accountType: 'FUNDED_SIM', config: fundedConfig('SELECT', $(50_000)) });
  await publishProfileVersion(db, { organizationId, key: 'htf-daily-50k-t', name: 'Daily 50K T', accountType: 'FUNDED_SIM', config: fundedConfig('DAILY', $(50_000)) });
});
afterAll(async () => {
  await app.close();
});

describe('CORE payout — the money is debited exactly once', () => {
  it('requires 5 winning days, then approves and debits the balance once', async () => {
    const acct = await makeFunded('htf-core-50k-t', { balance: $(53_000), winDays: 5 });

    const elig = await getPayoutEligibility(db, acct);
    expect(elig.eligibility.state).toBe('ELIGIBLE');
    expect(elig.eligibility.grossWithdrawableMicros).toBe($(3000));

    const req = await requestPayout(db, { accountId: acct, userId: elig.account.userId, requestedGrossMicros: $(1000), idempotencyKey: `req-${acct}`, actor: SYSTEM_ACTOR });
    expect(req.state).toBe('REQUESTED');

    const approved = await approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
    expect(approved.state).toBe('APPROVED');
    expect(approved.traderShareMicros).toBe($(900));
    expect(approved.firmShareMicros).toBe($(100));
    expect(approved.balanceAdjustmentMicros).toBe($(1000));

    // The full gross left the account; starting balance is unchanged.
    expect(await balanceOf(acct)).toBe($(52_000));
    const [row] = await db.select().from(accounts).where(eq(accounts.id, acct));
    expect(row!.startingBalanceMicros).toBe($(50_000));

    // Exactly one DEBIT ledger row reconstructing the accounting.
    const ledger = await ledgerRows(req.id);
    const debits = ledger.filter((l) => l.entryType === 'DEBIT');
    expect(debits).toHaveLength(1);
    expect(debits[0]!.balanceBeforeMicros).toBe($(53_000));
    expect(debits[0]!.balanceAfterMicros).toBe($(52_000));
    expect(debits[0]!.traderShareMicros! + debits[0]!.firmShareMicros!).toBe($(1000));
  });

  it('a duplicate approval never debits twice', async () => {
    const acct = await makeFunded('htf-core-50k-t', { balance: $(53_000), winDays: 5 });
    const req = await requestPayout(db, { accountId: acct, userId: (await getPayoutEligibility(db, acct)).account.userId, requestedGrossMicros: $(1000), idempotencyKey: `dup-${acct}`, actor: SYSTEM_ACTOR });
    await approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
    // Second approval is a no-op.
    const again = await approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
    expect(again.state).toBe('APPROVED');
    expect(await balanceOf(acct)).toBe($(52_000)); // debited once
    const debits = (await ledgerRows(req.id)).filter((l) => l.entryType === 'DEBIT');
    expect(debits).toHaveLength(1);
  });

  it('two simultaneous approvals debit the balance exactly once', async () => {
    const acct = await makeFunded('htf-core-50k-t', { balance: $(53_000), winDays: 5 });
    const req = await requestPayout(db, { accountId: acct, userId: (await getPayoutEligibility(db, acct)).account.userId, requestedGrossMicros: $(1000), idempotencyKey: `race-${acct}`, actor: SYSTEM_ACTOR });
    // Fire both at once. The lock serializes them; the second sees APPROVED.
    const results = await Promise.allSettled([
      approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR }),
      approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(acct)).toBe($(52_000)); // once, never twice
    const debits = (await ledgerRows(req.id)).filter((l) => l.entryType === 'DEBIT');
    expect(debits).toHaveLength(1);
  });

  it('a duplicate request key returns the same row, not a second liability', async () => {
    const acct = await makeFunded('htf-core-50k-t', { balance: $(53_000), winDays: 5 });
    const uid = (await getPayoutEligibility(db, acct)).account.userId;
    const a = await requestPayout(db, { accountId: acct, userId: uid, requestedGrossMicros: $(1000), idempotencyKey: `same-${acct}`, actor: SYSTEM_ACTOR });
    const b = await requestPayout(db, { accountId: acct, userId: uid, requestedGrossMicros: $(1000), idempotencyKey: `same-${acct}`, actor: SYSTEM_ACTOR });
    expect(b.id).toBe(a.id);
    const all = await db.select().from(payoutRequests).where(eq(payoutRequests.accountId, acct));
    expect(all).toHaveLength(1);
  });

  it('a rejected payout never touches the balance', async () => {
    const acct = await makeFunded('htf-core-50k-t', { balance: $(53_000), winDays: 5 });
    const req = await requestPayout(db, { accountId: acct, userId: (await getPayoutEligibility(db, acct)).account.userId, requestedGrossMicros: $(1000), idempotencyKey: `rej-${acct}`, actor: SYSTEM_ACTOR });
    await rejectPayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR, reason: 'test' });
    expect(await balanceOf(acct)).toBe($(53_000));
    expect((await ledgerRows(req.id)).length).toBe(0);
  });

  it('rejects an ineligible request without moving money', async () => {
    const acct = await makeFunded('htf-core-50k-t', { balance: $(53_000), winDays: 4 }); // one short
    await expect(
      requestPayout(db, { accountId: acct, userId: (await getPayoutEligibility(db, acct)).account.userId, requestedGrossMicros: $(1000), actor: SYSTEM_ACTOR }),
    ).rejects.toBeInstanceOf(PayoutError);
    expect(await balanceOf(acct)).toBe($(53_000));
  });
});

describe('DAILY buffer + SELECT consistency', () => {
  it('DAILY protects the buffer through the whole request', async () => {
    const acct = await makeFunded('htf-daily-50k-t', { balance: $(53_500), winDays: 5 });
    const elig = await getPayoutEligibility(db, acct);
    expect(elig.eligibility.grossWithdrawableMicros).toBe($(1500)); // 3,500 - 2,000 buffer
    // Ceiling composes 50% of eligible: max request = floor(0.5 × 1,500) = $750.
    expect(elig.eligibility.maxRequestMicros).toBe($(750));
    const req = await requestPayout(db, { accountId: acct, userId: elig.account.userId, requestedGrossMicros: $(700), idempotencyKey: `d-${acct}`, actor: SYSTEM_ACTOR });
    await approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
    expect(await balanceOf(acct)).toBe($(52_800));
    // The buffer stays protected: a $600 request exceeds the new ceiling and is refused.
    await expect(
      requestPayout(db, { accountId: acct, userId: elig.account.userId, requestedGrossMicros: $(600), actor: SYSTEM_ACTOR }),
    ).rejects.toBeInstanceOf(PayoutError);
  });

  it('SELECT blocks a payout on consistency but never fails the account', async () => {
    // total net 2,500, best day 1,500 → 60% > 40%.
    const acct = await makeFunded('htf-select-50k-t', { balance: $(52_500), winDays: 5, bestExtra: $(1500) });
    const elig = await getPayoutEligibility(db, acct);
    expect(elig.eligibility.state).toBe('NOT_ELIGIBLE');
    expect(elig.eligibility.reasonCodes).toContain('CONSISTENCY_NOT_MET');
    const [row] = await db.select().from(accounts).where(eq(accounts.id, acct));
    expect(row!.status).toBe('ACTIVE'); // not failed
  });
});

describe('lifecycle: processing → paid writes a settlement and no extra balance move', () => {
  it('marks processing then paid with a settlement ledger entry', async () => {
    const acct = await makeFunded('htf-core-50k-t', { balance: $(53_000), winDays: 5 });
    const req = await requestPayout(db, { accountId: acct, userId: (await getPayoutEligibility(db, acct)).account.userId, requestedGrossMicros: $(1000), idempotencyKey: `pay-${acct}`, actor: SYSTEM_ACTOR });
    await approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
    await markProcessing(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
    const paid = await markPaid(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
    expect(paid.state).toBe('PAID');
    expect(await balanceOf(acct)).toBe($(52_000)); // unchanged since the debit
    const ledger = await ledgerRows(req.id);
    expect(ledger.filter((l) => l.entryType === 'DEBIT')).toHaveLength(1);
    expect(ledger.filter((l) => l.entryType === 'SETTLEMENT')).toHaveLength(1);
  });

  it('an illegal transition is refused', async () => {
    const acct = await makeFunded('htf-core-50k-t', { balance: $(53_000), winDays: 5 });
    const req = await requestPayout(db, { accountId: acct, userId: (await getPayoutEligibility(db, acct)).account.userId, requestedGrossMicros: $(1000), idempotencyKey: `bad-${acct}`, actor: SYSTEM_ACTOR });
    // Cannot pay a request that was never approved.
    await expect(markPaid(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR })).rejects.toBeInstanceOf(PayoutError);
    // Cancel is valid from REQUESTED.
    const cancelled = await cancelPayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR, reason: 'trader changed mind' });
    expect(cancelled.state).toBe('CANCELLED');
    expect(await balanceOf(acct)).toBe($(53_000));
  });
});
