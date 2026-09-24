/**
 * Owner Certificate Store (M6-I) — summary maths, order transitions, and the
 * manual 100K plaque queue. No backdoor issues an earned certificate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb, type Database } from '../db/client.js';
import { certificates, customerIdentities, physicalCertificateOrders, physicalRewardFulfillment, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { certificateStoreSummary, listStoreOrders, updateStoreOrder, listPlaqueFulfillments, updatePlaqueFulfillment, CertificateStoreError } from './certificate-store.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: Database;
let organizationId: string;
let seq = 0;

async function ident(): Promise<{ userId: string; identityId: string }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `store-${seq}-${Date.now()}@test.local`, passwordHash: await hashPassword('x'), displayName: 'Store', organizationId }).returning();
  const id = await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  return { userId: u!.id, identityId: id.id };
}
async function cert(identityId: string): Promise<string> {
  const [c] = await db.insert(certificates).values({
    organizationId, certificatePublicId: `HT-C-${seq}${Date.now() % 100000}`, verificationToken: `tok-${seq}-${Date.now()}`,
    type: 'PAYOUT', customerIdentityId: identityId, publicDisplayName: 'Store T', dedupeKey: `d-${seq}-${Date.now()}`, renderStatus: 'RENDERED',
  }).returning();
  return c!.id;
}
async function order(identityId: string, certId: string, status: string, retail: number, cost: number): Promise<string> {
  const [o] = await db.insert(physicalCertificateOrders).values({
    organizationId, customerIdentityId: identityId, certificateId: certId, sku: 'GLOBAL-CFP-11X14',
    retailAmountMicros: retail, status, providerQuoteAmountMicros: cost, shippingAmountMicros: 0, estimatedContributionMicros: retail - cost,
  }).returning();
  return o!.id;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app; await app.ready(); db = getDb().db; organizationId = await defaultOrganizationId(db);
});
afterAll(async () => { await app.close(); });

describe('certificate store summary', () => {
  it('sums revenue, cost and contribution over paid orders', async () => {
    const { identityId } = await ident();
    const c = await cert(identityId);
    await order(identityId, c, 'SUBMITTED', 99_990_000, 62_000_000);
    const c2 = await cert(identityId);
    await order(identityId, c2, 'PENDING_PAYMENT', 99_990_000, 0); // not counted
    const s = await certificateStoreSummary(db, organizationId);
    expect(s.totalOrders).toBeGreaterThanOrEqual(2);
    expect(s.revenueMicros).toBeGreaterThanOrEqual(99_990_000);
    expect(s.estimatedContributionMicros).toBe(s.revenueMicros - s.fulfillmentCostMicros);
  });

  it('lists orders with a safe customer + certificate context', async () => {
    const { identityId } = await ident();
    const c = await cert(identityId);
    await order(identityId, c, 'SUBMITTED', 99_990_000, 62_000_000);
    const rows = await listStoreOrders(db, organizationId, {});
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.customerEmail).toContain('@');
  });
});

describe('order transitions', () => {
  it('ships then delivers a submitted order', async () => {
    const { identityId } = await ident();
    const c = await cert(identityId);
    const id = await order(identityId, c, 'SUBMITTED', 99_990_000, 62_000_000);
    const shipped = await updateStoreOrder(db, organizationId, id, 'ship', { carrier: 'UPS', trackingNumber: 'X1' });
    expect(shipped.status).toBe('SHIPPED');
    const delivered = await updateStoreOrder(db, organizationId, id, 'deliver', undefined);
    expect(delivered.status).toBe('DELIVERED');
  });

  it('refuses an invalid transition', async () => {
    const { identityId } = await ident();
    const c = await cert(identityId);
    const id = await order(identityId, c, 'PENDING_PAYMENT', 99_990_000, 0);
    await expect(updateStoreOrder(db, organizationId, id, 'ship', undefined)).rejects.toBeInstanceOf(CertificateStoreError);
  });
});

describe('100K plaque manual fulfillment', () => {
  it('advances PENDING_REVIEW → VERIFIED → ORDERED → SHIPPED → DELIVERED', async () => {
    const { identityId } = await ident();
    const [p] = await db.insert(physicalRewardFulfillment).values({ organizationId, customerIdentityId: identityId, type: 'PLAQUE_100K', status: 'PENDING_REVIEW' }).returning();
    await updatePlaqueFulfillment(db, organizationId, p!.id, 'verify', undefined);
    await updatePlaqueFulfillment(db, organizationId, p!.id, 'order', undefined);
    await updatePlaqueFulfillment(db, organizationId, p!.id, 'ship', { trackingNumber: 'PLQ1' });
    const done = await updatePlaqueFulfillment(db, organizationId, p!.id, 'deliver', undefined);
    expect(done.status).toBe('DELIVERED');
    const list = await listPlaqueFulfillments(db, organizationId);
    expect(list.find((x) => x.id === p!.id)?.status).toBe('DELIVERED');
  });

  it('cannot skip straight to shipped', async () => {
    const { identityId } = await ident();
    const [p] = await db.insert(physicalRewardFulfillment).values({ organizationId, customerIdentityId: identityId, type: 'PLAQUE_100K', status: 'PENDING_REVIEW' }).returning();
    await expect(updatePlaqueFulfillment(db, organizationId, p!.id, 'ship', undefined)).rejects.toBeInstanceOf(CertificateStoreError);
  });
});
