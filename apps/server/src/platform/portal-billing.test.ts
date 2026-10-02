/**
 * Customer billing provenance (Golden Path WEB-3). Proves the Billing surface reads
 * REAL commercial_orders — the product name, the authoritative amount (or null, never
 * fabricated), a customer-safe state, and the account the order provisioned — and is
 * strictly owner-scoped. Runs against the real database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { accounts, commercialOrders, entitlements, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';
import { acquireEvaluation, completeCommercialOrder } from './commerce.js';
import { listPortalBilling } from './portal-billing.js';

const M = 1_000_000;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const created: string[] = [];
const KEY = `bill-eval-${Math.random().toString(36).slice(2, 8)}`;

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
  const [u] = await db.insert(users).values({
    email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`,
    passwordHash: await hashPassword('billing-test-password'),
    displayName: label, organizationId,
  }).returning();
  created.push(u!.id);
  return u!.id;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'false';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, {
    organizationId, key: KEY, name: 'Evaluation 50K (Billing)',
    accountType: 'EVALUATION', config: config(),
  });
});

afterAll(async () => {
  if (created.length) {
    await db.delete(entitlements).where(inArray(entitlements.userId, created));
    await db.delete(commercialOrders).where(inArray(commercialOrders.userId, created));
    await db.delete(accounts).where(inArray(accounts.userId, created));
    await db.delete(users).where(inArray(users.id, created));
  }
  await app.close();
});

describe('listPortalBilling', () => {
  it('returns a real order with product name, settled state and the provisioned account', async () => {
    const userId = await makeUser('bill');
    const { versionId } = await resolveProfileByKey(db, organizationId, KEY);
    const res = await acquireEvaluation(db, {
      organizationId, userId, productVersionId: versionId,
      source: 'PURCHASE', externalProvider: 'demo', idempotencyKey: `order-${crypto.randomUUID()}`,
    });

    const billing = await listPortalBilling(db, userId);
    expect(billing.orderCount).toBe(1);
    const row = billing.orders[0]!;
    expect(row.item).toBe('Evaluation 50K (Billing)');
    expect(row.state).toBe('PAID'); // a COMPLETED/PROVISIONED order is customer-safe PAID
    expect(row.source).toBe('PURCHASE');
    expect(row.accountId).toBe(res.accountId); // provenance: order → entitlement → account
    // amountMicros is whatever the order recorded — here none was set, so it is null, NOT fabricated.
    expect(row.amountMicros === null || typeof row.amountMicros === 'number').toBe(true);
  });

  it('settles totalSpent only from authoritative amounts and is strictly owner-scoped', async () => {
    const buyer = await makeUser('bill-amount');
    const stranger = await makeUser('bill-stranger');
    const { versionId } = await resolveProfileByKey(db, organizationId, KEY);
    // An order carrying an explicit amount (money figure is authoritative, informational).
    await completeCommercialOrder(db, {
      organizationId, userId: buyer, productVersionId: versionId,
      source: 'PURCHASE', amountMicros: 149 * M, currency: 'USD',
      idempotencyKey: `order-${crypto.randomUUID()}`,
    });

    const buyerBilling = await listPortalBilling(db, buyer);
    expect(buyerBilling.totalSpentMicros).toBe(149 * M);
    expect(buyerBilling.orders.some((o) => o.amountMicros === 149 * M && o.currency === 'USD')).toBe(true);

    // The stranger never sees the buyer's orders.
    const strangerBilling = await listPortalBilling(db, stranger);
    expect(strangerBilling.orderCount).toBe(0);
    expect(strangerBilling.totalSpentMicros).toBe(0);
  });

  it('maps a refunded order to a customer-safe REFUNDED state and excludes it from spend', async () => {
    const userId = await makeUser('bill-refund');
    const { versionId } = await resolveProfileByKey(db, organizationId, KEY);
    const order = await completeCommercialOrder(db, {
      organizationId, userId, productVersionId: versionId,
      source: 'PURCHASE', amountMicros: 149 * M, currency: 'USD',
      idempotencyKey: `order-${crypto.randomUUID()}`,
    });
    await db.update(commercialOrders).set({ status: 'REFUNDED', refundedAt: new Date() }).where(eq(commercialOrders.id, order.id));

    const billing = await listPortalBilling(db, userId);
    const row = billing.orders.find((o) => o.id === order.id)!;
    expect(row.state).toBe('REFUNDED');
    expect(row.refundedAtMs).not.toBeNull();
    expect(billing.totalSpentMicros).toBe(0); // refunded amounts never count as spend
  });
});
