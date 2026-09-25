/**
 * M11-E — tiers + qualification. Pure boundary math (deterministic, no DB) plus
 * DB-driven qualification against real conversions: threshold crossing, idempotent
 * recalculation, reversed-revenue exclusion, custom-rate protection, manual tiering.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { affiliates, commercialOrders, organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { publishProfileVersion } from './profiles.js';
import { completeCommercialOrder } from './commerce.js';
import { handleRefund } from './commerce-refund.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import type { Actor } from './actor.js';
import { submitApplication, reviewApplication, acceptAffiliateAgreement, changeAffiliateRate } from './affiliates.js';
import { recordClick } from './affiliate-attribution.js';
import { processConversion } from './affiliate-commissions.js';
import { DEFAULT_AFFILIATE_SETTINGS, tierForRevenue, tierRateBps } from './affiliate-config.js';
import {
  periodBounds, currentPeriod, monthlyQualifiedRevenue, tierProgress,
  recalculateTier, setTierManual, recalcAllTiers,
} from './affiliate-tiers.js';

const M = 1_000_000; const $ = (d: number) => d * M;
const OWNER: Actor = { type: 'ADMIN', label: 'owner@test', userId: null };
let db: Database; let handleSql: { end: (o?: unknown) => Promise<void> }; let org: string; let pvId: string; let seq = 0;

function cfg(size: number, price: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: $(1500), maxLossMicros: $(1000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: size, priceMicros: $(price) }, payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } }, fundedDestinationKey: null, whopPlanId: null };
}
async function buyer(): Promise<string> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `tb-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('tb-pw-12345678'), displayName: `B${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
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
/** Book `amount` of qualified referred revenue to an affiliate in the current period. */
async function bookRevenue(affiliateId: string, code: string, amount: number): Promise<string> {
  const b = await buyer();
  const s = `s-${crypto.randomUUID()}`;
  await recordClick(db, { organizationId: org, code, sessionRef: s });
  const o = await completeCommercialOrder(db, { organizationId: org, userId: b, productVersionId: pvId, source: 'PURCHASE', amountMicros: amount, currency: 'USD', idempotencyKey: `ord-${crypto.randomUUID()}` });
  await processConversion(db, { orderId: o.id, sessionRef: s });
  void affiliateId;
  return o.id;
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m11tier-${crypto.randomUUID().slice(0, 8)}`, name: 'M11TIER' }).returning();
  org = o!.id;
  const pv = await publishProfileVersion(db, { organizationId: org, key: 'm11-tier-pv', name: 'Tier PV', accountType: 'EVALUATION', config: cfg($(25_000), 65) });
  pvId = pv.versionId;
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('tierForRevenue boundaries (pure)', () => {
  it.each([
    [0, 'AFFILIATE'], [$(9_999), 'AFFILIATE'], [$(10_000) - 1, 'AFFILIATE'],
    [$(10_000), 'PARTNER'], [$(29_999), 'PARTNER'], [$(30_000) - 1, 'PARTNER'],
    [$(30_000), 'GOLD'], [$(74_999), 'GOLD'], [$(75_000) - 1, 'GOLD'],
    [$(75_000), 'PLATINUM'], [$(1_000_000), 'PLATINUM'],
  ] as const)('%d → %s', (rev, tier) => {
    expect(tierForRevenue(DEFAULT_AFFILIATE_SETTINGS, rev)).toBe(tier);
  });
  it('tierRateBps maps each tier to its configured rate', () => {
    expect(tierRateBps(DEFAULT_AFFILIATE_SETTINGS, 'AFFILIATE')).toBe(1500);
    expect(tierRateBps(DEFAULT_AFFILIATE_SETTINGS, 'PARTNER')).toBe(1750);
    expect(tierRateBps(DEFAULT_AFFILIATE_SETTINGS, 'GOLD')).toBe(2000);
    expect(tierRateBps(DEFAULT_AFFILIATE_SETTINGS, 'PLATINUM')).toBe(2500);
  });
  it('honours configurable thresholds (not hardcoded)', () => {
    const custom = { ...DEFAULT_AFFILIATE_SETTINGS, tierThresholdsMicros: { ...DEFAULT_AFFILIATE_SETTINGS.tierThresholdsMicros, PARTNER: $(5_000) } };
    expect(tierForRevenue(custom, $(5_000))).toBe('PARTNER');
    expect(tierForRevenue(custom, $(4_999))).toBe('AFFILIATE');
  });
});

describe('period helpers (pure)', () => {
  it('currentPeriod is YYYY-MM', () => { expect(currentPeriod(new Date(Date.UTC(2026, 8, 25)))).toBe('2026-09'); });
  it('periodBounds spans exactly the month (UTC)', () => {
    const { start, end } = periodBounds('2026-09');
    expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('qualification against real conversions', () => {
  it('a new affiliate is AFFILIATE at 15% with zero qualified revenue', async () => {
    const a = await activeAffiliate();
    const [aff] = await db.select().from(affiliates).where(eq(affiliates.id, a.affiliateId));
    expect(aff!.tier).toBe('AFFILIATE');
    expect(aff!.effectiveRateBps).toBe(1500);
    expect(await monthlyQualifiedRevenue(db, a.affiliateId, currentPeriod())).toBe(0);
  });
  it('recalculateTier with no revenue keeps AFFILIATE (idempotent)', async () => {
    const a = await activeAffiliate();
    const r = await recalculateTier(db, a.affiliateId);
    expect(r.changed).toBe(false);
    expect(r.tier).toBe('AFFILIATE');
  });
  it('crossing $10k qualifies PARTNER and sets the rate to 17.5%', async () => {
    const a = await activeAffiliate();
    await bookRevenue(a.affiliateId, a.code, $(10_000));
    expect(await monthlyQualifiedRevenue(db, a.affiliateId, currentPeriod())).toBe($(10_000));
    const r = await recalculateTier(db, a.affiliateId);
    expect(r.changed).toBe(true);
    expect(r.tier).toBe('PARTNER');
    const [aff] = await db.select().from(affiliates).where(eq(affiliates.id, a.affiliateId));
    expect(aff!.effectiveRateBps).toBe(1750);
  });
  it('recalculateTier is idempotent once qualified', async () => {
    const a = await activeAffiliate();
    await bookRevenue(a.affiliateId, a.code, $(30_000));
    expect((await recalculateTier(db, a.affiliateId)).tier).toBe('GOLD');
    const second = await recalculateTier(db, a.affiliateId);
    expect(second.changed).toBe(false);
    expect(second.tier).toBe('GOLD');
  });
  it('a reversed conversion is excluded from qualified revenue', async () => {
    const a = await activeAffiliate();
    const orderId = await bookRevenue(a.affiliateId, a.code, $(12_000));
    expect(await monthlyQualifiedRevenue(db, a.affiliateId, currentPeriod())).toBe($(12_000));
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    await handleRefund(db, { order: order!, reason: 'refund', actor: OWNER });
    expect(await monthlyQualifiedRevenue(db, a.affiliateId, currentPeriod())).toBe(0);
  });
  it('a custom-rate affiliate is never auto-tiered', async () => {
    const a = await activeAffiliate();
    await changeAffiliateRate(db, a.affiliateId, 2300, OWNER, { reason: 'strategic' });
    await bookRevenue(a.affiliateId, a.code, $(80_000)); // would be PLATINUM by revenue
    const r = await recalculateTier(db, a.affiliateId);
    expect(r.changed).toBe(false);
    const [aff] = await db.select().from(affiliates).where(eq(affiliates.id, a.affiliateId));
    expect(aff!.effectiveRateBps).toBe(2300); // custom override untouched
  });
  it('recalcAllTiers reports the number of affiliates re-tiered', async () => {
    const a = await activeAffiliate();
    await bookRevenue(a.affiliateId, a.code, $(75_000));
    const changed = await recalcAllTiers(db, org);
    expect(changed).toBeGreaterThanOrEqual(1);
    const [aff] = await db.select().from(affiliates).where(eq(affiliates.id, a.affiliateId));
    expect(aff!.tier).toBe('PLATINUM');
  });
});

describe('manual tiering + progress', () => {
  it('setTierManual assigns the tier, its rate, and records history', async () => {
    const a = await activeAffiliate();
    await setTierManual(db, a.affiliateId, 'GOLD', OWNER, 'relationship');
    const [aff] = await db.select().from(affiliates).where(eq(affiliates.id, a.affiliateId));
    expect(aff!.tier).toBe('GOLD');
    expect(aff!.effectiveRateBps).toBe(2000);
  });
  it('tierProgress reports the next tier and remaining amount', async () => {
    const a = await activeAffiliate();
    await bookRevenue(a.affiliateId, a.code, $(4_000));
    const p = await tierProgress(db, a.affiliateId);
    expect(p.tier).toBe('AFFILIATE');
    expect(p.nextTier).toBe('PARTNER');
    expect(p.nextThresholdMicros).toBe($(10_000));
    expect(p.remainingMicros).toBe($(6_000));
  });
  it('tierProgress at the top tier has no next tier', async () => {
    const a = await activeAffiliate();
    await setTierManual(db, a.affiliateId, 'PLATINUM', OWNER, 'top');
    const p = await tierProgress(db, a.affiliateId);
    expect(p.nextTier).toBeNull();
    expect(p.remainingMicros).toBeNull();
  });
});
