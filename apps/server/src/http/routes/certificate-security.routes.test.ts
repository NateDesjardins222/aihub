/**
 * Certificate + physical-order HTTP security (M6-J).
 *
 * Route-level proof of the M6 access rules against the real app: a customer can
 * fetch only their own certificate artifacts (no IDOR), public verification
 * exposes only safe fields, a customer cannot order or view another customer's
 * certificate/order, and the certificate display name cannot inject markup or an
 * email.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { getDb, type Database } from '../../db/client.js';
import { certificates, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { ensureCustomerIdentity } from '../../platform/customer-identity.js';
import { objectStore, newArtifactKey } from '../../platform/object-store.js';

let app: FastifyInstance;
let db: Database;
let organizationId: string;
let seq = 0;

async function userWithToken(): Promise<{ userId: string; token: string; email: string }> {
  seq += 1;
  const email = `certsec-${seq}-${Date.now()}@atlas.test`;
  const [u] = await db.insert(users).values({ email, passwordHash: await hashPassword('pw-certsec'), displayName: 'Cert Sec', organizationId }).returning();
  await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'pw-certsec' } });
  return { userId: u!.id, token: JSON.parse(res.body).accessToken, email };
}

/** Insert a rendered certificate for a user + write its artifacts to the store. */
async function renderedCert(userId: string): Promise<{ id: string; token: string }> {
  const { customerIdentities } = await import('../../db/schema.js');
  const [ident] = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(eq(customerIdentities.userId, userId));
  const imageKey = newArtifactKey('certificates', 'x.png');
  const pdfKey = newArtifactKey('certificates', 'x.pdf');
  await objectStore().put(imageKey, Buffer.from('\x89PNG-fake'), 'image/png');
  await objectStore().put(pdfKey, Buffer.from('%PDF-fake'), 'application/pdf');
  seq += 1;
  const [c] = await db.insert(certificates).values({
    organizationId, certificatePublicId: `HT-C-SEC${seq}${Date.now() % 10000}`, verificationToken: `sec-${seq}-${Date.now()}`,
    type: 'PAYOUT', customerIdentityId: ident!.id, publicDisplayName: 'Sec T', amountMicros: 1_700_000_000,
    dedupeKey: `sec-${seq}-${Date.now()}`, renderStatus: 'RENDERED', imageStorageKey: imageKey, pdfStorageKey: pdfKey, printStorageKey: imageKey, renderHash: 'a'.repeat(64), rendererVersion: 'r1',
  }).returning();
  return { id: c!.id, token: c!.verificationToken };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['MERCH_ENABLED'] = 'true';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
});
afterAll(async () => { delete process.env['MERCH_ENABLED']; await app.close(); });

describe('certificate artifact access control', () => {
  it('a customer can download their own certificate image', async () => {
    const a = await userWithToken();
    const cert = await renderedCert(a.userId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/portal/certificates/${cert.id}/image`, headers: auth(a.token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });

  it("denies downloading another customer's certificate image (no IDOR)", async () => {
    const a = await userWithToken();
    const b = await userWithToken();
    const cert = await renderedCert(a.userId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/portal/certificates/${cert.id}/image`, headers: auth(b.token) });
    expect(res.statusCode).toBe(404);
  });

  it('an unauthenticated request cannot download an artifact', async () => {
    const a = await userWithToken();
    const cert = await renderedCert(a.userId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/portal/certificates/${cert.id}/image` });
    expect(res.statusCode).toBe(401);
  });
});

describe('public verification exposes only safe fields', () => {
  it('returns type/name/status but never an email or internal id', async () => {
    const a = await userWithToken();
    const cert = await renderedCert(a.userId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/verify/${cert.token}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.valid).toBe(true);
    expect(body.type).toBe('PAYOUT');
    expect(JSON.stringify(body)).not.toContain('@');
    expect(body.customerIdentityId).toBeUndefined();
    expect(body.accountId).toBeUndefined();
  });

  it('an unknown token is an explicit invalid state, not a leak', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/verify/not-a-real-token' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).valid).toBe(false);
  });
});

describe('physical order access control', () => {
  it("a customer cannot order a framed copy of another customer's certificate", async () => {
    const a = await userWithToken();
    const b = await userWithToken();
    const cert = await renderedCert(a.userId);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/portal/certificates/${cert.id}/order-framed`, headers: auth(b.token),
      payload: { address: { name: 'B', line1: '1 St', city: 'X', postalCode: '1', country: 'US' } },
    });
    expect(res.statusCode).toBe(404);
  });

  it("a customer cannot view another customer's physical order", async () => {
    const a = await userWithToken();
    const b = await userWithToken();
    const cert = await renderedCert(a.userId);
    const created = await app.inject({
      method: 'POST', url: `/api/v1/portal/certificates/${cert.id}/order-framed`, headers: auth(a.token),
      payload: { address: { name: 'A', line1: '1 St', city: 'X', postalCode: '1', country: 'US' } },
    });
    expect(created.statusCode).toBe(201);
    const orderId = JSON.parse(created.body).orderId;
    const res = await app.inject({ method: 'GET', url: `/api/v1/portal/physical-orders/${orderId}`, headers: auth(b.token) });
    expect(res.statusCode).toBe(404);
  });
});

describe('certificate display name validation', () => {
  it('rejects a markup/script injection name', async () => {
    const a = await userWithToken();
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/portal/profile', headers: auth(a.token), payload: { preferredDisplayName: '<script>alert(1)</script>' } });
    expect(res.statusCode).toBe(400);
  });
  it('rejects an email as a display name', async () => {
    const a = await userWithToken();
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/portal/profile', headers: auth(a.token), payload: { preferredDisplayName: 'me@evil.test' } });
    expect(res.statusCode).toBe(400);
  });
  it('accepts a clean display name', async () => {
    const a = await userWithToken();
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/portal/profile', headers: auth(a.token), payload: { preferredDisplayName: 'Nathan D.' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).preferredDisplayName).toBe('Nathan D.');
  });
});
