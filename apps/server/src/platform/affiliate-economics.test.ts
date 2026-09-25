/**
 * M11-D/E — commission economics correctness: integer-exact rate math, historical
 * rate/config SNAPSHOT immutability (changing a rate or config tomorrow never
 * rewrites yesterday's commission), commission basis (net vs gross), maturity
 * idempotency, and the ledger sum invariant (availableMicros === Σ ledger amounts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { affiliateCommissions, affiliateLedger, commercialOrders, organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { publishProfileVersion } from './profiles.js';
import { completeCommercialOrder } from './commerce.js';
import { handleRefund } from './commerce-refund.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import type { Actor } from './actor.js';
import { submitApplication, reviewApplication, acceptAffiliateAgreement, changeAffiliateRate } from './affiliates.js';
import { recordClick } from './affiliate-attribution.js';
import { processConversion, matureCommissions, affiliateBalance, manualAdjustment } from './affiliate-commissions.js';
import { commissionMicrosFor, getAffiliateConfig, updateAffiliateConfig } from './affiliate-config.js';

const M = 1_000_000; const $ = (d: number) => d * M;
const OWNER: Actor = { type: 'ADMIN', label: 'owner@test', userId: null };
let db: Database; let handleSql: { end: (o?: unknown) => Promise<void> }; let org: string; let pvId: string; let seq = 0;
const FUTURE = () => new Date(Date.now() + 60 * 86_400_000);

function cfg(size: number, price: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: $(1500), maxLossMicros: $(1000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: size, priceMicros: $(price) }, payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } }, fundedDestinationKey: null, whopPlanId: null };
}
async function buyer(): Promise<string> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `eb-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('eb-pw-12345678'), displayName: `B${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
  await ensureCustomerIdentity(db, { organizationId: org, userId: u!.id });
  return u!.id;
}
async function activeAffiliate(): Promise<{ affiliateId: string; code: string }> {
  const userId = await buyer();
  const { affiliateId } = await submitApplication(db, { organizationId: org, userId, fullName: `Aff ${seq}`, email: `aff-${seq}@creator.test`, actor: OWNER });
  await reviewApplication(db, affiliateId, 'APPROVE', OWNER);
  const { code } = await acceptAffiliateAgreement(db, affiliateId, { actor: OWNER });
  return { affiliateId, code };
}
async function convert(code: string, amount: number, opts: { discountMicros?: number; source?: string } = {}): Promise<string> {
  const b = await buyer();
  const s = `s-${crypto.randomUUID()}`;
  await recordClick(db, { organizationId: org, code, sessionRef: s });
  const o = await completeCommercialOrder(db, { organizationId: org, userId: b, productVersionId: pvId, source: opts.source ?? 'PURCHASE', amountMicros: amount, currency: 'USD', idempotencyKey: `ord-${crypto.randomUUID()}` });
  await processConversion(db, { orderId: o.id, sessionRef: s, discountMicros: opts.discountMicros ?? null });
  return o.id;
}
async function ledgerSum(affiliateId: string): Promise<number> {
  const [row] = await db.select({ s: sql<number>`coalesce(sum(${affiliateLedger.amountMicros}),0)::bigint` }).from(affiliateLedger).where(eq(affiliateLedger.affiliateId, affiliateId));
  return Number(row?.s ?? 0);
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m11eco-${crypto.randomUUID().slice(0, 8)}`, name: 'M11ECO' }).returning();
  org = o!.id;
  const pv = await publishProfileVersion(db, { organizationId: org, key: 'm11-eco-pv', name: 'Eco PV', accountType: 'EVALUATION', config: cfg($(25_000), 65) });
  pvId = pv.versionId;
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('commissionMicrosFor is integer-exact (pure)', () => {
  it.each([
    [$(100), 1500, $(15)],
    [$(100), 1750, $(17.5)],
    [$(100), 2000, $(20)],
    [$(100), 2500, $(25)],
    [$(65), 1500, 9_750_000],
    [1, 1500, 0],           // 0.15 floors to 0
    [6, 1500, 0],           // 0.9 floors to 0
    [7, 1500, 1],           // 1.05 floors to 1
    [10_000, 1500, 1500],   // exact
    [999_999, 1750, 174_999], // floors 174999.825
    [0, 1500, 0],
    [$(100), 0, 0],
  ] as const)('commissionMicrosFor(%d, %d) === %d', (q, bps, expected) => {
    expect(commissionMicrosFor(q, bps)).toBe(expected);
  });
  it('never returns a fractional micro', () => {
    for (let i = 0; i < 50; i += 1) {
      const v = commissionMicrosFor(1_000_000 + i * 37, 1750);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe('historical snapshot immutability', () => {
  it('changing the rate later never rewrites an existing commission', async () => {
    const a = await activeAffiliate();
    await convert(a.code, $(100)); // 15% → $15 snapshotted
    const [before] = await db.select().from(affiliateCommissions).where(eq(affiliateCommissions.affiliateId, a.affiliateId));
    expect(before!.rateBps).toBe(1500);
    expect(before!.commissionMicros).toBe($(15));
    await changeAffiliateRate(db, a.affiliateId, 2500, OWNER, { reason: 'promoted' });
    const [after] = await db.select().from(affiliateCommissions).where(eq(affiliateCommissions.id, before!.id));
    expect(after!.rateBps).toBe(1500);          // unchanged
    expect(after!.commissionMicros).toBe($(15)); // unchanged
  });
  it('a new conversion after a rate change uses the new rate', async () => {
    const a = await activeAffiliate();
    await convert(a.code, $(100)); // $15 at 15%
    await changeAffiliateRate(db, a.affiliateId, 2500, OWNER, { reason: 'promoted' });
    await convert(a.code, $(100)); // $25 at 25%
    const rows = await db.select().from(affiliateCommissions).where(eq(affiliateCommissions.affiliateId, a.affiliateId));
    const amounts = rows.map((r) => r.commissionMicros).sort((x, y) => x - y);
    expect(amounts).toEqual([$(15), $(25)]);
  });
  it('the commission snapshots the config version, and a later config bump does not change it', async () => {
    const a = await activeAffiliate();
    const cfgBefore = await getAffiliateConfig(db, org);
    await convert(a.code, $(100));
    const [comm] = await db.select().from(affiliateCommissions).where(eq(affiliateCommissions.affiliateId, a.affiliateId));
    expect(comm!.configVersion).toBe(cfgBefore.version);
    await updateAffiliateConfig(db, org, { commissionMaturityDays: 20 }, OWNER);
    const [after] = await db.select().from(affiliateCommissions).where(eq(affiliateCommissions.id, comm!.id));
    expect(after!.configVersion).toBe(cfgBefore.version); // still the version at creation
    expect(after!.maturityAt.getTime()).toBe(comm!.maturityAt.getTime()); // maturity fixed at creation
    await updateAffiliateConfig(db, org, { commissionMaturityDays: 14 }, OWNER); // restore
  });
});

describe('commission basis', () => {
  it('net-after-discount is the default basis', async () => {
    const a = await activeAffiliate();
    await convert(a.code, $(100), { discountMicros: $(20) });
    const [comm] = await db.select().from(affiliateCommissions).where(eq(affiliateCommissions.affiliateId, a.affiliateId));
    expect(comm!.qualifiedRevenueMicros).toBe($(80));
    expect(comm!.commissionMicros).toBe($(12)); // 15% of 80
  });
  it('GROSS basis commissions on the pre-discount amount', async () => {
    await updateAffiliateConfig(db, org, { commissionBasis: 'GROSS' }, OWNER);
    const a = await activeAffiliate();
    await convert(a.code, $(100), { discountMicros: $(20) });
    const [comm] = await db.select().from(affiliateCommissions).where(eq(affiliateCommissions.affiliateId, a.affiliateId));
    expect(comm!.qualifiedRevenueMicros).toBe($(100));
    await updateAffiliateConfig(db, org, { commissionBasis: 'NET_AFTER_DISCOUNT' }, OWNER); // restore
  });
});

describe('maturity idempotency', () => {
  it('maturing twice does not double-credit the balance', async () => {
    const a = await activeAffiliate();
    await convert(a.code, $(200)); // $30
    await matureCommissions(db, org, FUTURE());
    const first = (await affiliateBalance(db, a.affiliateId)).availableMicros;
    await matureCommissions(db, org, FUTURE());
    const second = (await affiliateBalance(db, a.affiliateId)).availableMicros;
    expect(first).toBe($(30));
    expect(second).toBe($(30));
  });
  it('a commission before maturity is pending, not available', async () => {
    const a = await activeAffiliate();
    await convert(a.code, $(200));
    const bal = await affiliateBalance(db, a.affiliateId);
    expect(bal.pendingMicros).toBe($(30));
    expect(bal.availableMicros).toBe(0);
  });
});

describe('ledger sum invariant', () => {
  it('availableMicros equals the raw ledger sum through create → mature → adjust → refund', async () => {
    const a = await activeAffiliate();
    const orderId = await convert(a.code, $(300)); // $45
    expect((await affiliateBalance(db, a.affiliateId)).availableMicros).toBe(await ledgerSum(a.affiliateId));
    await matureCommissions(db, org, FUTURE());
    expect((await affiliateBalance(db, a.affiliateId)).availableMicros).toBe(await ledgerSum(a.affiliateId));
    await manualAdjustment(db, { organizationId: org, affiliateId: a.affiliateId, amountMicros: $(5), reasonCode: 'GOODWILL', explanation: 'bonus for test', actor: OWNER });
    expect((await affiliateBalance(db, a.affiliateId)).availableMicros).toBe(await ledgerSum(a.affiliateId));
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    await handleRefund(db, { order: order!, reason: 'refund', actor: OWNER });
    expect((await affiliateBalance(db, a.affiliateId)).availableMicros).toBe(await ledgerSum(a.affiliateId));
  });
  it('a lifecycle-only ledger entry (COMMISSION_CREATED) carries zero amount', async () => {
    const a = await activeAffiliate();
    await convert(a.code, $(100));
    const [created] = await db.select().from(affiliateLedger).where(eq(affiliateLedger.affiliateId, a.affiliateId));
    expect(created!.entryType).toBe('COMMISSION_CREATED');
    expect(created!.amountMicros).toBe(0);
  });
});

describe('reset revenue policy', () => {
  it('a reset/non-purchase order does not commission by default', async () => {
    const a = await activeAffiliate();
    const orderId = await convert(a.code, $(150), { source: 'RESET' });
    const comms = await db.select().from(affiliateCommissions).where(eq(affiliateCommissions.commercialOrderId, orderId));
    expect(comms.length).toBe(0);
  });
  it('the default reset policy is NONE', async () => {
    const c = await getAffiliateConfig(db, org);
    expect(c.settings.resetCommissionPolicy).toBe('NONE');
  });
});
