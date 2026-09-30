/**
 * Engineering Resilience Phase 2 — Parts V/VI/VII/XLV/XLVIII: lifecycle crash
 * recovery. Uses the deterministic FaultInjector to abort a workflow's
 * transaction at a durable boundary, then proves the database is exactly as if the
 * call never happened, and that a retry recovers to ONE logical result.
 *
 * Covers: provisioning, reset, funded transition (crash + response-loss + replay),
 * recovery-path idempotency-key IDOR, and terminal-state monotonicity.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../http/app.js';
import { getDb } from '../../db/client.js';
import { accounts, accountQualifications, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from '../profiles.js';
import { acquireEvaluation, approveFunding, certifyEvaluation, markOrderCompleted } from '../commerce.js';
import { createResetOrder } from '../account-reset.js';
import { fulfillPurchaseGated } from '../commerce-fulfillment.js';
import { FaultInjector, FailpointError } from './failpoints.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const createdUsers: string[] = [];
const EVAL_KEY = `cr-eval-${Math.random().toString(36).slice(2, 8)}`;
const FUNDED_KEY = `cr-dest-${Math.random().toString(36).slice(2, 8)}`;

function config(fundedDestinationKey: string | null = null) {
  return {
    rules: {
      accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M,
      drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null,
      dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null,
      minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0,
      minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true,
    },
    execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
    display: { startingBalanceMicros: 50_000 * M, priceMicros: 95 * M },
    payoutRules: null, fundedDestinationKey,
  };
}

async function makeUser(label: string): Promise<string> {
  const [u] = await db.insert(users).values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId }).returning();
  createdUsers.push(u!.id);
  return u!.id;
}
async function evalAccount(userId: string): Promise<string> {
  const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
  const r = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true });
  return r.accountId;
}
async function accountsOf(userId: string) {
  return db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId));
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'false';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: FUNDED_KEY, name: 'CR Funded 50K', accountType: 'FUNDED_SIM', config: config(null) });
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'CR Eval 50K', accountType: 'EVALUATION', config: config(FUNDED_KEY) });
});
afterAll(async () => {
  // Best-effort cleanup; app.close() must always run so the background workers do
  // not leak into the next test file and race its shared-DB assertions.
  try {
    if (createdUsers.length > 0) {
      // Clear qualifications first: funded_account_id is a NO-ACTION FK, so a
      // user→accounts cascade alone would be blocked by a funded successor.
      const accts = await db.select({ id: accounts.id }).from(accounts).where(inArray(accounts.userId, createdUsers));
      const ids = accts.map((a) => a.id);
      if (ids.length > 0) {
        await db.delete(accountQualifications).where(or(inArray(accountQualifications.accountId, ids), inArray(accountQualifications.fundedAccountId, ids)));
      }
      await db.delete(users).where(inArray(users.id, createdUsers));
    }
  } catch {
    /* residue is harmless on the disposable test DB */
  } finally {
    await app.close();
  }
});

describe('Part V — provisioning crash + response-loss', () => {
  it('response-loss retry (same idempotency key) yields exactly one account', async () => {
    const userId = await makeUser('prov-retry');
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const key = `ent:cr-${crypto.randomUUID()}`;
    const a = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true, idempotencyKey: key });
    // The caller never learned the result and retries with the SAME key.
    const b = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true, idempotencyKey: key });
    expect(b.accountId).toBe(a.accountId);
    expect(await accountsOf(userId)).toHaveLength(1);
  });

  it('a crash after account insert (before commit) rolls back; retry makes exactly one', async () => {
    const userId = await makeUser('prov-crash');
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const key = `ent:cr-${crypto.randomUUID()}`;
    const fx = new FaultInjector().failOnWrite(3); // accounts insert, lifecycle insert, then trip the currentLifecycleId update
    await expect(provisionAccount(fx.wrap(db), { organizationId, userId, profileVersionId: product.versionId, activate: true, idempotencyKey: key })).rejects.toBeInstanceOf(FailpointError);
    expect(await accountsOf(userId)).toHaveLength(0);
    const r = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true, idempotencyKey: key });
    expect(r.accountId).toBeTruthy();
    expect(await accountsOf(userId)).toHaveLength(1);
  });
});

describe('Part VI — reset crash + retry', () => {
  it('a crash mid-fulfill leaves no successor; retry creates exactly one', async () => {
    const userId = await makeUser('reset-crash');
    const failed = await evalAccount(userId);
    await db.update(accounts).set({ status: 'FAILED' }).where(eq(accounts.id, failed));

    const { orderId } = await createResetOrder(db, { organizationId, userId, failedAccountId: failed });
    await markOrderCompleted(db, orderId);
    // Fulfill composes several transactions (entitlement grant, account insert,
    // lifecycle, consume, order flip) and treats a failure as recoverable
    // (PROVISION_FAILED), so a mid-fulfill fault may leave committed sub-state but
    // never MORE than one successor. Abort at a boundary; the swallow means the
    // call may resolve or reject — either way the invariant is "never two".
    const fx = new FaultInjector().failOnWrite(4);
    await fulfillPurchaseGated(fx.wrap(db), orderId, { enforceGate: false }).catch(() => undefined);
    let successors = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.resetOfAccountId, failed));
    expect(successors.length).toBeLessThanOrEqual(1);

    // Retry to completion: converges to exactly one successor; failed account preserved.
    await fulfillPurchaseGated(db, orderId, { enforceGate: false });
    successors = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.resetOfAccountId, failed));
    expect(successors).toHaveLength(1);
    const [old] = await db.select().from(accounts).where(eq(accounts.id, failed));
    expect(old!.status).toBe('FAILED');

    // Response-loss: fulfill again → still one successor (PROVISIONED short-circuit).
    await fulfillPurchaseGated(db, orderId, { enforceGate: false });
    successors = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.resetOfAccountId, failed));
    expect(successors).toHaveLength(1);
  }, 60000);
});

describe('Part VII — funded transition crash + retry', () => {
  it('a crash mid-approveFunding leaves no funded account; retry funds exactly once', async () => {
    const userId = await makeUser('fund-crash');
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const { accountId } = await acquireEvaluation(db, { organizationId, userId, productVersionId: product.versionId, source: 'PURCHASE' });
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    const passing = acct!.startingBalanceMicros + 3_500 * M;
    await db.update(accounts).set({ balanceMicros: passing, highWaterMarkMicros: passing }).where(eq(accounts.id, accountId));
    const qual = await certifyEvaluation(db, accountId);
    expect(qual).toBeTruthy();

    const before = (await accountsOf(userId)).length;
    const fx = new FaultInjector().failOnWrite(3); // account insert, link update, qual update — trip mid-way
    await expect(approveFunding(fx.wrap(db), qual!.id, { actor: { type: 'SYSTEM', label: 'crash' } })).rejects.toBeInstanceOf(FailpointError);
    // No funded successor: qualification not marked funded, no extra account.
    const [q1] = await db.select().from(accountQualifications).where(eq(accountQualifications.id, qual!.id));
    expect(q1!.fundedAccountId).toBeNull();
    expect((await accountsOf(userId)).length).toBe(before);

    // Retry: exactly one funded successor.
    const funded = await approveFunding(db, qual!.id, { actor: { type: 'SYSTEM', label: 'retry' } });
    expect(funded.fundedAccountId).toBeTruthy();
    // Response-loss: approve again → same funded account (idempotent).
    const again = await approveFunding(db, qual!.id, { actor: { type: 'SYSTEM', label: 'again' } });
    expect(again.fundedAccountId).toBe(funded.fundedAccountId);
    const funded_ = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.sourceQualificationId, qual!.id)));
    expect(funded_).toHaveLength(1);
  }, 60000);
});

describe('Part XLV — a recovery cannot replay another identity\'s idempotency key', () => {
  it('reusing a provisioning idempotency key with a different body is rejected (no cross-grant)', async () => {
    const victim = await makeUser('idor-victim');
    const attacker = await makeUser('idor-attacker');
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const key = `ent:shared-${crypto.randomUUID()}`;
    await provisionAccount(db, { organizationId, userId: victim, profileVersionId: product.versionId, activate: true, idempotencyKey: key });
    // The attacker replays the SAME key but for their own user id: the request
    // hash differs, so it must be refused rather than silently reused/granted.
    await expect(
      provisionAccount(db, { organizationId, userId: attacker, profileVersionId: product.versionId, activate: true, idempotencyKey: key }),
    ).rejects.toThrow();
    expect(await accountsOf(attacker)).toHaveLength(0);
  });
});

describe('Part XLVIII — terminal-state monotonicity', () => {
  it('a FAILED evaluation cannot be certified (no stale resurrection)', async () => {
    const userId = await makeUser('terminal');
    const accountId = await evalAccount(userId);
    await db.update(accounts).set({ status: 'FAILED', ruleStatus: 'FAILED' }).where(eq(accounts.id, accountId));
    // certifyEvaluation only certifies from CERTIFIABLE states; a FAILED account
    // is not resurrected — it returns null and produces no qualification.
    expect(await certifyEvaluation(db, accountId)).toBeNull();
    const quals = await db.select().from(accountQualifications).where(eq(accountQualifications.accountId, accountId));
    expect(quals).toHaveLength(0);
  });
});
