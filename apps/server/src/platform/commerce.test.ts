/**
 * The commercial account lifecycle, end to end, against the real database.
 *
 * The guarantees under test are the ones a payment provider will lean on and a
 * mock would merely assume: a webhook that fires twice makes one account; a
 * pass is certified once, server-authoritatively, and cannot be reversed; a
 * qualification produces exactly one funded account no matter how many times
 * approval is clicked; and an admin grant travels the identical path as a
 * purchase. No money moves anywhere in here - that is the point.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import {
  accountLifecycles,
  accountQualifications,
  accounts,
  auditLog,
  commercialOrders,
  domainEvents,
  entitlements,
  users,
} from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';
import { certifyPassedEvaluations } from './commerce-certify.js';
import {
  CommerceError,
  acquireEvaluation,
  approveFunding,
  certifyEvaluation,
  completeCommercialOrder,
  declineFunding,
  grantEntitlement,
  provisionFromEntitlement,
} from './commerce.js';

const M = 1_000_000;

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];

const EVAL_KEY = `eval-${Math.random().toString(36).slice(2, 8)}`;
const FUNDED_KEY = `funded-${Math.random().toString(36).slice(2, 8)}`;
const EVAL_NO_DEST_KEY = `evalnd-${Math.random().toString(36).slice(2, 8)}`;

/** Permissive, fast-qualifying terms: one requirement, a low profit target. */
function rules(overrides: Record<string, unknown> = {}) {
  return {
    accountSizeMicros: 50_000 * M,
    profitTargetMicros: 3_000 * M,
    maxLossMicros: 2_000 * M,
    drawdownType: 'STATIC',
    trailingLockAtMicros: null,
    dailyLossLimitMicros: null,
    dailyLossPolicy: 'LOCK_DAY',
    consistencyFormula: 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: null,
    minTradingDays: 0,
    minWinningDays: 0,
    maxTradingDays: null,
    minDailyPnlToCountMicros: 0,
    minWinningDayPnlMicros: 1,
    maxContracts: 10,
    microsCountAsFraction: true,
    flattenOnBreach: true,
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    rules: rules((overrides['rules'] as Record<string, unknown>) ?? {}),
    execution: null,
    instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
    display: { startingBalanceMicros: 50_000 * M },
    payoutRules: null,
    fundedDestinationKey: (overrides['fundedDestinationKey'] as string | null) ?? null,
  };
}

async function makeUser(label: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`,
      passwordHash: await hashPassword('commerce-test-password'),
      displayName: label,
      organizationId,
    })
    .returning();
  users_.push(user!.id);
  return user!.id;
}

/** The version id a purchase of the evaluation product would pin. */
async function evalVersionId(): Promise<string> {
  return (await resolveProfileByKey(db, organizationId, EVAL_KEY)).versionId;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);

  // The funded destination must exist before the evaluation names it.
  await publishProfileVersion(db, {
    organizationId,
    key: FUNDED_KEY,
    name: 'Funded Sim 50K',
    accountType: 'FUNDED_SIM',
    config: config({ rules: { profitTargetMicros: 0, maxLossMicros: 2_000 * M } }),
  });
  await publishProfileVersion(db, {
    organizationId,
    key: EVAL_KEY,
    name: 'Evaluation 50K',
    accountType: 'EVALUATION',
    config: config({ fundedDestinationKey: FUNDED_KEY }),
  });
  // An evaluation product with no funded destination configured.
  await publishProfileVersion(db, {
    organizationId,
    key: EVAL_NO_DEST_KEY,
    name: 'Evaluation No Destination',
    accountType: 'EVALUATION',
    config: config(),
  });
});

afterAll(async () => {
  // A qualification's funded-account link has no delete cascade, so the rows
  // must come out before the accounts they point at (cascaded from the user).
  if (users_.length > 0) {
    const owned = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(inArray(accounts.userId, users_));
    const ids = owned.map((a) => a.id);
    if (ids.length > 0) {
      await db.delete(accountQualifications).where(inArray(accountQualifications.accountId, ids));
    }
  }
  for (const id of users_) await db.delete(users).where(eq(users.id, id));
  await app.close();
});

/** Push an account's balance to a passing level without driving the engine. */
async function fundToPass(accountId: string): Promise<void> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  const passing = account!.startingBalanceMicros + 3_500 * M; // > 3,000 target
  await db
    .update(accounts)
    .set({ balanceMicros: passing, highWaterMarkMicros: passing })
    .where(eq(accounts.id, accountId));
}

describe('acquisition', () => {
  it('completes an order, grants an entitlement and provisions one evaluation', async () => {
    const userId = await makeUser('acquire');
    const versionId = await evalVersionId();
    const result = await acquireEvaluation(db, {
      organizationId,
      userId,
      productVersionId: versionId,
      source: 'PURCHASE',
      externalProvider: 'demo',
      idempotencyKey: `order-${crypto.randomUUID()}`,
    });

    const [order] = await db
      .select()
      .from(commercialOrders)
      .where(eq(commercialOrders.id, result.orderId));
    expect(order!.status).toBe('COMPLETED');
    expect(order!.completedAt).not.toBeNull();

    const [ent] = await db.select().from(entitlements).where(eq(entitlements.id, result.entitlementId));
    expect(ent!.status).toBe('CONSUMED');
    expect(ent!.consumedByAccountId).toBe(result.accountId);

    const [account] = await db.select().from(accounts).where(eq(accounts.id, result.accountId));
    expect(account!.accountType).toBe('EVALUATION');
    expect(account!.status).toBe('ACTIVE');
    // The funded destination is pinned at acquisition (Phase 50).
    expect(account!.fundedProfileVersionId).not.toBeNull();
  });

  it('is idempotent: the same order key never makes a second account', async () => {
    const userId = await makeUser('acquire-idem');
    const versionId = await evalVersionId();
    const key = `order-${crypto.randomUUID()}`;
    const first = await acquireEvaluation(db, {
      organizationId,
      userId,
      productVersionId: versionId,
      source: 'PURCHASE',
      idempotencyKey: key,
    });
    const second = await acquireEvaluation(db, {
      organizationId,
      userId,
      productVersionId: versionId,
      source: 'PURCHASE',
      idempotencyKey: key,
    });

    expect(second.orderId).toBe(first.orderId);
    expect(second.accountId).toBe(first.accountId);
    expect(second.reused).toBe(true);

    const orders = await db
      .select()
      .from(commercialOrders)
      .where(and(eq(commercialOrders.userId, userId), eq(commercialOrders.idempotencyKey, key)));
    expect(orders).toHaveLength(1);
    const accountRows = await db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(accountRows).toHaveLength(1);
  });

  it('an admin grant travels the identical path, differing only in source', async () => {
    const userId = await makeUser('admin-grant');
    const versionId = await evalVersionId();
    const order = await completeCommercialOrder(db, {
      organizationId,
      userId,
      productVersionId: versionId,
      source: 'ADMIN_GRANT',
      idempotencyKey: `grant-${crypto.randomUUID()}`,
      actor: { type: 'ADMIN', userId, label: 'owner@atlas.test' },
    });
    expect(order.source).toBe('ADMIN_GRANT');
    const ent = await grantEntitlement(db, {
      organizationId,
      userId,
      commercialOrderId: order.id,
      productVersionId: versionId,
      kind: 'EVALUATION',
      source: 'ADMIN_GRANT',
    });
    const provisioned = await provisionFromEntitlement(db, ent.id);
    const [account] = await db.select().from(accounts).where(eq(accounts.id, provisioned.accountId));
    expect(account!.accountType).toBe('EVALUATION');
  });

  it('consuming an entitlement twice returns the same account', async () => {
    const userId = await makeUser('ent-idem');
    const versionId = await evalVersionId();
    const order = await completeCommercialOrder(db, {
      organizationId,
      userId,
      productVersionId: versionId,
      source: 'PURCHASE',
      idempotencyKey: `order-${crypto.randomUUID()}`,
    });
    const ent = await grantEntitlement(db, {
      organizationId,
      userId,
      commercialOrderId: order.id,
      productVersionId: versionId,
      kind: 'EVALUATION',
      source: 'PURCHASE',
    });
    const a = await provisionFromEntitlement(db, ent.id);
    const b = await provisionFromEntitlement(db, ent.id);
    expect(b.accountId).toBe(a.accountId);
    expect(b.reused).toBe(true);
  });
});

describe('certification (server-authoritative pass)', () => {
  it('refuses to certify an evaluation that has not met its target', async () => {
    const userId = await makeUser('not-yet');
    const versionId = await evalVersionId();
    const { accountId } = await acquireEvaluation(db, {
      organizationId,
      userId,
      productVersionId: versionId,
      source: 'PURCHASE',
    });
    const qual = await certifyEvaluation(db, accountId);
    expect(qual).toBeNull();
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(account!.status).toBe('ACTIVE');
  });

  it('certifies a passed evaluation, freezes it, and records immutable evidence', async () => {
    const userId = await makeUser('passes');
    const versionId = await evalVersionId();
    const { accountId } = await acquireEvaluation(db, {
      organizationId,
      userId,
      productVersionId: versionId,
      source: 'PURCHASE',
    });
    await fundToPass(accountId);

    const qual = await certifyEvaluation(db, accountId);
    expect(qual).not.toBeNull();
    expect(qual!.fundingState).toBe('ELIGIBLE');

    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    // Frozen: terminal-after-pass. The order gate rejects with ACCOUNT_PASSED.
    expect(account!.status).toBe('PASSED');
    expect(account!.adminHold).toBe('QUALIFIED');

    // The current life is closed as PASSED.
    const [life] = await db
      .select()
      .from(accountLifecycles)
      .where(eq(accountLifecycles.id, account!.currentLifecycleId!));
    expect(life!.endReason).toBe('PASSED');
    expect(life!.endedAt).not.toBeNull();

    // Evidence is a snapshot, not a live read.
    const evidence = qual!.evidence as { requirements: Array<{ key: string; met: boolean }> };
    expect(evidence.requirements.some((r) => r.key === 'PROFIT_TARGET' && r.met)).toBe(true);

    const events = await db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.accountId, accountId));
    expect(events.map((e) => e.type)).toContain('evaluation.qualified');
  });

  it('is idempotent: a second certify returns the same qualification', async () => {
    const userId = await makeUser('passes-twice');
    const versionId = await evalVersionId();
    const { accountId } = await acquireEvaluation(db, {
      organizationId,
      userId,
      productVersionId: versionId,
      source: 'PURCHASE',
    });
    await fundToPass(accountId);
    const first = await certifyEvaluation(db, accountId);
    const second = await certifyEvaluation(db, accountId);
    expect(second!.id).toBe(first!.id);
    const rows = await db
      .select()
      .from(accountQualifications)
      .where(eq(accountQualifications.accountId, accountId));
    expect(rows).toHaveLength(1);
  });

  it('will not certify a failed evaluation', async () => {
    const userId = await makeUser('failed');
    const versionId = await evalVersionId();
    const { accountId } = await acquireEvaluation(db, {
      organizationId,
      userId,
      productVersionId: versionId,
      source: 'PURCHASE',
    });
    await db.update(accounts).set({ status: 'FAILED', ruleStatus: 'FAILED' }).where(eq(accounts.id, accountId));
    const qual = await certifyEvaluation(db, accountId);
    expect(qual).toBeNull();
  });

  it('the startup sweep certifies an evaluation the engine left PASSED', async () => {
    const userId = await makeUser('sweep');
    const versionId = await evalVersionId();
    const { accountId } = await acquireEvaluation(db, {
      organizationId,
      userId,
      productVersionId: versionId,
      source: 'PURCHASE',
    });
    await fundToPass(accountId);
    // Simulate the engine's reversible PASSED with no qualification yet.
    await db.update(accounts).set({ status: 'PASSED', ruleStatus: 'PASSED' }).where(eq(accounts.id, accountId));

    const certified = await certifyPassedEvaluations(db);
    expect(certified).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select()
      .from(accountQualifications)
      .where(eq(accountQualifications.accountId, accountId));
    expect(rows).toHaveLength(1);
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(account!.adminHold).toBe('QUALIFIED');
  });
});

describe('funding transition', () => {
  async function passedQualification(label: string): Promise<{ accountId: string; qualificationId: string; userId: string }> {
    const userId = await makeUser(label);
    const versionId = await evalVersionId();
    const { accountId } = await acquireEvaluation(db, {
      organizationId,
      userId,
      productVersionId: versionId,
      source: 'PURCHASE',
    });
    await fundToPass(accountId);
    const qual = await certifyEvaluation(db, accountId);
    return { accountId, qualificationId: qual!.id, userId };
  }

  it('approves funding into exactly one FUNDED_SIM account, linked back', async () => {
    const { accountId, qualificationId } = await passedQualification('fund');
    const { fundedAccountId } = await approveFunding(db, qualificationId, {
      actor: { type: 'ADMIN', label: 'owner@atlas.test' },
    });

    const [funded] = await db.select().from(accounts).where(eq(accounts.id, fundedAccountId));
    expect(funded!.accountType).toBe('FUNDED_SIM');
    expect(funded!.sourceAccountId).toBe(accountId);
    expect(funded!.sourceQualificationId).toBe(qualificationId);
    // The evaluation is NOT mutated into the funded account; both survive.
    expect(funded!.id).not.toBe(accountId);

    const [qual] = await db
      .select()
      .from(accountQualifications)
      .where(eq(accountQualifications.id, qualificationId));
    expect(qual!.fundingState).toBe('FUNDED');
    expect(qual!.fundedAccountId).toBe(fundedAccountId);
  });

  it('is idempotent: two approvals never make two funded accounts', async () => {
    const { qualificationId, userId } = await passedQualification('fund-idem');
    const a = await approveFunding(db, qualificationId);
    const b = await approveFunding(db, qualificationId);
    expect(b.fundedAccountId).toBe(a.fundedAccountId);
    expect(b.reused).toBe(true);

    const funded = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.accountType, 'FUNDED_SIM')));
    expect(funded).toHaveLength(1);
  });

  it('declines funding with a reason, and then refuses approval', async () => {
    const { qualificationId } = await passedQualification('decline');
    await declineFunding(db, qualificationId, 'Manual review failed', {
      type: 'ADMIN',
      label: 'owner@atlas.test',
    });
    const [qual] = await db
      .select()
      .from(accountQualifications)
      .where(eq(accountQualifications.id, qualificationId));
    expect(qual!.fundingState).toBe('DECLINED');
    expect(qual!.declineReason).toBe('Manual review failed');

    await expect(approveFunding(db, qualificationId)).rejects.toMatchObject({
      code: 'INVALID_FUNDING_STATE',
    });
  });

  it('refuses funding when the product names no funded destination', async () => {
    const userId = await makeUser('no-dest');
    const versionId = (await resolveProfileByKey(db, organizationId, EVAL_NO_DEST_KEY)).versionId;
    const { accountId } = await acquireEvaluation(db, {
      organizationId,
      userId,
      productVersionId: versionId,
      source: 'PURCHASE',
    });
    await fundToPass(accountId);
    const qual = await certifyEvaluation(db, accountId);
    await expect(approveFunding(db, qual!.id)).rejects.toMatchObject({
      code: 'NO_FUNDED_DESTINATION',
    });
  });

  it('writes an audit trail across the whole lifecycle', async () => {
    const { accountId, qualificationId } = await passedQualification('audited');
    await approveFunding(db, qualificationId);
    const rows = await db.select().from(auditLog).where(eq(auditLog.accountId, accountId));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('account.created');
    expect(actions).toContain('evaluation.qualified');
    expect(actions).toContain('funding.approved');
    for (const row of rows) expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('errors', () => {
  it('reports a missing entitlement and a missing qualification', async () => {
    await expect(provisionFromEntitlement(db, crypto.randomUUID())).rejects.toBeInstanceOf(CommerceError);
    await expect(approveFunding(db, crypto.randomUUID())).rejects.toMatchObject({
      code: 'QUALIFICATION_NOT_FOUND',
    });
  });
});
