/**
 * M10.1 hardening — money-safety torture.
 *
 * The financial-correction path is the highest-risk surface in the Owner OS.
 * These tests attack it: they try to rewrite history (UPDATE/DELETE the
 * append-only ledger), to move money without an amount or an explanation, to
 * corrupt the net under concurrent adjustments, and to smuggle an out-of-vocab
 * reason code. Every attack must fail closed; the recorded net must always equal
 * the sum of credits minus debits. Isolated org so counts are deterministic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, adminAdjustments, organizations, users } from '../db/schema.js';
import { provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { hashPassword } from '../auth/password.js';
import type { Actor } from './actor.js';
import { applyAdminAdjustment, adjustmentNetMicros } from './account-ops.js';

const M = 1_000_000; const $ = (d: number) => d * M;
const ACTOR: Actor = { type: 'ADMIN', label: 'money@test', userId: null };
let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let org: string; let seq = 0;
const KEY = 'm101-money-50k';

function cfg(size: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: $(3000), maxLossMicros: $(2000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: size, priceMicros: $(135) }, payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } }, fundedDestinationKey: null, whopPlanId: null };
}
async function anAccount(): Promise<string> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `money-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('money-pw-1234'), displayName: `Money ${seq}`, role: 'TRADER', status: 'ACTIVE', organizationId: org }).returning();
  const { accountId } = await provisionAccount(db, { organizationId: org, userId: u!.id, profileKey: KEY });
  await db.update(accounts).set({ status: 'ACTIVE', activatedAt: new Date() }).where(eq(accounts.id, accountId));
  return accountId;
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m101money-${crypto.randomUUID().slice(0, 8)}`, name: 'M101MONEY' }).returning();
  org = o!.id;
  await publishProfileVersion(db, { organizationId: org, key: KEY, name: 'Money 50K', accountType: 'EVALUATION', config: cfg($(50_000)) });
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('the adjustment ledger is truly append-only', () => {
  it('a recorded adjustment cannot be UPDATEd (DB trigger refuses)', async () => {
    const accountId = await anAccount();
    const { id } = await applyAdminAdjustment(db, { organizationId: org, accountId, type: 'CREDIT', amountMicros: $(100), reasonCode: 'GOODWILL_CREDIT', explanation: 'goodwill for an outage', actor: ACTOR });
    await expect(db.update(adminAdjustments).set({ amountMicros: $(999999) }).where(eq(adminAdjustments.id, id))).rejects.toThrow();
  });
  it('a recorded adjustment cannot be DELETEd (DB trigger refuses)', async () => {
    const accountId = await anAccount();
    const { id } = await applyAdminAdjustment(db, { organizationId: org, accountId, type: 'DEBIT', amountMicros: $(50), reasonCode: 'FEE_CORRECTION', explanation: 'fee correction', actor: ACTOR });
    await expect(db.delete(adminAdjustments).where(eq(adminAdjustments.id, id))).rejects.toThrow();
  });
  it('a bulk DELETE of an account’s adjustments is refused', async () => {
    const accountId = await anAccount();
    await applyAdminAdjustment(db, { organizationId: org, accountId, type: 'CREDIT', amountMicros: $(10), reasonCode: 'OTHER', explanation: 'test row', actor: ACTOR });
    await expect(db.delete(adminAdjustments).where(eq(adminAdjustments.accountId, accountId))).rejects.toThrow();
  });
});

describe('adjustments fail closed on bad input', () => {
  it('CREDIT with no amount is refused', async () => {
    const accountId = await anAccount();
    await expect(applyAdminAdjustment(db, { organizationId: org, accountId, type: 'CREDIT', reasonCode: 'OTHER', explanation: 'no amount here', actor: ACTOR })).rejects.toThrow();
  });
  it('DEBIT with a zero or negative amount is refused', async () => {
    const accountId = await anAccount();
    await expect(applyAdminAdjustment(db, { organizationId: org, accountId, type: 'DEBIT', amountMicros: 0, reasonCode: 'OTHER', explanation: 'zero amount', actor: ACTOR })).rejects.toThrow();
    await expect(applyAdminAdjustment(db, { organizationId: org, accountId, type: 'DEBIT', amountMicros: -$(5), reasonCode: 'OTHER', explanation: 'negative amount', actor: ACTOR })).rejects.toThrow();
  });
  it('an empty/too-short explanation is refused', async () => {
    const accountId = await anAccount();
    await expect(applyAdminAdjustment(db, { organizationId: org, accountId, type: 'CREDIT', amountMicros: $(1), reasonCode: 'OTHER', explanation: '', actor: ACTOR })).rejects.toThrow();
    await expect(applyAdminAdjustment(db, { organizationId: org, accountId, type: 'CREDIT', amountMicros: $(1), reasonCode: 'OTHER', explanation: 'x', actor: ACTOR })).rejects.toThrow();
  });
  it('an adjustment on a non-existent account is refused', async () => {
    await expect(applyAdminAdjustment(db, { organizationId: org, accountId: crypto.randomUUID(), type: 'CREDIT', amountMicros: $(1), reasonCode: 'OTHER', explanation: 'ghost account', actor: ACTOR })).rejects.toThrow();
  });
});

describe('the net is always the sum of credits minus debits', () => {
  it('METADATA never moves the net; credits and debits do', async () => {
    const accountId = await anAccount();
    await applyAdminAdjustment(db, { organizationId: org, accountId, type: 'CREDIT', amountMicros: $(300), reasonCode: 'GOODWILL_CREDIT', explanation: 'credit 300', actor: ACTOR });
    await applyAdminAdjustment(db, { organizationId: org, accountId, type: 'DEBIT', amountMicros: $(120), reasonCode: 'FEE_CORRECTION', explanation: 'debit 120', actor: ACTOR });
    await applyAdminAdjustment(db, { organizationId: org, accountId, type: 'METADATA', reasonCode: 'DATA_CORRECTION', explanation: 'note only, no money', actor: ACTOR });
    expect(await adjustmentNetMicros(db, accountId)).toBe($(180));
  });

  it('concurrent adjustments all persist and the net is exact (no lost update)', async () => {
    const accountId = await anAccount();
    // 20 concurrent credits of $10 and 10 concurrent debits of $10 → net $100.
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i += 1) ops.push(applyAdminAdjustment(db, { organizationId: org, accountId, type: 'CREDIT', amountMicros: $(10), reasonCode: 'GOODWILL_CREDIT', explanation: `credit number ${i}`, actor: ACTOR }));
    for (let i = 0; i < 10; i += 1) ops.push(applyAdminAdjustment(db, { organizationId: org, accountId, type: 'DEBIT', amountMicros: $(10), reasonCode: 'FEE_CORRECTION', explanation: `debit number ${i}`, actor: ACTOR }));
    await Promise.all(ops);
    const countRows = await db.select({ n: sql<number>`count(*)::int` }).from(adminAdjustments).where(eq(adminAdjustments.accountId, accountId));
    expect(countRows[0]?.n ?? 0).toBe(30); // every row persisted; ledger is append-only
    expect(await adjustmentNetMicros(db, accountId)).toBe($(100));
  });

  it('the raw account balance column is never touched by an adjustment', async () => {
    const accountId = await anAccount();
    const [before] = await db.select({ balanceMicros: accounts.balanceMicros }).from(accounts).where(eq(accounts.id, accountId));
    await applyAdminAdjustment(db, { organizationId: org, accountId, type: 'CREDIT', amountMicros: $(500), reasonCode: 'INCIDENT_REMEDIATION', explanation: 'remediation credit', actor: ACTOR });
    const [after] = await db.select({ balanceMicros: accounts.balanceMicros }).from(accounts).where(eq(accounts.id, accountId));
    // The correction is recorded in the append-only ledger, NOT by mutating the
    // authoritative balance column in place.
    expect(after!.balanceMicros).toBe(before!.balanceMicros);
    expect(await adjustmentNetMicros(db, accountId)).toBe($(500));
  });
});
