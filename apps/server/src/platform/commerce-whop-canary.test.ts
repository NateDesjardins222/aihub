/**
 * Whop CORE 50K canary — end-to-end money truth (real app + real DB).
 *
 * This proves the canary's NEW guarantees on top of the existing Whop path:
 *   - a verified payment whose plan matches and whose amount/currency match the
 *     $95 order provisions exactly one CORE-shaped evaluation account;
 *   - a payment whose confirmed AMOUNT contradicts the order is rejected
 *     (PRICE_MISMATCH) and provisions nothing;
 *   - a payment in the wrong CURRENCY is rejected and provisions nothing;
 *   - a payment for the WRONG PLAN is rejected (UNKNOWN_PRODUCT) and provisions
 *     nothing;
 *   - a retried/duplicated delivery (even 10 concurrent) has an exactly-once
 *     business effect;
 *   - an unsigned body never provisions (browser success is not payment truth).
 *
 * Whop is signed with a TEST secret using the exact Standard Webhooks scheme; no
 * real Whop call and no money movement happen here. The product carries a $95
 * price and is mapped to a Whop plan via WHOP_PLAN_MAP.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import {
  accountQualifications,
  accounts,
  commerceEvents,
  commercialOrders,
  entitlements,
  users,
} from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { confirmContactVerification, startContactVerification } from './contact-verification.js';
import { resolveIdentityVerification, startIdentityVerification } from './identity-verification.js';
import { acceptAgreements, outstandingAgreements, seedDefaultAgreements } from './agreements.js';

const M = 1_000_000;
const KEY_BYTES = Buffer.from('atlas-canary-webhook-key');
const SECRET = `ws_${KEY_BYTES.toString('base64')}`;
const CORE50K_PRICE_MICROS = 95 * M;
const WHOP_PLAN = 'plan_canary_core50k';

const PLAN_KEY = `whop-canary-${Math.random().toString(36).slice(2, 8)}`;

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
let token: string;
const users_: string[] = [];

function config() {
  return {
    rules: {
      accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M,
      drawdownType: 'EOD_TRAILING', trailingLockAtMicros: 0, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY',
      consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: 0.5, minTradingDays: 0, minWinningDays: 0,
      maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 5,
      microsCountAsFraction: true, flattenOnBreach: true,
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 5, perInstrument: {} },
    display: { startingBalanceMicros: 50_000 * M, priceMicros: CORE50K_PRICE_MICROS },
    payoutRules: null, fundedDestinationKey: null,
    whopPlanId: 'plan_placeholder_ignored', // overridden by WHOP_PLAN_MAP below
  };
}

/** Standard Webhooks headers + body, signed exactly as Whop signs them. */
function signedWebhook(payload: object, opts: { timestampSec?: number } = {}) {
  const body = JSON.stringify(payload);
  const id = `msg_${Math.random().toString(36).slice(2, 12)}`;
  const timestamp = String(opts.timestampSec ?? Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', KEY_BYTES).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64');
  return { body, headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` } };
}

/** A full v1-shaped Whop payment.succeeded for an order, with controllable facts. */
function payment(orderId: string, over: { plan?: string; subtotal?: number; currency?: string; receipt?: string } = {}) {
  return {
    type: 'payment.succeeded',
    data: {
      id: over.receipt ?? `pay_${Math.random().toString(36).slice(2, 10)}`,
      subtotal: over.subtotal ?? 95,
      total: over.subtotal ?? 95,
      currency: over.currency ?? 'usd',
      user: { id: 'user_canary' },
      plan: { id: over.plan ?? WHOP_PLAN },
      product: { id: 'prod_canary' },
      metadata: { atlasOrderId: orderId },
    },
  };
}

async function satisfyGate(userId: string): Promise<void> {
  const identity = await ensureCustomerIdentity(db, { organizationId, userId });
  const email = await startContactVerification(db, { identityId: identity.id, channel: 'EMAIL', value: `${userId}@canary.test` });
  await confirmContactVerification(db, { challengeId: email.challengeId, code: email.devCode! });
  const sms = await startContactVerification(db, { identityId: identity.id, channel: 'SMS', value: '+15557770000' });
  await confirmContactVerification(db, { challengeId: sms.challengeId, code: sms.devCode! });
  await startIdentityVerification(db, { identityId: identity.id, legalName: 'Canary Buyer' });
  await resolveIdentityVerification(db, { identityId: identity.id });
  const outstanding = await outstandingAgreements(db, organizationId, identity.id);
  await acceptAgreements(db, { organizationId, identityId: identity.id, userId, versionIds: outstanding.map((o) => o.versionId) });
}

function stubSandbox() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
    if (href.includes('sandbox-api.whop.com') && href.includes('checkout_configurations')) {
      const sent = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ id: `ch_${Math.random().toString(36).slice(2, 8)}`, plan: { id: sent.plan_id }, purchase_url: '/checkout/ch_x/' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url as never, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}

/** Create a fresh PENDING order (priced $95, mapped plan) via the real checkout route. */
async function pendingOrder(): Promise<string> {
  const restore = stubSandbox();
  try {
    const res = await app.inject({ method: 'POST', url: '/api/v1/checkout', headers: { authorization: `Bearer ${token}` }, payload: { productKey: PLAN_KEY } });
    return JSON.parse(res.body).orderId as string;
  } finally {
    restore();
  }
}

async function post(body: string, headers: Record<string, string>) {
  return app.inject({ method: 'POST', url: '/api/v1/webhooks/whop', headers, payload: body });
}

async function accountCount(orderId: string): Promise<number> {
  const ents = await db.select().from(entitlements).where(eq(entitlements.commercialOrderId, orderId));
  const acctIds = ents.map((e) => e.consumedByAccountId).filter((x): x is string => !!x);
  return new Set(acctIds).size;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['WHOP_WEBHOOK_SECRET'] = SECRET;
  process.env['WHOP_SANDBOX'] = 'true';
  process.env['WHOP_COMPANY_API_KEY'] = 'apik_canary';
  process.env['WHOP_PLAN_MAP'] = JSON.stringify({ [PLAN_KEY]: WHOP_PLAN });

  const { buildApp } = await import('../http/app.js');
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);

  await publishProfileVersion(db, { organizationId, key: PLAN_KEY, name: 'Whop Canary CORE 50K', accountType: 'EVALUATION', config: config() });

  const email = `whop-canary-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [buyer] = await db.insert(users).values({ email, passwordHash: await hashPassword('canary-password'), displayName: 'Canary', organizationId }).returning();
  users_.push(buyer!.id);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'canary-password' } });
  token = JSON.parse(login.body).accessToken;

  await seedDefaultAgreements(db, organizationId);
  await satisfyGate(buyer!.id);
});

afterAll(async () => {
  if (users_.length > 0) {
    const owned = await db.select({ id: accounts.id }).from(accounts).where(inArray(accounts.userId, users_));
    const ids = owned.map((a) => a.id);
    if (ids.length > 0) await db.delete(accountQualifications).where(inArray(accountQualifications.accountId, ids));
  }
  await app.close();
  delete process.env['WHOP_WEBHOOK_SECRET'];
  delete process.env['WHOP_SANDBOX'];
  delete process.env['WHOP_COMPANY_API_KEY'];
  delete process.env['WHOP_PLAN_MAP'];
});

describe('CORE 50K canary — matching payment provisions exactly one account', () => {
  it('pins the $95 price on the order and provisions on a matching verified payment', async () => {
    const orderId = await pendingOrder();
    const [pending] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(pending!.amountMicros).toBe(CORE50K_PRICE_MICROS);
    expect(pending!.currency).toBe('USD');

    const { body, headers } = signedWebhook(payment(orderId));
    const res = await post(body, headers);
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.accountId).toBeTruthy();

    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(order!.status).toBe('PROVISIONED');
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, out.accountId));
    expect(acct!.accountType).toBe('EVALUATION');
    expect(acct!.startingBalanceMicros).toBe(50_000 * M);
    expect(await accountCount(orderId)).toBe(1);
  });
});

describe('CORE 50K canary — money/product guards never provision on a mismatch', () => {
  it('rejects a payment whose amount contradicts the $95 order (PRICE_MISMATCH)', async () => {
    const orderId = await pendingOrder();
    const { body, headers } = signedWebhook(payment(orderId, { subtotal: 100 }));
    const res = await post(body, headers);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error?.code ?? JSON.parse(res.body).code).toBe('PRICE_MISMATCH');
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(order!.status).toBe('PENDING'); // never completed, never provisioned
    expect(await accountCount(orderId)).toBe(0);
  });

  it('rejects a payment in the wrong currency (PRICE_MISMATCH)', async () => {
    const orderId = await pendingOrder();
    const { body, headers } = signedWebhook(payment(orderId, { currency: 'eur' }));
    const res = await post(body, headers);
    expect(res.statusCode).toBe(400);
    expect(await accountCount(orderId)).toBe(0);
  });

  it('rejects a payment for the wrong plan (UNKNOWN_PRODUCT)', async () => {
    const orderId = await pendingOrder();
    const { body, headers } = signedWebhook(payment(orderId, { plan: 'plan_SOMETHING_ELSE' }));
    const res = await post(body, headers);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error?.code ?? JSON.parse(res.body).code).toBe('UNKNOWN_PRODUCT');
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(order!.status).toBe('PENDING');
    expect(await accountCount(orderId)).toBe(0);
    // The event is recorded REJECTED with the precise reason — nothing dropped.
    const evs = await db.select().from(commerceEvents).where(eq(commerceEvents.atlasOrderId, orderId));
    expect(evs.some((e) => e.rejectReason === 'UNKNOWN_PRODUCT')).toBe(true);
  });
});

describe('CORE 50K canary — exactly-once under duplicate/concurrent delivery', () => {
  it('provisions one account for 10 concurrent identical deliveries (Whop retries)', async () => {
    const orderId = await pendingOrder();
    const { body, headers } = signedWebhook(payment(orderId, { receipt: 'pay_race' }));
    const results = await Promise.all(Array.from({ length: 10 }, () => post(body, headers)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(order!.status).toBe('PROVISIONED');
    expect(await accountCount(orderId)).toBe(1);
    const ents = await db.select().from(entitlements).where(eq(entitlements.commercialOrderId, orderId));
    expect(ents).toHaveLength(1);
  });
});

describe('CORE 50K canary — browser success is not payment truth', () => {
  it('an unsigned body never provisions (401, order untouched)', async () => {
    const orderId = await pendingOrder();
    const res = await post(JSON.stringify(payment(orderId)), { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(401);
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    expect(order!.status).toBe('PENDING');
    expect(await accountCount(orderId)).toBe(0);
  });
});
