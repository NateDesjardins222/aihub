/**
 * Reward triggers — exactly-once issuance, rendering, club crossings (M6-E).
 *
 * Drives the recognition subscriber deterministically against the real DB: the
 * right certificate/achievement is issued exactly once per authoritative event,
 * duplicate/concurrent events never double-issue, club milestones cross using
 * PAID trader-share only, the 100K club opens a MANUAL plaque (never a provider
 * order), and each issued certificate is rendered into stored artifacts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb, type Database } from '../db/client.js';
import { accounts, achievements, certificates, customerIdentities, payoutRequests, physicalRewardFulfillment, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { applyRecognition } from './recognition.js';
import { setObjectStoreForTest, type ObjectStore, type StoredObject } from './object-store.js';

const M = 1_000_000;
const $ = (d: number) => d * M;

// In-memory object store so tests assert artifacts without touching disk.
class MemStore implements ObjectStore {
  readonly name = 'LOCAL' as const;
  map = new Map<string, { data: Buffer; contentType: string }>();
  async put(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
    if (this.map.has(key)) throw new Error('exists');
    this.map.set(key, { data, contentType });
    return { key, contentType, size: data.length };
  }
  async get(key: string) { return this.map.get(key) ?? null; }
  async exists(key: string) { return this.map.has(key); }
}

let app: FastifyInstance;
let db: Database;
let organizationId: string;
let seq = 0;

async function makeFundedUser(): Promise<{ userId: string; accountId: string }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `rew-${seq}-${Date.now()}@test.local`, passwordHash: await hashPassword('x'), displayName: 'Reward Trader', organizationId }).returning();
  const { accountId } = await provisionAccount(db, { organizationId, userId: u!.id, profileKey: 'htf-core-50k-rew' });
  await db.update(accounts).set({ accountType: 'FUNDED_SIM', status: 'ACTIVE' }).where(eq(accounts.id, accountId));
  await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  return { userId: u!.id, accountId };
}

/** Insert a PAID payout row so cumulative trader-share reflects it. */
async function insertPaidPayout(accountId: string, userId: string, traderShare: number): Promise<string> {
  const [row] = await db.insert(payoutRequests).values({
    organizationId, accountId, userId, state: 'PAID', requestedGrossMicros: Math.round(traderShare / 0.9), traderShareMicros: traderShare, firmShareMicros: Math.round(traderShare / 0.9) - traderShare, payoutOrdinal: 1,
  }).returning();
  return row!.id;
}

async function certsFor(userId: string, type: string) {
  const [ident] = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(eq(customerIdentities.userId, userId));
  return db.select().from(certificates).where(and(eq(certificates.customerIdentityId, ident!.id), eq(certificates.type, type)));
}
async function achievementsFor(userId: string, type: string) {
  const [ident] = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(eq(customerIdentities.userId, userId));
  return db.select().from(achievements).where(and(eq(achievements.customerIdentityId, ident!.id), eq(achievements.type, type)));
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  const { publishProfileVersion } = await import('./profiles.js');
  await publishProfileVersion(db, { organizationId, key: 'htf-core-50k-rew', name: 'Core 50K Rew', accountType: 'FUNDED_SIM', config: {
    rules: { accountSizeMicros: $(50_000), profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: $(50_000) },
    payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } },
    fundedDestinationKey: null, whopPlanId: null,
  } });
});
beforeEach(() => setObjectStoreForTest(new MemStore()));
afterAll(async () => { setObjectStoreForTest(null); await app.close(); });

const ev = (type: string, userId: string, accountId: string | null, payload: Record<string, unknown> = {}) =>
  ({ type, organizationId, userId, accountId, payload } as Parameters<typeof applyRecognition>[1]);

describe('reward issuance — exactly once', () => {
  it('funded transition issues a FUNDED_TRADER certificate once', async () => {
    const { userId, accountId } = await makeFundedUser();
    await applyRecognition(db, ev('account.funded', userId, accountId));
    expect((await certsFor(userId, 'FUNDED_TRADER')).length).toBe(1);
    expect((await achievementsFor(userId, 'FUNDED')).length).toBe(1);
  });

  it('a duplicate funded event does not duplicate the certificate', async () => {
    const { userId, accountId } = await makeFundedUser();
    await applyRecognition(db, ev('account.funded', userId, accountId));
    await applyRecognition(db, ev('account.funded', userId, accountId));
    expect((await certsFor(userId, 'FUNDED_TRADER')).length).toBe(1);
  });

  it('concurrent funded events still issue exactly one certificate', async () => {
    const { userId, accountId } = await makeFundedUser();
    await Promise.all([
      applyRecognition(db, ev('account.funded', userId, accountId)),
      applyRecognition(db, ev('account.funded', userId, accountId)),
      applyRecognition(db, ev('account.funded', userId, accountId)),
    ]);
    expect((await certsFor(userId, 'FUNDED_TRADER')).length).toBe(1);
  });

  it('a PAID payout issues a PAYOUT certificate for the trader share; a duplicate does not', async () => {
    const { userId, accountId } = await makeFundedUser();
    const reqId = await insertPaidPayout(accountId, userId, $(1_700));
    await applyRecognition(db, ev('payout.paid', userId, accountId, { payoutRequestId: reqId }));
    await applyRecognition(db, ev('payout.paid', userId, accountId, { payoutRequestId: reqId }));
    const rows = await certsFor(userId, 'PAYOUT');
    expect(rows.length).toBe(1);
    expect(rows[0]!.amountMicros).toBe($(1_700));
  });

  it('account completion issues an ACCOUNT_COMPLETED certificate once', async () => {
    const { userId, accountId } = await makeFundedUser();
    await applyRecognition(db, ev('account.completed', userId, accountId, { totalTraderShareMicros: $(9_000) }));
    await applyRecognition(db, ev('account.completed', userId, accountId, { totalTraderShareMicros: $(9_000) }));
    const rows = await certsFor(userId, 'ACCOUNT_COMPLETED');
    expect(rows.length).toBe(1);
    expect(rows[0]!.amountMicros).toBe($(9_000));
  });
});

describe('club milestones — PAID trader-share crossings', () => {
  it('crossing $10k issues the 10K club certificate + achievement once', async () => {
    const { userId, accountId } = await makeFundedUser();
    const r = await insertPaidPayout(accountId, userId, $(11_200));
    await applyRecognition(db, ev('payout.paid', userId, accountId, { payoutRequestId: r }));
    const certs = await certsFor(userId, 'TENK_CLUB');
    expect(certs.length).toBe(1);
    // The certificate prints the LOCKED milestone label, not the actual total.
    expect(certs[0]!.milestoneValueMicros).toBe($(10_000));
    expect((await achievementsFor(userId, 'TENK_CLUB')).length).toBe(1);
  });

  it('does not re-issue a club already earned', async () => {
    const { userId, accountId } = await makeFundedUser();
    const r1 = await insertPaidPayout(accountId, userId, $(11_000));
    await applyRecognition(db, ev('payout.paid', userId, accountId, { payoutRequestId: r1 }));
    const r2 = await insertPaidPayout(accountId, userId, $(500));
    await applyRecognition(db, ev('payout.paid', userId, accountId, { payoutRequestId: r2 }));
    expect((await certsFor(userId, 'TENK_CLUB')).length).toBe(1);
  });

  it('one large payout can cross 10k, 50k and 100k at once', async () => {
    const { userId, accountId } = await makeFundedUser();
    const r = await insertPaidPayout(accountId, userId, $(120_000));
    await applyRecognition(db, ev('payout.paid', userId, accountId, { payoutRequestId: r }));
    expect((await certsFor(userId, 'TENK_CLUB')).length).toBe(1);
    expect((await certsFor(userId, 'FIFTYK_CLUB')).length).toBe(1);
    expect((await certsFor(userId, 'HUNDREDK_CLUB')).length).toBe(1);
  });

  it('the 100K club opens a MANUAL plaque fulfillment, never a provider order', async () => {
    const { userId, accountId } = await makeFundedUser();
    const r = await insertPaidPayout(accountId, userId, $(100_000));
    await applyRecognition(db, ev('payout.paid', userId, accountId, { payoutRequestId: r }));
    const [ident] = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(eq(customerIdentities.userId, userId));
    const plaques = await db.select().from(physicalRewardFulfillment).where(eq(physicalRewardFulfillment.customerIdentityId, ident!.id));
    expect(plaques.length).toBe(1);
    expect(plaques[0]!.type).toBe('PLAQUE_100K');
    expect(plaques[0]!.status).toBe('PENDING_REVIEW');
  });

  it('a below-threshold lifetime total earns no club', async () => {
    const { userId, accountId } = await makeFundedUser();
    const r = await insertPaidPayout(accountId, userId, $(4_000));
    await applyRecognition(db, ev('payout.paid', userId, accountId, { payoutRequestId: r }));
    expect((await certsFor(userId, 'TENK_CLUB')).length).toBe(0);
  });
});

describe('rendering — issued certificates get stored artifacts', () => {
  it('a funded certificate is rendered into stored PNG + PDF with a hash', async () => {
    const { userId, accountId } = await makeFundedUser();
    await applyRecognition(db, ev('account.funded', userId, accountId));
    const [cert] = await certsFor(userId, 'FUNDED_TRADER');
    expect(cert!.renderStatus).toBe('RENDERED');
    expect(cert!.imageStorageKey).toBeTruthy();
    expect(cert!.pdfStorageKey).toBeTruthy();
    expect(cert!.renderHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cert!.rendererVersion).toBe('r1');
  });
});
