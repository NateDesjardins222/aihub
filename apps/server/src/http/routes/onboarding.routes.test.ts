/**
 * The customer onboarding flow end-to-end over real HTTP: contact + identity +
 * agreements -> satisfied gate -> product -> checkout order -> server-side
 * provisioning. Proves a browser "success" cannot provision (only a verified
 * server event does), the flow is IDOR-safe, and it reaches a PROVISIONED
 * account exactly once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { getDb, type Database } from '../../db/client.js';
import { customerIdentities, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { seedDefaultAgreements } from '../../platform/agreements.js';

let app: FastifyInstance;
let db: Database;
let organizationId: string;
let seq = 0;
const created: string[] = [];
let token: string;
let otherToken: string;

async function makeUser(): Promise<{ id: string; email: string }> {
  seq += 1;
  const email = `onb-${seq}-${Date.now()}@test.local`;
  const [u] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword('onb-pw'), displayName: 'Onb', organizationId })
    .returning();
  created.push(u!.id);
  return { id: u!.id, email };
}
async function tokenFor(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'onb-pw' } });
  if (res.statusCode !== 200) throw new Error(`login ${res.statusCode}`);
  return JSON.parse(res.body).accessToken;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'true';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await seedDefaultAgreements(db, organizationId);
  const me = await makeUser();
  const other = await makeUser();
  token = await tokenFor(me.email);
  otherToken = await tokenFor(other.email);
});

afterAll(async () => {
  // Buyers accrue append-only agreement acceptances; identities can't be
  // cascade-deleted, so leave the rows (random emails never collide).
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
async function get(url: string, t = token) {
  return app.inject({ method: 'GET', url, headers: auth(t) });
}
async function post(url: string, body: Record<string, unknown>, t = token) {
  return app.inject({ method: 'POST', url, headers: auth(t), payload: body });
}

describe('onboarding flow', () => {
  it('drives contact + identity + agreements to a satisfied gate, then provisions from a server event only', async () => {
    // -- state: identity created, gate not satisfied --------------------------
    const s0 = JSON.parse((await get('/api/v1/onboarding/state')).body);
    expect(s0.identity.id).toBeTruthy();
    expect(s0.gate.satisfied).toBe(false);

    // -- contact verification (email + phone) ---------------------------------
    const email = JSON.parse((await post('/api/v1/onboarding/contact/start', { channel: 'EMAIL', value: 'buyer@ex.com' })).body);
    expect(email.devCode).toMatch(/^\d{6}$/);
    await post('/api/v1/onboarding/contact/confirm', { challengeId: email.challengeId, code: email.devCode });
    const sms = JSON.parse((await post('/api/v1/onboarding/contact/start', { channel: 'SMS', value: '+15551234567' })).body);
    await post('/api/v1/onboarding/contact/confirm', { challengeId: sms.challengeId, code: sms.devCode });

    // -- identity verification (mock) -----------------------------------------
    await post('/api/v1/onboarding/identity/start', { legalName: 'Test Buyer', country: 'US' });
    const resolved = JSON.parse((await post('/api/v1/onboarding/identity/resolve', {})).body);
    expect(resolved.status).toBe('IDENTITY_VERIFIED');

    // -- agreements ------------------------------------------------------------
    const ag = JSON.parse((await get('/api/v1/onboarding/agreements')).body);
    expect(ag.current.length).toBeGreaterThanOrEqual(4);
    const accept = JSON.parse((await post('/api/v1/onboarding/agreements/accept', { versionIds: ag.current.map((a: { id: string }) => a.id) })).body);
    expect(accept.accepted).toBeGreaterThanOrEqual(4);

    // -- gate now satisfied ----------------------------------------------------
    const s1 = JSON.parse((await get('/api/v1/onboarding/state')).body);
    expect(s1.gate.satisfied).toBe(true);

    // -- products (the locked, server-authoritative catalog) ------------------
    const products = JSON.parse((await get('/api/v1/onboarding/products')).body).products;
    expect(products.length).toBeGreaterThanOrEqual(1);
    const product = products[0];

    // -- checkout: creates a PENDING order ------------------------------------
    const checkout = JSON.parse((await post('/api/v1/checkout', { productKey: product.key })).body);
    const orderId = checkout.orderId;
    expect(orderId).toBeTruthy();

    // -- the browser "success" cannot provision: status is still PENDING ------
    const pending = JSON.parse((await get(`/api/v1/commerce/orders/${orderId}/status`)).body);
    expect(pending.status).toBe('PENDING');
    expect(pending.accountId).toBeNull();

    // -- IDOR: another customer cannot read this order ------------------------
    const foreign = await get(`/api/v1/commerce/orders/${orderId}/status`, otherToken);
    expect(foreign.statusCode).toBe(404);

    // -- a verified SERVER-SIDE event provisions exactly once -----------------
    const sim = JSON.parse((await post('/api/v1/onboarding/dev/simulate-payment', { orderId })).body);
    expect(sim.status).toBe('PROVISIONED');
    const ready = JSON.parse((await get(`/api/v1/commerce/orders/${orderId}/status`)).body);
    expect(ready.status).toBe('PROVISIONED');
    expect(ready.accountId).toBeTruthy();

    // -- re-simulating the same order does not create a second account --------
    const again = JSON.parse((await post('/api/v1/onboarding/dev/simulate-payment', { orderId })).body);
    expect(again.status).toBe('PROVISIONED');
    const ready2 = JSON.parse((await get(`/api/v1/commerce/orders/${orderId}/status`)).body);
    expect(ready2.accountId).toBe(ready.accountId);
  });

  it('requires auth for onboarding state', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/onboarding/state' });
    expect(res.statusCode).toBe(401);
  });
});
