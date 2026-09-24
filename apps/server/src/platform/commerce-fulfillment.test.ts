/**
 * Gated automatic provisioning + recovery, against the real database and HTTP.
 *
 * The milestone's core safety properties:
 *   - a paid purchase for an unverified customer PARKS recoverably (PROVISION_BLOCKED),
 *     never provisions, and the payment is not lost;
 *   - once the gate clears, the sweep provisions it EXACTLY ONCE;
 *   - an admin grant bypasses the gate deliberately;
 *   - a server-side verified mock event provisions; a browser has no path to;
 *   - a duplicate event makes no second account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { accounts, commercialOrders, customerIdentities, entitlements, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';
import { createPendingOrder, markOrderCompleted } from './commerce.js';
import { fulfillPurchaseGated, orderAccountId, retryPendingProvisioning } from './commerce-fulfillment.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { confirmContactVerification, startContactVerification } from './contact-verification.js';
import { resolveIdentityVerification, startIdentityVerification } from './identity-verification.js';
import { acceptAgreements, outstandingAgreements, seedDefaultAgreements } from './agreements.js';
import { signMockCommerceEvent } from './commerce-provider.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];
const EVAL_KEY = `fulfil-eval-${Math.random().toString(36).slice(2, 8)}`;

function config() {
  return {
    rules: {
      accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M,
      drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null,
      dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null,
      minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0,
      minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true,
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
    display: { startingBalanceMicros: 50_000 * M },
    payoutRules: null,
    fundedDestinationKey: null,
  };
}

async function makeUser(label: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId })
    .returning();
  users_.push(user!.id);
  return user!.id;
}

async function satisfyGate(userId: string): Promise<void> {
  const identity = await ensureCustomerIdentity(db, { organizationId, userId });
  const email = await startContactVerification(db, { identityId: identity.id, channel: 'EMAIL', value: `${userId}@g.test` });
  await confirmContactVerification(db, { challengeId: email.challengeId, code: email.devCode! });
  const sms = await startContactVerification(db, { identityId: identity.id, channel: 'SMS', value: '+15557778888' });
  await confirmContactVerification(db, { challengeId: sms.challengeId, code: sms.devCode! });
  await startIdentityVerification(db, { identityId: identity.id, legalName: 'Gate Clear' });
  await resolveIdentityVerification(db, { identityId: identity.id });
  const outstanding = await outstandingAgreements(db, organizationId, identity.id);
  await acceptAgreements(db, { organizationId, identityId: identity.id, userId, versionIds: outstanding.map((o) => o.versionId) });
}

async function completedPurchase(userId: string): Promise<string> {
  const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
  const order = await createPendingOrder(db, {
    organizationId, userId, productVersionId: product.versionId, source: 'PURCHASE',
    idempotencyKey: `test-${crypto.randomUUID()}`,
  });
  await markOrderCompleted(db, order.id, {});
  return order.id;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await seedDefaultAgreements(db, organizationId);
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'Fulfil Eval 50K', accountType: 'EVALUATION', config: config() });
});

afterAll(async () => {
  // Buyers with append-only acceptances cannot be cascade-deleted; leave rows.
  if (users_.length > 0) {
    const unverified = users_.filter(() => true);
    // Best-effort: drop identities/users that have no acceptances (unverified ones).
    for (const id of unverified) {
      await db.delete(customerIdentities).where(eq(customerIdentities.userId, id)).catch(() => undefined);
      await db.delete(users).where(eq(users.id, id)).catch(() => undefined);
    }
  }
  await app.close();
});

describe('gate parks an unverified purchase recoverably', () => {
  it('blocks provisioning and never creates an account', async () => {
    const userId = await makeUser('blocked');
    const orderId = await completedPurchase(userId);
    const result = await fulfillPurchaseGated(db, orderId, {});
    expect(result.status).toBe('PROVISION_BLOCKED');
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(order!.status).toBe('PROVISION_BLOCKED');
    expect(order!.provisionNote).toBeTruthy();
    const acct = await orderAccountId(db, orderId);
    expect(acct).toBeNull();
  });

  it('provisions exactly once after the gate clears, via the sweep', async () => {
    const userId = await makeUser('recover');
    const orderId = await completedPurchase(userId);
    const blocked = await fulfillPurchaseGated(db, orderId, {});
    expect(blocked.status).toBe('PROVISION_BLOCKED');

    await satisfyGate(userId);
    const swept = await retryPendingProvisioning(db);
    expect(swept).toBeGreaterThanOrEqual(1);

    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(order!.status).toBe('PROVISIONED');
    const ents = await db.select().from(entitlements).where(eq(entitlements.commercialOrderId, orderId));
    expect(ents).toHaveLength(1);
    expect(ents[0]!.status).toBe('CONSUMED');

    // Re-driving is idempotent: still one account.
    const again = await fulfillPurchaseGated(db, orderId, {});
    expect(again.status).toBe('PROVISIONED');
    const ents2 = await db.select().from(entitlements).where(eq(entitlements.commercialOrderId, orderId));
    expect(ents2).toHaveLength(1);
  });
});

describe('admin grant bypasses the gate', () => {
  it('provisions an ADMIN_GRANT order for an unverified user', async () => {
    const userId = await makeUser('admin-grant');
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const order = await createPendingOrder(db, {
      organizationId, userId, productVersionId: product.versionId, source: 'ADMIN_GRANT',
      idempotencyKey: `grant-${crypto.randomUUID()}`,
    });
    await markOrderCompleted(db, order.id, {});
    const result = await fulfillPurchaseGated(db, order.id, {});
    expect(result.status).toBe('PROVISIONED');
  });
});

describe('server-side mock webhook provisions; a browser cannot', () => {
  it('a pending order with no webhook never provisions (browser success is inert)', async () => {
    const userId = await makeUser('browser');
    await satisfyGate(userId);
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const order = await createPendingOrder(db, {
      organizationId, userId, productVersionId: product.versionId, source: 'PURCHASE',
      idempotencyKey: `browser-${crypto.randomUUID()}`,
    });
    // No webhook is posted — as if the browser saw "success" but nothing verified.
    const [row] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, order.id));
    expect(row!.status).toBe('PENDING');
    expect(await orderAccountId(db, order.id)).toBeNull();
  });

  it('a signed server-side mock event provisions exactly once (duplicate is harmless)', async () => {
    const userId = await makeUser('mock-webhook');
    await satisfyGate(userId);
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const order = await createPendingOrder(db, {
      organizationId, userId, productVersionId: product.versionId, source: 'PURCHASE',
      idempotencyKey: `mock-${crypto.randomUUID()}`,
    });

    const body = JSON.stringify({ id: `mev-${crypto.randomUUID()}`, type: 'payment.succeeded', atlasOrderId: order.id });
    const headers = { 'content-type': 'application/json', ...signMockCommerceEvent(body) };

    const first = await app.inject({ method: 'POST', url: '/api/v1/webhooks/mock', headers, payload: body });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).status).toBe('PROVISIONED');
    const accountId = JSON.parse(first.body).accountId;
    expect(accountId).toBeTruthy();

    // Duplicate delivery of the same event id — no second account.
    const second = await app.inject({ method: 'POST', url: '/api/v1/webhooks/mock', headers, payload: body });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).duplicate).toBe(true);
    const ents = await db.select().from(entitlements).where(eq(entitlements.commercialOrderId, order.id));
    expect(ents).toHaveLength(1);

    const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(acct!.accountType).toBe('EVALUATION');
  });

  it('a payment event for an unverified user parks PROVISION_BLOCKED (no account)', async () => {
    const userId = await makeUser('mock-blocked');
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const order = await createPendingOrder(db, {
      organizationId, userId, productVersionId: product.versionId, source: 'PURCHASE',
      idempotencyKey: `mockblk-${crypto.randomUUID()}`,
    });
    const body = JSON.stringify({ id: `mev-${crypto.randomUUID()}`, type: 'payment.succeeded', atlasOrderId: order.id });
    const headers = { 'content-type': 'application/json', ...signMockCommerceEvent(body) };
    const res = await app.inject({ method: 'POST', url: '/api/v1/webhooks/mock', headers, payload: body });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('PROVISION_BLOCKED');
    expect(await orderAccountId(db, order.id)).toBeNull();
  });
});
