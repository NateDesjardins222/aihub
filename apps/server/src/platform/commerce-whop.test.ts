/**
 * The Whop payment path: checkout, signed webhook, fulfilment.
 *
 * Against the real database and the real HTTP layer. No live charge and no real
 * Whop call happens: the webhook is signed with a test secret exactly as Whop
 * would sign it, so the signature-verification and fulfilment guarantees are
 * exercised for real while no money moves. The guarantees under test are the
 * ones a payment provider leans on: an unsigned or forged webhook is rejected,
 * a valid one provisions exactly one account, and a webhook that fires twice
 * (Whop retries) never provisions a second.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import {
  accountQualifications,
  accounts,
  commercialOrders,
  entitlements,
  users,
} from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { parseWhopEvent, verifyWhopSignature, whopConfigured } from './whop.js';

const M = 1_000_000;
const SECRET = 'test-whop-secret-value';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
let token: string;
let userId: string;
const users_: string[] = [];

const PLAN_KEY = `whop-eval-${Math.random().toString(36).slice(2, 8)}`;
const NOPLAN_KEY = `whop-noplan-${Math.random().toString(36).slice(2, 8)}`;

function config(overrides: Record<string, unknown> = {}) {
  return {
    rules: {
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
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
    display: { startingBalanceMicros: 50_000 * M },
    payoutRules: null,
    fundedDestinationKey: null,
    whopPlanId: (overrides['whopPlanId'] as string | null) ?? null,
  };
}

/** Sign a raw body exactly as Whop would, so the server verifies it. */
function sign(raw: string): string {
  return createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');
}

function paymentBody(orderId: string, receiptId = 'whop_receipt_1'): string {
  return JSON.stringify({
    type: 'payment.succeeded',
    data: { id: receiptId, metadata: { atlasOrderId: orderId } },
  });
}

async function postWebhook(raw: string, signature: string | null) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/whop',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-whop-signature': signature } : {}),
    },
    payload: raw,
  });
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  // Turn the payment path on for this file, before buildApp reads env().
  process.env['WHOP_WEBHOOK_SECRET'] = SECRET;
  process.env['WHOP_CHECKOUT_BASE_URL'] = 'https://whop.com/checkout';

  const { buildApp } = await import('../http/app.js');
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);

  await publishProfileVersion(db, {
    organizationId,
    key: PLAN_KEY,
    name: 'Whop Evaluation 50K',
    accountType: 'EVALUATION',
    config: config({ whopPlanId: 'plan_ABC123' }),
  });
  await publishProfileVersion(db, {
    organizationId,
    key: NOPLAN_KEY,
    name: 'Unlisted Evaluation 50K',
    accountType: 'EVALUATION',
    config: config(),
  });

  const email = `whop-buyer-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [buyer] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword('whop-buyer-password'), displayName: 'Buyer', organizationId })
    .returning();
  userId = buyer!.id;
  users_.push(userId);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'whop-buyer-password' },
  });
  token = JSON.parse(login.body).accessToken;
});

afterAll(async () => {
  if (users_.length > 0) {
    const owned = await db.select({ id: accounts.id }).from(accounts).where(inArray(accounts.userId, users_));
    const ids = owned.map((a) => a.id);
    if (ids.length > 0) {
      await db.delete(accountQualifications).where(inArray(accountQualifications.accountId, ids));
    }
  }
  for (const id of users_) await db.delete(users).where(eq(users.id, id));
  await app.close();
  delete process.env['WHOP_WEBHOOK_SECRET'];
  delete process.env['WHOP_CHECKOUT_BASE_URL'];
});

describe('signature verification (pure)', () => {
  it('accepts a correct signature and rejects a forged or malformed one', () => {
    const raw = paymentBody('order-1');
    expect(verifyWhopSignature(raw, sign(raw), SECRET)).toBe(true);
    expect(verifyWhopSignature(raw, sign(raw), 'wrong-secret')).toBe(false);
    expect(verifyWhopSignature(raw, 'deadbeef', SECRET)).toBe(false);
    expect(verifyWhopSignature(raw, undefined, SECRET)).toBe(false);
    // A tampered body no longer matches the signature of the original.
    expect(verifyWhopSignature(raw + ' ', sign(raw), SECRET)).toBe(false);
    // A `sha256=` prefix is tolerated.
    expect(verifyWhopSignature(raw, `sha256=${sign(raw)}`, SECRET)).toBe(true);
  });

  it('reads the order id and payment-success flag out of a Whop payload', () => {
    const e = parseWhopEvent({ type: 'payment.succeeded', data: { id: 'r1', metadata: { atlasOrderId: 'o1' } } });
    expect(e.isPaymentSuccess).toBe(true);
    expect(e.atlasOrderId).toBe('o1');
    expect(e.receiptId).toBe('r1');
    // Snake-case metadata and a non-payment event.
    expect(parseWhopEvent({ action: 'payment.refunded', data: { metadata: { order_id: 'o2' } } })).toMatchObject({
      isPaymentSuccess: false,
      atlasOrderId: 'o2',
    });
    expect(whopConfigured()).toBe(true);
  });
});

describe('checkout', () => {
  it('creates a pending order and returns a Whop checkout link carrying the order id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { productKey: PLAN_KEY },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.configured).toBe(true);
    expect(body.checkoutUrl).toContain('plan_ABC123');
    expect(body.checkoutUrl).toContain(encodeURIComponent(body.orderId));

    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, body.orderId));
    expect(order!.status).toBe('PENDING');
    expect(order!.externalProvider).toBe('whop');
  });

  it('reports not-configured for a product with no Whop plan', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { productKey: NOPLAN_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).configured).toBe(false);
  });

  it('refuses checkout without a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      payload: { productKey: PLAN_KEY },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('webhook fulfilment', () => {
  async function pendingOrder(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { productKey: PLAN_KEY },
    });
    return JSON.parse(res.body).orderId;
  }

  it('a valid signed payment provisions exactly one evaluation account', async () => {
    const orderId = await pendingOrder();
    const raw = paymentBody(orderId);
    const res = await postWebhook(raw, sign(raw));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.accountId).toBeTruthy();

    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(order!.status).toBe('COMPLETED');
    expect(order!.externalReference).toBe('whop_receipt_1');
    const [account] = await db.select().from(accounts).where(eq(accounts.id, body.accountId));
    expect(account!.accountType).toBe('EVALUATION');
    const ents = await db.select().from(entitlements).where(eq(entitlements.commercialOrderId, orderId));
    expect(ents).toHaveLength(1);
    expect(ents[0]!.status).toBe('CONSUMED');
  });

  it('is idempotent: a webhook that fires twice never makes a second account', async () => {
    const orderId = await pendingOrder();
    const raw = paymentBody(orderId, 'whop_receipt_2');
    const first = await postWebhook(raw, sign(raw));
    const second = await postWebhook(raw, sign(raw));
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).accountId).toBe(JSON.parse(first.body).accountId);

    const ents = await db.select().from(entitlements).where(eq(entitlements.commercialOrderId, orderId));
    expect(ents).toHaveLength(1);
    const provisioned = ents[0]!.consumedByAccountId;
    const accts = await db.select().from(accounts).where(eq(accounts.id, provisioned!));
    expect(accts).toHaveLength(1);
  });

  it('rejects a forged signature and does not fulfil', async () => {
    const orderId = await pendingOrder();
    const raw = paymentBody(orderId);
    const res = await postWebhook(raw, 'deadbeef'.repeat(8));
    expect(res.statusCode).toBe(401);
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(order!.status).toBe('PENDING');
  });

  it('rejects a missing signature', async () => {
    const orderId = await pendingOrder();
    const raw = paymentBody(orderId);
    const res = await postWebhook(raw, null);
    expect(res.statusCode).toBe(401);
  });

  it('acknowledges but ignores a non-payment event', async () => {
    const raw = JSON.stringify({ type: 'payment.refunded', data: { metadata: {} } });
    const res = await postWebhook(raw, sign(raw));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ignored).toBe(true);
  });

  it('400s a payment with no order reference', async () => {
    const raw = JSON.stringify({ type: 'payment.succeeded', data: { id: 'r', metadata: {} } });
    const res = await postWebhook(raw, sign(raw));
    expect(res.statusCode).toBe(400);
  });

  it('404s a payment for an unknown order', async () => {
    const raw = paymentBody(crypto.randomUUID());
    const res = await postWebhook(raw, sign(raw));
    expect(res.statusCode).toBe(404);
  });
});
