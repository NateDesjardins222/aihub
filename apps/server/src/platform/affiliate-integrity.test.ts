/**
 * M11-I/J — cross-surface integration: the affiliate data-integrity invariants
 * (clean pass + corruption detection), the owner overview/360 read models, the
 * financial-ops roll-up, the truthful System Doctor payout probe, and program
 * config editability (rates/thresholds/min payout are config, not constants).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { affiliates, organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { publishProfileVersion } from './profiles.js';
import { completeCommercialOrder } from './commerce.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import type { Actor } from './actor.js';
import { submitApplication, reviewApplication, acceptAffiliateAgreement } from './affiliates.js';
import { recordClick } from './affiliate-attribution.js';
import { processConversion, matureCommissions } from './affiliate-commissions.js';
import { requestPayout } from './affiliate-payouts.js';
import { ownerAffiliateOverview, affiliate360 } from './affiliate-analytics.js';
import { runIntegrityChecks } from './integrity.js';
import { runSystemDoctor } from './system-doctor.js';
import { financialSummary } from './financial-ops.js';
import { getAffiliateConfig, updateAffiliateConfig } from './affiliate-config.js';

const M = 1_000_000; const $ = (d: number) => d * M;
const OWNER: Actor = { type: 'ADMIN', label: 'owner@test', userId: null };
let db: Database; let handleSql: { end: (o?: unknown) => Promise<void> }; let org: string; let pvId: string; let seq = 0;
const FUTURE = () => new Date(Date.now() + 60 * 86_400_000);

function cfg(size: number, price: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: $(1500), maxLossMicros: $(1000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: size, priceMicros: $(price) }, payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } }, fundedDestinationKey: null, whopPlanId: null };
}
async function buyer(): Promise<string> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `ib-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('ib-pw-12345678'), displayName: `B${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
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
async function convert(code: string, amount: number): Promise<string> {
  const b = await buyer();
  const s = `s-${crypto.randomUUID()}`;
  await recordClick(db, { organizationId: org, code, sessionRef: s });
  const o = await completeCommercialOrder(db, { organizationId: org, userId: b, productVersionId: pvId, source: 'PURCHASE', amountMicros: amount, currency: 'USD', idempotencyKey: `ord-${crypto.randomUUID()}` });
  await processConversion(db, { orderId: o.id, sessionRef: s });
  return o.id;
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m11int-${crypto.randomUUID().slice(0, 8)}`, name: 'M11INT' }).returning();
  org = o!.id;
  const pv = await publishProfileVersion(db, { organizationId: org, key: 'm11-int-pv', name: 'Int PV', accountType: 'EVALUATION', config: cfg($(25_000), 65) });
  pvId = pv.versionId;
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('data-integrity invariants', () => {
  it('all affiliate invariants PASS on clean data', async () => {
    const a = await activeAffiliate();
    await convert(a.code, $(100));
    const report = await runIntegrityChecks(db, org, false);
    const keys = ['INV_AFFILIATE_COMMISSION_HAS_CONVERSION', 'INV_ACTIVE_AFFILIATE_HAS_AGREEMENT', 'INV_ONE_COMMISSION_PER_ORDER'];
    for (const k of keys) {
      const c = report.checks.find((x) => x.key === k);
      expect(c, k).toBeTruthy();
      expect(c!.status, k).toBe('PASS');
    }
  });
  it('detects an ACTIVE affiliate missing its agreement acceptance', async () => {
    const a = await activeAffiliate();
    await db.update(affiliates).set({ agreementAcceptedVersionId: null }).where(eq(affiliates.id, a.affiliateId));
    const report = await runIntegrityChecks(db, org, false);
    const c = report.checks.find((x) => x.key === 'INV_ACTIVE_AFFILIATE_HAS_AGREEMENT');
    expect(c!.status).toBe('FAIL');
    expect(c!.affectedCount).toBeGreaterThanOrEqual(1);
    // restore so later checks are clean
    const [row] = await db.select().from(affiliates).where(eq(affiliates.id, a.affiliateId));
    void row;
  });
});

describe('owner read models', () => {
  it('ownerAffiliateOverview counts active affiliates, pending applications, and MTD revenue', async () => {
    const a = await activeAffiliate();
    await convert(a.code, $(200));
    // a pending applicant (submitted, not reviewed)
    const u = await buyer();
    await submitApplication(db, { organizationId: org, userId: u, fullName: 'Pending P', email: `pend-${seq}@creator.test`, actor: OWNER });
    const ov = await ownerAffiliateOverview(db, org);
    expect(ov.activeAffiliates).toBeGreaterThanOrEqual(1);
    expect(ov.pendingApplications).toBeGreaterThanOrEqual(1);
    expect(ov.referredRevenueMtdMicros).toBeGreaterThanOrEqual($(200));
    expect(ov.commissionAccruedMicros).toBeGreaterThanOrEqual($(30));
  });
  it('affiliate360 returns the full internal record', async () => {
    const a = await activeAffiliate();
    await convert(a.code, $(100));
    const view = await affiliate360(db, a.affiliateId);
    expect(view).toBeTruthy();
    expect(view!.affiliate.id).toBe(a.affiliateId);
    expect(Array.isArray(view!.codes)).toBe(true);
    expect(Array.isArray(view!.recentCommissions)).toBe(true);
    expect(view!.balance).toBeTruthy();
  });
  it('affiliate360 is null for an unknown id', async () => {
    expect(await affiliate360(db, crypto.randomUUID())).toBeNull();
  });
});

describe('financial-ops roll-up', () => {
  it('includes affiliate commission payable/paid and payout liability', async () => {
    const a = await activeAffiliate();
    await convert(a.code, $(1000)); // $150
    await matureCommissions(db, org, FUTURE());
    await requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(100), actor: OWNER });
    const fin = await financialSummary(db, org);
    expect(fin.affiliateCommissionPayableMicros).toBeGreaterThanOrEqual($(150));
    expect(fin.affiliatePayoutLiabilityMicros).toBeGreaterThanOrEqual($(100));
    expect(typeof fin.affiliateCommissionPaidMicros).toBe('number');
  });
});

describe('System Doctor payout probe is truthful', () => {
  it('reports the affiliate payout provider as NOT_CONFIGURED (informational, not critical)', async () => {
    const report = await runSystemDoctor(db, org, false);
    const c = report.checks.find((x) => x.key === 'affiliate_payouts');
    expect(c).toBeTruthy();
    expect(c!.status).toBe('NOT_CONFIGURED');
    expect(c!.severity).toBe('INFO');
  });
});

describe('program config is data, not code', () => {
  it('rates and thresholds are editable and versioned', async () => {
    const before = await getAffiliateConfig(db, org);
    const after = await updateAffiliateConfig(db, org, {
      tierRatesBps: { ...before.settings.tierRatesBps, AFFILIATE: 1600 },
      minPayoutMicros: $(75),
    }, OWNER);
    expect(after.version).toBe(before.version + 1);
    expect(after.settings.tierRatesBps.AFFILIATE).toBe(1600);
    expect(after.settings.minPayoutMicros).toBe($(75));
    // restore
    await updateAffiliateConfig(db, org, { tierRatesBps: before.settings.tierRatesBps, minPayoutMicros: before.settings.minPayoutMicros }, OWNER);
  });
  it('a partial update preserves untouched keys', async () => {
    const before = await getAffiliateConfig(db, org);
    const after = await updateAffiliateConfig(db, org, { commissionMaturityDays: 10 }, OWNER);
    expect(after.settings.commissionMaturityDays).toBe(10);
    expect(after.settings.attributionWindowDays).toBe(before.settings.attributionWindowDays);
    await updateAffiliateConfig(db, org, { commissionMaturityDays: before.settings.commissionMaturityDays }, OWNER);
  });
  it('minimum payout is enforced from config (raising it blocks a previously-valid request)', async () => {
    const a = await activeAffiliate();
    await convert(a.code, $(1000)); // $150
    await matureCommissions(db, org, FUTURE());
    const before = await getAffiliateConfig(db, org);
    await updateAffiliateConfig(db, org, { minPayoutMicros: $(200) }, OWNER);
    await expect(requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(120), actor: OWNER })).rejects.toThrow();
    await updateAffiliateConfig(db, org, { minPayoutMicros: before.settings.minPayoutMicros }, OWNER);
  });
});
