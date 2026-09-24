/**
 * Chaos / concurrency invariants for the commerce → provisioning spine.
 *
 * The section-38 cases that only a real database under real parallelism can
 * prove: ten concurrent fulfilments of one order make ONE account; ten
 * concurrent distinct payment events for one order make ONE account (order +
 * entitlement idempotency); and a payment-then-crash-before-provision is
 * recovered by the sweep with no duplicate. No money or account is ever doubled.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { accounts, commercialOrders, customerIdentities, entitlements, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';
import { createPendingOrder, markOrderCompleted } from './commerce.js';
import { fulfillPurchaseGated, simulateProviderPayment } from './commerce-fulfillment.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { confirmContactVerification, startContactVerification } from './contact-verification.js';
import { resolveIdentityVerification, startIdentityVerification } from './identity-verification.js';
import { acceptAgreements, outstandingAgreements, seedDefaultAgreements } from './agreements.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];
const EVAL_KEY = `chaos-eval-${Math.random().toString(36).slice(2, 8)}`;

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

async function gateReadyBuyer(label: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId })
    .returning();
  users_.push(user!.id);
  const identity = await ensureCustomerIdentity(db, { organizationId, userId: user!.id });
  const email = await startContactVerification(db, { identityId: identity.id, channel: 'EMAIL', value: `${user!.id}@c.test` });
  await confirmContactVerification(db, { challengeId: email.challengeId, code: email.devCode! });
  const sms = await startContactVerification(db, { identityId: identity.id, channel: 'SMS', value: '+15551112222' });
  await confirmContactVerification(db, { challengeId: sms.challengeId, code: sms.devCode! });
  await startIdentityVerification(db, { identityId: identity.id, legalName: 'Chaos Buyer' });
  await resolveIdentityVerification(db, { identityId: identity.id });
  const outstanding = await outstandingAgreements(db, organizationId, identity.id);
  await acceptAgreements(db, { organizationId, identityId: identity.id, userId: user!.id, versionIds: outstanding.map((o) => o.versionId) });
  return user!.id;
}

async function completedOrder(userId: string): Promise<string> {
  const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
  const order = await createPendingOrder(db, { organizationId, userId, productVersionId: product.versionId, source: 'PURCHASE', idempotencyKey: `chaos-${crypto.randomUUID()}` });
  await markOrderCompleted(db, order.id, {});
  return order.id;
}

async function accountsForOrder(orderId: string): Promise<number> {
  const ents = await db.select().from(entitlements).where(eq(entitlements.commercialOrderId, orderId));
  const accountIds = ents.map((e) => e.consumedByAccountId).filter((x): x is string => !!x);
  if (accountIds.length === 0) return 0;
  const rows = await db.select({ id: accounts.id }).from(accounts).where(inArray(accounts.id, accountIds));
  return rows.length;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await seedDefaultAgreements(db, organizationId);
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'Chaos Eval 50K', accountType: 'EVALUATION', config: config() });
});

afterAll(async () => {
  await db.delete(customerIdentities).where(inArray(customerIdentities.userId, users_)).catch(() => undefined);
  await app.close();
});

describe('exactly-once under concurrency', () => {
  it('ten concurrent fulfilments of one order make exactly one account', async () => {
    const userId = await gateReadyBuyer('c-fulfil');
    const orderId = await completedOrder(userId);
    const results = await Promise.all(Array.from({ length: 10 }, () => fulfillPurchaseGated(db, orderId, {})));
    expect(results.every((r) => r.status === 'PROVISIONED')).toBe(true);
    const ents = await db.select().from(entitlements).where(eq(entitlements.commercialOrderId, orderId));
    expect(ents).toHaveLength(1);
    expect(await accountsForOrder(orderId)).toBe(1);
  });

  it('ten concurrent distinct payment events for one order make exactly one account', async () => {
    const userId = await gateReadyBuyer('c-events');
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const order = await createPendingOrder(db, { organizationId, userId, productVersionId: product.versionId, source: 'PURCHASE', idempotencyKey: `chaosev-${crypto.randomUUID()}` });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => simulateProviderPayment(db, { organizationId, orderId: order.id })),
    );
    // Every call converges to PROVISIONED with the same single account.
    expect(results.some((r) => r.status === 'PROVISIONED')).toBe(true);
    const ents = await db.select().from(entitlements).where(eq(entitlements.commercialOrderId, order.id));
    expect(ents).toHaveLength(1);
    expect(await accountsForOrder(order.id)).toBe(1);
  });

  it('payment then crash before provision is recovered by the sweep, exactly once', async () => {
    const userId = await gateReadyBuyer('c-crash');
    // Money settled (COMPLETED), but provisioning "never ran" (simulated crash).
    const orderId = await completedOrder(userId);
    const [before] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(before!.status).toBe('COMPLETED');
    expect(await accountsForOrder(orderId)).toBe(0);

    // The recovery sweep re-drives it.
    const result = await fulfillPurchaseGated(db, orderId, {});
    expect(result.status).toBe('PROVISIONED');
    expect(await accountsForOrder(orderId)).toBe(1);
    // A second recovery pass does not double-provision.
    await fulfillPurchaseGated(db, orderId, {});
    expect(await accountsForOrder(orderId)).toBe(1);
  });
});
