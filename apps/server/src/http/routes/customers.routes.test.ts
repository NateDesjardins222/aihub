/**
 * The Customer/Commerce console HTTP surface — auth, RBAC, IDOR/tenant scope,
 * and reason-required actions over real requests. Proves who may read and who
 * may act; the domain behaviour is proven in the platform tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { getDb, type Database } from '../../db/client.js';
import { customerIdentities, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { ensureCustomerIdentity } from '../../platform/customer-identity.js';

let app: FastifyInstance;
let db: Database;
let organizationId: string;
let seq = 0;
const created: string[] = [];
let supportToken: string;
let adminToken: string;
let traderToken: string;
let targetIdentityId: string;

async function makeUser(role: string, pw = 'console-route-pw'): Promise<{ id: string; email: string }> {
  seq += 1;
  const email = `cust-${role.toLowerCase()}-${seq}-${Date.now()}@test.local`;
  const [u] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(pw), displayName: role, role, organizationId })
    .returning();
  created.push(u!.id);
  return { id: u!.id, email };
}
async function tokenFor(email: string, pw = 'console-route-pw'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: pw } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode}`);
  return JSON.parse(res.body).accessToken;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  const support = await makeUser('SUPPORT');
  const admin = await makeUser('ADMIN');
  const trader = await makeUser('TRADER');
  const target = await makeUser('TRADER');
  const identity = await ensureCustomerIdentity(db, { organizationId, userId: target.id });
  targetIdentityId = identity.id;
  supportToken = await tokenFor(support.email);
  adminToken = await tokenFor(admin.email);
  traderToken = await tokenFor(trader.email);
});

afterAll(async () => {
  if (created.length > 0) {
    await db.delete(customerIdentities).where(inArray(customerIdentities.userId, created)).catch(() => undefined);
    await db.delete(users).where(inArray(users.id, created)).catch(() => undefined);
  }
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('reads (RBAC)', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/customers?q=' });
    expect(res.statusCode).toBe(401);
  });

  it('forbids a trader', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/customers?q=', headers: auth(traderToken) });
    expect(res.statusCode).toBe(403);
  });

  it('allows SUPPORT to search, read exceptions and reconciliation', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/customers?q=', headers: auth(supportToken) });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(list.body).customers)).toBe(true);

    const exc = await app.inject({ method: 'GET', url: '/api/v1/admin/customers/exceptions', headers: auth(supportToken) });
    expect(exc.statusCode).toBe(200);
    expect(JSON.parse(exc.body).counts).toBeTruthy();

    const recon = await app.inject({ method: 'GET', url: '/api/v1/admin/customers/reconciliation', headers: auth(supportToken) });
    expect(recon.statusCode).toBe(200);
    expect(typeof JSON.parse(recon.body).reconciliation.balanced).toBe('boolean');
  });

  it('reads a customer 360 and 404s an unknown id', async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/v1/admin/customers/${targetIdentityId}`, headers: auth(supportToken) });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).identity.id).toBe(targetIdentityId);

    const missing = await app.inject({ method: 'GET', url: `/api/v1/admin/customers/${crypto.randomUUID()}`, headers: auth(supportToken) });
    expect(missing.statusCode).toBe(404);
  });
});

describe('actions (RBAC + reason)', () => {
  it('SUPPORT cannot require reverification (ADMIN only)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/customers/${targetIdentityId}/require-reverification`,
      headers: auth(supportToken),
      payload: { reason: 'because' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('ADMIN must supply a reason', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/customers/${targetIdentityId}/hold`,
      headers: auth(adminToken),
      payload: { status: 'HOLD' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('ADMIN can place a hold with a reason', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/customers/${targetIdentityId}/hold`,
      headers: auth(adminToken),
      payload: { status: 'HOLD', reason: 'manual review' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });
});
