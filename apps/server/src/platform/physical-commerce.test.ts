/**
 * Physical framed certificate commerce (M6-G/H).
 *
 * Only an earned + rendered certificate can be ordered; another customer's cert is
 * denied; payment is required and server-authoritative; preflight catches a
 * missing artifact / invalid address / cost-over-retail before any manufacturing
 * order; the provider order is idempotent; tracking advances; and the Prodigi
 * provider is disabled by default (the mock is used).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb, type Database } from '../db/client.js';
import { accounts, certificates, customerIdentities, physicalCertificateOrders, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { applyRecognition } from './recognition.js';
import { setObjectStoreForTest, type ObjectStore, type StoredObject } from './object-store.js';
import { fulfillmentProvider, ProdigiFulfillmentProvider, MockFulfillmentProvider, setFulfillmentProviderForTest } from './fulfillment-provider.js';
import {
  createPhysicalCertificateOrder,
  confirmPhysicalCertificatePayment,
  markPhysicalShipped,
  getPhysicalOrderForUser,
  PhysicalOrderError,
  PHYSICAL_RETAIL_MICROS,
} from './physical-orders.js';

const M = 1_000_000;
const $ = (d: number) => d * M;

class MemStore implements ObjectStore {
  readonly name = 'LOCAL' as const;
  map = new Map<string, { data: Buffer; contentType: string }>();
  async put(key: string, data: Buffer, contentType: string): Promise<StoredObject> { this.map.set(key, { data, contentType }); return { key, contentType, size: data.length }; }
  async get(key: string) { return this.map.get(key) ?? null; }
  async exists(key: string) { return this.map.has(key); }
}
let store: MemStore;

let app: FastifyInstance;
let db: Database;
let organizationId: string;
let seq = 0;

const ADDRESS = { name: 'Nathan D', line1: '1 Market St', city: 'Chicago', region: 'IL', postalCode: '60601', country: 'US' };

async function fundedCert(): Promise<{ userId: string; certId: string }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `merch-${seq}-${Date.now()}@test.local`, passwordHash: await hashPassword('x'), displayName: 'Merch Trader', organizationId }).returning();
  const { accountId } = await provisionAccount(db, { organizationId, userId: u!.id, profileKey: 'htf-core-50k-merch' });
  await db.update(accounts).set({ accountType: 'FUNDED_SIM', status: 'ACTIVE' }).where(eq(accounts.id, accountId));
  await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  await applyRecognition(db, { type: 'account.funded', organizationId, userId: u!.id, accountId, payload: {} } as Parameters<typeof applyRecognition>[1]);
  const [ident] = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(eq(customerIdentities.userId, u!.id));
  const [cert] = await db.select().from(certificates).where(eq(certificates.customerIdentityId, ident!.id));
  return { userId: u!.id, certId: cert!.id };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  const { publishProfileVersion } = await import('./profiles.js');
  await publishProfileVersion(db, { organizationId, key: 'htf-core-50k-merch', name: 'Core 50K Merch', accountType: 'FUNDED_SIM', config: {
    rules: { accountSizeMicros: $(50_000), profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: $(50_000) },
    payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } },
    fundedDestinationKey: null, whopPlanId: null,
  } });
});
beforeEach(() => { store = new MemStore(); setObjectStoreForTest(store); setFulfillmentProviderForTest(new MockFulfillmentProvider()); });
afterAll(async () => { setObjectStoreForTest(null); setFulfillmentProviderForTest(null); await app.close(); });

describe('physical order creation', () => {
  it('creates a PENDING_PAYMENT order at the $99.99 retail for an owned rendered certificate', async () => {
    const { userId, certId } = await fundedCert();
    const order = await createPhysicalCertificateOrder(db, { userId, certificateId: certId, address: ADDRESS });
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.retailAmountMicros).toBe(PHYSICAL_RETAIL_MICROS);
    expect(order.sku).toBe('GLOBAL-CFP-11X14');
  });

  it('denies ordering a certificate the caller does not own (no IDOR)', async () => {
    const a = await fundedCert();
    const b = await fundedCert();
    await expect(createPhysicalCertificateOrder(db, { userId: b.userId, certificateId: a.certId, address: ADDRESS }))
      .rejects.toMatchObject({ code: 'CERTIFICATE_NOT_FOUND' });
  });

  it('rejects an incomplete shipping address', async () => {
    const { userId, certId } = await fundedCert();
    await expect(createPhysicalCertificateOrder(db, { userId, certificateId: certId, address: { name: 'x' } }))
      .rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });

  it('refuses a certificate that is not rendered / eligible', async () => {
    const { userId, certId } = await fundedCert();
    await db.update(certificates).set({ renderStatus: 'DISABLED' }).where(eq(certificates.id, certId));
    await expect(createPhysicalCertificateOrder(db, { userId, certificateId: certId, address: ADDRESS }))
      .rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
  });

  it('is idempotent on the idempotency key', async () => {
    const { userId, certId } = await fundedCert();
    const a = await createPhysicalCertificateOrder(db, { userId, certificateId: certId, address: ADDRESS, idempotencyKey: 'k1' });
    const b = await createPhysicalCertificateOrder(db, { userId, certificateId: certId, address: ADDRESS, idempotencyKey: 'k1' });
    expect(a.id).toBe(b.id);
  });
});

describe('payment → preflight → submit', () => {
  it('a paid order passes preflight and is submitted with a provider order id and positive contribution', async () => {
    const { userId, certId } = await fundedCert();
    const order = await createPhysicalCertificateOrder(db, { userId, certificateId: certId, address: ADDRESS });
    const done = await confirmPhysicalCertificatePayment(db, order.id, { receiptId: 'r1' });
    expect(done.status).toBe('SUBMITTED');
    expect(done.providerOrderId).toBeTruthy();
    expect(done.estimatedContributionMicros!).toBeGreaterThan(0);
  });

  it('payment confirmation is idempotent', async () => {
    const { userId, certId } = await fundedCert();
    const order = await createPhysicalCertificateOrder(db, { userId, certificateId: certId, address: ADDRESS });
    const a = await confirmPhysicalCertificatePayment(db, order.id);
    const b = await confirmPhysicalCertificatePayment(db, order.id);
    expect(a.providerOrderId).toBe(b.providerOrderId);
    expect(b.status).toBe('SUBMITTED');
  });

  it('the provider order is idempotent on our order id', async () => {
    const { userId, certId } = await fundedCert();
    const order = await createPhysicalCertificateOrder(db, { userId, certificateId: certId, address: ADDRESS });
    const done = await confirmPhysicalCertificatePayment(db, order.id);
    const providerId = new MockFulfillmentProvider();
    const p = await providerId.createOrder({ idempotencyKey: order.id, sku: order.sku, quantity: 1, address: ADDRESS, assetRef: 'k' });
    expect(p.providerOrderId).toBe(done.providerOrderId);
  });

  it('preflight catches a missing print artifact and never submits', async () => {
    const { userId, certId } = await fundedCert();
    const order = await createPhysicalCertificateOrder(db, { userId, certificateId: certId, address: ADDRESS });
    store.map.clear(); // artifact vanished
    const done = await confirmPhysicalCertificatePayment(db, order.id);
    expect(done.status).toBe('FULFILLMENT_FAILED');
    expect(done.failureCode).toBe('ARTIFACT_MISSING');
    expect(done.providerOrderId).toBeNull();
  });

  it('preflight holds an order whose fulfillment cost would exceed retail', async () => {
    const { userId, certId } = await fundedCert();
    const order = await createPhysicalCertificateOrder(db, { userId, certificateId: certId, address: ADDRESS });
    await db.update(physicalCertificateOrders).set({ retailAmountMicros: $(10) }).where(eq(physicalCertificateOrders.id, order.id));
    const done = await confirmPhysicalCertificatePayment(db, order.id);
    expect(done.status).toBe('FULFILLMENT_FAILED');
    expect(done.failureCode).toBe('COST_EXCEEDS_RETAIL');
  });

  it('tracking advances a submitted order to shipped', async () => {
    const { userId, certId } = await fundedCert();
    const order = await createPhysicalCertificateOrder(db, { userId, certificateId: certId, address: ADDRESS });
    await confirmPhysicalCertificatePayment(db, order.id);
    const shipped = await markPhysicalShipped(db, order.id, { carrier: 'MockPost', trackingNumber: 'TRK123' });
    expect(shipped?.status).toBe('SHIPPED');
    const owned = await getPhysicalOrderForUser(db, userId, order.id);
    expect(owned?.trackingNumber).toBe('TRK123');
  });
});

describe('provider safety', () => {
  it('the Prodigi provider is disabled by default and refuses to create an order', async () => {
    const prodigi = new ProdigiFulfillmentProvider();
    expect(prodigi.isConfigured()).toBe(false);
    await expect(prodigi.createOrder()).rejects.toMatchObject({ code: 'PRODIGI_DISABLED' });
  });

  it('the active provider defaults to MOCK', () => {
    setFulfillmentProviderForTest(null);
    expect(fulfillmentProvider().name).toBe('MOCK');
    setFulfillmentProviderForTest(new MockFulfillmentProvider());
  });

  it('an unknown order id is rejected', async () => {
    await expect(confirmPhysicalCertificatePayment(db, '00000000-0000-0000-0000-000000000000'))
      .rejects.toBeInstanceOf(PhysicalOrderError);
  });
});
