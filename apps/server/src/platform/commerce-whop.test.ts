/**
 * The Whop payment path: embedded checkout (sandbox) and Standard Webhooks
 * fulfilment.
 *
 * Against the real database and the real HTTP layer. No live charge and no real
 * Whop call happens: the checkout session is created against a STUBBED sandbox
 * fetch, and the webhook is signed with a test secret using the exact Standard
 * Webhooks scheme Whop uses, so signature verification and fulfilment are
 * exercised for real while no money moves. The guarantees under test: an
 * unsigned, forged, tampered or stale webhook is rejected; a valid one
 * provisions exactly one account; and a webhook that fires twice (Whop retries)
 * has an exactly-once business effect.
 */
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { parseWhopEvent, verifyStandardWebhook, whopConfigured } from './whop.js';

const M = 1_000_000;
// A Standard Webhooks secret: "ws_" + base64 of the key bytes.
const KEY_BYTES = Buffer.from('atlas-test-webhook-key');
const SECRET = `ws_${KEY_BYTES.toString('base64')}`;

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
let token: string;
const users_: string[] = [];
const realFetch = globalThis.fetch;

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

/** Build the Standard Webhooks headers + body exactly as Whop would sign them. */
function signedWebhook(payload: object, opts: { timestampSec?: number } = {}) {
  const body = JSON.stringify(payload);
  const id = `msg_${Math.random().toString(36).slice(2, 12)}`;
  const timestamp = String(opts.timestampSec ?? Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', KEY_BYTES)
    .update(`${id}.${timestamp}.${body}`, 'utf8')
    .digest('base64');
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    },
  };
}

function paymentPayload(orderId: string, receiptId = 'pay_receipt_1') {
  return { type: 'payment.succeeded', data: { id: receiptId, metadata: { atlasOrderId: orderId } } };
}

async function postWebhook(body: string, headers: Record<string, string>) {
  return app.inject({ method: 'POST', url: '/api/v1/webhooks/whop', headers, payload: body });
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  // Turn the sandbox payment path on for this file, before buildApp reads env().
  process.env['WHOP_WEBHOOK_SECRET'] = SECRET;
  process.env['WHOP_SANDBOX'] = 'true';
  process.env['WHOP_COMPANY_API_KEY'] = 'apik_sandbox_test';

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
  users_.push(buyer!.id);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: 'whop-buyer-password' },
  });
  token = JSON.parse(login.body).accessToken;
});

afterEach(() => {
  globalThis.fetch = realFetch;
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
  globalThis.fetch = realFetch;
  delete process.env['WHOP_WEBHOOK_SECRET'];
  delete process.env['WHOP_SANDBOX'];
  delete process.env['WHOP_COMPANY_API_KEY'];
});

/** Intercept the sandbox checkout-session call; everything else passes through. */
function stubSandboxSession(sessionId = 'ch_sandbox_test') {
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (href.includes('sandbox-api.whop.com') && href.includes('checkout_sessions')) {
      const sent = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({ id: sessionId, plan_id: sent.plan_id, purchase_url: null, metadata: sent.metadata }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return realFetch(url as never, init);
  }) as typeof fetch;
}

describe('Standard Webhooks verification (pure)', () => {
  it('accepts a correct signature and rejects forged, tampered and stale ones', () => {
    const { body, headers } = signedWebhook(paymentPayload('o1'));
    expect(verifyStandardWebhook(body, headers, SECRET).ok).toBe(true);
    // Wrong secret.
    expect(verifyStandardWebhook(body, headers, `ws_${Buffer.from('other').toString('base64')}`).ok).toBe(false);
    // Tampered body.
    expect(verifyStandardWebhook(body + ' ', headers, SECRET).ok).toBe(false);
    // Missing headers.
    expect(verifyStandardWebhook(body, { 'content-type': 'application/json' }, SECRET).ok).toBe(false);
    // Stale timestamp (10 minutes ago, tolerance 5).
    const old = signedWebhook(paymentPayload('o1'), { timestampSec: Math.floor(Date.now() / 1000) - 600 });
    expect(verifyStandardWebhook(old.body, old.headers, SECRET).ok).toBe(false);
    // A multi-signature header (rotated secret) still verifies if one matches.
    const multi = { ...headers, 'webhook-signature': `v1,AAAA ${headers['webhook-signature']}` };
    expect(verifyStandardWebhook(body, multi, SECRET).ok).toBe(true);
  });

  it('reads the order id and payment-success flag out of a Whop payload', () => {
    const e = parseWhopEvent(paymentPayload('o9', 'r9'));
    expect(e).toMatchObject({ isPaymentSuccess: true, atlasOrderId: 'o9', receiptId: 'r9' });
    expect(parseWhopEvent({ type: 'payment.failed', data: { metadata: { order_id: 'o2' } } })).toMatchObject({
      isPaymentSuccess: false,
      atlasOrderId: 'o2',
    });
    expect(whopConfigured()).toBe(true);
  });
});

describe('embedded checkout', () => {
  it('creates a pending order and a sandbox checkout session for the embed', async () => {
    stubSandboxSession('ch_for_embed');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { productKey: PLAN_KEY },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.configured).toBe(true);
    expect(body.environment).toBe('sandbox');
    expect(body.sessionId).toBe('ch_for_embed');
    expect(body.planId).toBe('plan_ABC123');

    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, body.orderId));
    expect(order!.status).toBe('PENDING');
    expect(order!.externalReference).toBe('ch_for_embed');
  });

  it('reports not-configured for a product with no Whop plan', async () => {
    stubSandboxSession();
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
    const res = await app.inject({ method: 'POST', url: '/api/v1/checkout', payload: { productKey: PLAN_KEY } });
    expect(res.statusCode).toBe(401);
  });
});

describe('webhook fulfilment', () => {
  async function pendingOrder(): Promise<string> {
    stubSandboxSession(`ch_${crypto.randomUUID().slice(0, 8)}`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { productKey: PLAN_KEY },
    });
    globalThis.fetch = realFetch;
    return JSON.parse(res.body).orderId;
  }

  it('a valid signed payment provisions exactly one evaluation account', async () => {
    const orderId = await pendingOrder();
    const { body, headers } = signedWebhook(paymentPayload(orderId));
    const res = await postWebhook(body, headers);
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.accountId).toBeTruthy();

    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(order!.status).toBe('COMPLETED');
    const [account] = await db.select().from(accounts).where(eq(accounts.id, out.accountId));
    expect(account!.accountType).toBe('EVALUATION');
    const ents = await db.select().from(entitlements).where(eq(entitlements.commercialOrderId, orderId));
    expect(ents).toHaveLength(1);
    expect(ents[0]!.status).toBe('CONSUMED');
  });

  it('is exactly-once: a retried delivery never makes a second account', async () => {
    const orderId = await pendingOrder();
    const { body, headers } = signedWebhook(paymentPayload(orderId, 'pay_receipt_2'));
    const first = await postWebhook(body, headers);
    const second = await postWebhook(body, headers); // Whop retries the same event
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).accountId).toBe(JSON.parse(first.body).accountId);
    const ents = await db.select().from(entitlements).where(eq(entitlements.commercialOrderId, orderId));
    expect(ents).toHaveLength(1);
  });

  it('rejects a forged signature and does not fulfil', async () => {
    const orderId = await pendingOrder();
    const { body, headers } = signedWebhook(paymentPayload(orderId));
    const forged = { ...headers, 'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
    const res = await postWebhook(body, forged);
    expect(res.statusCode).toBe(401);
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(order!.status).toBe('PENDING');
  });

  it('rejects a stale timestamp (replay)', async () => {
    const orderId = await pendingOrder();
    const { body, headers } = signedWebhook(paymentPayload(orderId), {
      timestampSec: Math.floor(Date.now() / 1000) - 600,
    });
    const res = await postWebhook(body, headers);
    expect(res.statusCode).toBe(401);
  });

  it('acknowledges but ignores a non-payment event', async () => {
    const { body, headers } = signedWebhook({ type: 'refund.created', data: { metadata: {} } });
    const res = await postWebhook(body, headers);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ignored).toBe(true);
  });

  it('400s a payment with no order reference', async () => {
    const { body, headers } = signedWebhook({ type: 'payment.succeeded', data: { id: 'r', metadata: {} } });
    const res = await postWebhook(body, headers);
    expect(res.statusCode).toBe(400);
  });

  it('404s a payment for an unknown order', async () => {
    const { body, headers } = signedWebhook(paymentPayload(crypto.randomUUID()));
    const res = await postWebhook(body, headers);
    expect(res.statusCode).toBe(404);
  });
});
