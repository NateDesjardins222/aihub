/**
 * Account operations (M10-E). The financial-correction path is append-only and
 * reason-coded; there is no raw balance edit. Lifecycle wrappers delegate to the
 * authoritative account-service. Runs against the test database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, adminAdjustments, users } from '../db/schema.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { hashPassword } from '../auth/password.js';
import type { Actor } from './actor.js';
import { applyAdminAdjustment, adjustmentNetMicros, listAdjustments, previewAction, pauseAccount, resumeAccount } from './account-ops.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
const ACTOR: Actor = { type: 'ADMIN', label: 'ops@test', userId: null };
let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let organizationId: string;
let seq = 0;
const KEY = 'm10e-acctops-50k';

function cfg(size: number) {
  return {
    rules: { accountSizeMicros: size, profitTargetMicros: $(3000), maxLossMicros: $(2000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: size, priceMicros: $(135) },
    payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } },
    fundedDestinationKey: null, whopPlanId: null,
  };
}

async function anAccount(): Promise<{ accountId: string; userId: string }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `acctops-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('acctops-pw-1234'), displayName: `AcctOps ${seq}`, role: 'TRADER', status: 'ACTIVE', organizationId }).returning();
  const { accountId } = await provisionAccount(db, { organizationId, userId: u!.id, profileKey: KEY });
  await db.update(accounts).set({ status: 'ACTIVE', activatedAt: new Date() }).where(eq(accounts.id, accountId));
  return { accountId, userId: u!.id };
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: KEY, name: 'AcctOps 50K', accountType: 'EVALUATION', config: cfg($(50_000)) });
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('append-only admin adjustments (no raw balance edit)', () => {
  it('records a credit with a reason code and updates the observed net', async () => {
    const { accountId } = await anAccount();
    expect(await adjustmentNetMicros(db, accountId)).toBe(0);
    await applyAdminAdjustment(db, { organizationId, accountId, type: 'CREDIT', amountMicros: $(100), reasonCode: 'GOODWILL_CREDIT', explanation: 'goodwill for incident', actor: ACTOR });
    expect(await adjustmentNetMicros(db, accountId)).toBe($(100));
    await applyAdminAdjustment(db, { organizationId, accountId, type: 'DEBIT', amountMicros: $(30), reasonCode: 'FEE_CORRECTION', explanation: 'fee correction', actor: ACTOR });
    expect(await adjustmentNetMicros(db, accountId)).toBe($(70));
    expect((await listAdjustments(db, accountId)).length).toBe(2);
  });

  it('requires an explanation and a positive amount for credit/debit', async () => {
    const { accountId } = await anAccount();
    await expect(applyAdminAdjustment(db, { organizationId, accountId, type: 'CREDIT', amountMicros: $(10), explanation: 'x', reasonCode: 'OTHER', actor: ACTOR })).rejects.toThrow();
    await expect(applyAdminAdjustment(db, { organizationId, accountId, type: 'CREDIT', explanation: 'valid explanation', reasonCode: 'OTHER', actor: ACTOR })).rejects.toThrow();
    await expect(applyAdminAdjustment(db, { organizationId, accountId, type: 'DEBIT', amountMicros: -5, explanation: 'valid explanation', reasonCode: 'OTHER', actor: ACTOR })).rejects.toThrow();
  });

  it('METADATA adjustments carry no amount and do not move the net', async () => {
    const { accountId } = await anAccount();
    await applyAdminAdjustment(db, { organizationId, accountId, type: 'METADATA', reasonCode: 'DATA_CORRECTION', explanation: 'corrected a label', actor: ACTOR });
    expect(await adjustmentNetMicros(db, accountId)).toBe(0);
  });

  it('the adjustment ledger is append-only: UPDATE and DELETE are refused', async () => {
    const { accountId } = await anAccount();
    await applyAdminAdjustment(db, { organizationId, accountId, type: 'CREDIT', amountMicros: $(5), reasonCode: 'OTHER', explanation: 'immutable test', actor: ACTOR });
    const [row] = await db.select({ id: adminAdjustments.id }).from(adminAdjustments).where(eq(adminAdjustments.accountId, accountId));
    await expect(db.update(adminAdjustments).set({ explanation: 'tampered' }).where(eq(adminAdjustments.id, row!.id))).rejects.toThrow();
    await expect(db.delete(adminAdjustments).where(eq(adminAdjustments.id, row!.id))).rejects.toThrow();
  });

  it('records an audit event for every adjustment', async () => {
    const { accountId } = await anAccount();
    await applyAdminAdjustment(db, { organizationId, accountId, type: 'CREDIT', amountMicros: $(1), reasonCode: 'OTHER', explanation: 'audit check', actor: ACTOR });
    const { accountAudit } = await import('./audit.js');
    const rows = await accountAudit(db, accountId, 10);
    expect(rows.some((r) => r.action === 'admin.account.adjustment')).toBe(true);
  });
});

describe('action preview', () => {
  it('pause preview preserves risk-reducing actions and never touches balance', async () => {
    const { accountId } = await anAccount();
    const p = await previewAction(db, accountId, 'pause');
    expect(p.paymentRequired).toBe(false);
    expect(p.will.join(' ')).toMatch(/risk-reducing/i);
    expect(p.willNot.join(' ')).toMatch(/balance/i);
  });

  it('reset preview reports payment/preservation or a truthful block, never throws for a live account', async () => {
    const { accountId } = await anAccount();
    const p = await previewAction(db, accountId, 'reset');
    expect(p.action).toBe('reset');
    // An ACTIVE (non-failed) account is not resettable → a truthful block.
    expect(typeof p.paymentRequired).toBe('boolean');
  });

  it('an unknown action is rejected', async () => {
    const { accountId } = await anAccount();
    await expect(previewAction(db, accountId, 'nuke')).rejects.toThrow();
  });
});

describe('pause / resume', () => {
  it('pause sets the operator hold and resume clears it', async () => {
    const { accountId } = await anAccount();
    const paused = await pauseAccount(db, accountId, 'suspicious activity review', ACTOR);
    expect(paused.adminHold).toBe('LOCKED');
    expect(paused.status).toBe('LOCKED');
    const resumed = await resumeAccount(db, accountId, 'review cleared', ACTOR);
    expect(resumed.adminHold).toBeNull();
  });

  it('pause requires a reason', async () => {
    const { accountId } = await anAccount();
    await expect(pauseAccount(db, accountId, '', ACTOR)).rejects.toThrow();
  });
});
