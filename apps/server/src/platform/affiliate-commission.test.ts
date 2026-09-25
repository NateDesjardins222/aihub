/**
 * M11-C/D/F/G — attribution, commission engine, reversals, balances, payouts.
 * Drives the REAL engine against real commercial orders. Money is micros; every
 * assertion is exact-integer. Covers exactly-once, precedence, self-referral,
 * maturity, refunds, chargebacks, negative balance, payout minimum and the
 * double-withdraw race.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { affiliateCommissions, affiliateConversions, affiliateRiskSignals, commercialOrders, organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { publishProfileVersion } from './profiles.js';
import { completeCommercialOrder } from './commerce.js';
import { handleRefund, handleDispute } from './commerce-refund.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import type { Actor } from './actor.js';
import { submitApplication, reviewApplication, acceptAffiliateAgreement } from './affiliates.js';
import { recordClick } from './affiliate-attribution.js';
import { processConversion, matureCommissions, affiliateBalance, manualAdjustment } from './affiliate-commissions.js';
import { requestPayout, markPayoutPaid, approvePayout } from './affiliate-payouts.js';

const M = 1_000_000; const $ = (d: number) => d * M;
const OWNER: Actor = { type: 'ADMIN', label: 'owner@test', userId: null };
let db: Database; let handleSql: { end: (o?: unknown) => Promise<void> }; let org: string; let pvId: string; let seq = 0;
const KEY = 'm11c-25k';

function cfg(size: number, price: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: $(1500), maxLossMicros: $(1000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: size, priceMicros: $(price) }, payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } }, fundedDestinationKey: null, whopPlanId: null };
}

async function buyer(): Promise<string> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `buyer-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('buyer-pw-12345678'), displayName: `Buyer ${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
  await ensureCustomerIdentity(db, { organizationId: org, userId: u!.id });
  return u!.id;
}

async function activeAffiliate(): Promise<{ affiliateId: string; code: string; userId: string }> {
  const userId = await buyer();
  const { affiliateId } = await submitApplication(db, { organizationId: org, userId, fullName: `Aff ${seq}`, email: `aff-${seq}@creator.test`, actor: OWNER });
  await reviewApplication(db, affiliateId, 'APPROVE', OWNER);
  const { code } = await acceptAffiliateAgreement(db, affiliateId, { actor: OWNER });
  return { affiliateId, code, userId };
}

async function completedOrder(userId: string, amount: number, source = 'PURCHASE'): Promise<string> {
  const o = await completeCommercialOrder(db, { organizationId: org, userId, productVersionId: pvId, source, amountMicros: amount, currency: 'USD', idempotencyKey: `ord-${crypto.randomUUID()}` });
  return o.id;
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m11c-${crypto.randomUUID().slice(0, 8)}`, name: 'M11C' }).returning();
  org = o!.id;
  const pv = await publishProfileVersion(db, { organizationId: org, key: KEY, name: 'Aff 25K', accountType: 'EVALUATION', config: cfg($(25_000), 65) });
  pvId = pv.versionId;
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('attribution + commission creation', () => {
  it('LINK attribution creates one commission at 15% of net revenue', async () => {
    const aff = await activeAffiliate();
    const b = await buyer();
    const session = `s-${crypto.randomUUID()}`;
    await recordClick(db, { organizationId: org, code: aff.code, sessionRef: session });
    const orderId = await completedOrder(b, $(65));
    const r = await processConversion(db, { orderId, sessionRef: session });
    expect(r.created).toBe(true);
    expect(r.affiliateId).toBe(aff.affiliateId);
    expect(r.commissionMicros).toBe($(65) * 1500 / 10000); // $9.75
  });

  it('is exactly-once: a repeat call does not double-commission', async () => {
    const aff = await activeAffiliate();
    const b = await buyer();
    const session = `s-${crypto.randomUUID()}`;
    await recordClick(db, { organizationId: org, code: aff.code, sessionRef: session });
    const orderId = await completedOrder(b, $(95));
    const first = await processConversion(db, { orderId, sessionRef: session });
    const second = await processConversion(db, { orderId, sessionRef: session });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const convs = await db.select().from(affiliateConversions).where(eq(affiliateConversions.commercialOrderId, orderId));
    expect(convs.length).toBe(1);
  });

  it('is concurrency-safe: five parallel calls create one commission', async () => {
    const aff = await activeAffiliate();
    const b = await buyer();
    const session = `s-${crypto.randomUUID()}`;
    await recordClick(db, { organizationId: org, code: aff.code, sessionRef: session });
    const orderId = await completedOrder(b, $(170));
    const results = await Promise.all(Array.from({ length: 5 }, () => processConversion(db, { orderId, sessionRef: session })));
    expect(results.filter((r) => r.created).length).toBe(1);
    const comms = await db.select().from(affiliateCommissions).where(eq(affiliateCommissions.commercialOrderId, orderId));
    expect(comms.length).toBe(1);
  });

  it('explicit checkout code overrides an earlier link touch (precedence)', async () => {
    const a = await activeAffiliate();
    const bAff = await activeAffiliate();
    const b = await buyer();
    const session = `s-${crypto.randomUUID()}`;
    await recordClick(db, { organizationId: org, code: a.code, sessionRef: session }); // link touch → A
    const orderId = await completedOrder(b, $(100));
    const r = await processConversion(db, { orderId, sessionRef: session, explicitCode: bAff.code });
    expect(r.affiliateId).toBe(bAff.affiliateId);
    const [conv] = await db.select().from(affiliateConversions).where(eq(affiliateConversions.commercialOrderId, orderId));
    expect(conv!.finalAttributionReason).toBe('CHECKOUT_CODE_OVERRIDE');
    expect(conv!.firstTouchAffiliateId).toBe(a.affiliateId); // first touch preserved for analytics
  });

  it('no attribution → no commission', async () => {
    const b = await buyer();
    const orderId = await completedOrder(b, $(100));
    const r = await processConversion(db, { orderId, sessionRef: `s-${crypto.randomUUID()}` });
    expect(r.created).toBe(false);
    expect(r.reason).toBe('NO_ATTRIBUTION');
  });

  it('self-referral is denied and raises a risk signal', async () => {
    const aff = await activeAffiliate();
    const session = `s-${crypto.randomUUID()}`;
    await recordClick(db, { organizationId: org, code: aff.code, sessionRef: session });
    const orderId = await completedOrder(aff.userId, $(100)); // affiliate buys with own attribution
    const r = await processConversion(db, { orderId, sessionRef: session });
    expect(r.created).toBe(false);
    expect(r.reason).toBe('SELF_REFERRAL_DENIED');
    const signals = await db.select().from(affiliateRiskSignals).where(eq(affiliateRiskSignals.affiliateId, aff.affiliateId));
    expect(signals.some((s) => s.signalType === 'SELF_REFERRAL_ATTEMPT')).toBe(true);
  });

  it('courtesy (non-purchase) orders do not commission by default', async () => {
    const aff = await activeAffiliate();
    const b = await buyer();
    const session = `s-${crypto.randomUUID()}`;
    await recordClick(db, { organizationId: org, code: aff.code, sessionRef: session });
    const orderId = await completedOrder(b, $(100), 'ADMIN_GRANT');
    const r = await processConversion(db, { orderId, sessionRef: session });
    expect(r.created).toBe(false);
    expect(r.reason).toContain('COURTESY');
  });

  it('commission is net after discount', async () => {
    const aff = await activeAffiliate();
    const b = await buyer();
    const session = `s-${crypto.randomUUID()}`;
    await recordClick(db, { organizationId: org, code: aff.code, sessionRef: session });
    const orderId = await completedOrder(b, $(100));
    const r = await processConversion(db, { orderId, sessionRef: session, discountMicros: $(10) });
    expect(r.commissionMicros).toBe($(90) * 1500 / 10000); // $13.50
  });
});

describe('maturity + balances', () => {
  it('a commission matures to PAYABLE and becomes available', async () => {
    const aff = await activeAffiliate();
    const b = await buyer();
    const session = `s-${crypto.randomUUID()}`;
    await recordClick(db, { organizationId: org, code: aff.code, sessionRef: session });
    const orderId = await completedOrder(b, $(65));
    await processConversion(db, { orderId, sessionRef: session });
    let bal = await affiliateBalance(db, aff.affiliateId);
    expect(bal.pendingMicros).toBe($(9.75));
    expect(bal.availableMicros).toBe(0);
    // mature far in the future
    const matured = await matureCommissions(db, org, new Date(Date.now() + 30 * 86_400_000));
    expect(matured).toBeGreaterThanOrEqual(1);
    bal = await affiliateBalance(db, aff.affiliateId);
    expect(bal.availableMicros).toBe($(9.75));
    expect(bal.pendingMicros).toBe(0);
  });
});

describe('refunds + chargebacks + reversals', () => {
  it('refund before maturity cancels the commission (never becomes available)', async () => {
    const aff = await activeAffiliate();
    const b = await buyer();
    const session = `s-${crypto.randomUUID()}`;
    await recordClick(db, { organizationId: org, code: aff.code, sessionRef: session });
    const orderId = await completedOrder(b, $(100));
    await processConversion(db, { orderId, sessionRef: session });
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    await handleRefund(db, { order: order!, reason: 'test refund', actor: OWNER });
    const [comm] = await db.select().from(affiliateCommissions).where(eq(affiliateCommissions.commercialOrderId, orderId));
    expect(comm!.status).toBe('CANCELED');
    const bal = await affiliateBalance(db, aff.affiliateId);
    expect(bal.availableMicros).toBe(0);
    expect(bal.pendingMicros).toBe(0);
  });

  it('refund after maturity reverses the available balance back to zero', async () => {
    const aff = await activeAffiliate();
    const b = await buyer();
    const session = `s-${crypto.randomUUID()}`;
    await recordClick(db, { organizationId: org, code: aff.code, sessionRef: session });
    const orderId = await completedOrder(b, $(100));
    await processConversion(db, { orderId, sessionRef: session });
    await matureCommissions(db, org, new Date(Date.now() + 30 * 86_400_000));
    expect((await affiliateBalance(db, aff.affiliateId)).availableMicros).toBe($(15));
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    await handleRefund(db, { order: order!, reason: 'late refund', actor: OWNER });
    const bal = await affiliateBalance(db, aff.affiliateId);
    expect(bal.availableMicros).toBe(0);
    const [comm] = await db.select().from(affiliateCommissions).where(eq(affiliateCommissions.commercialOrderId, orderId));
    expect(comm!.status).toBe('REVERSED');
  });

  it('chargeback after payout produces a negative balance (paid history preserved)', async () => {
    const aff = await activeAffiliate();
    const b = await buyer();
    const session = `s-${crypto.randomUUID()}`;
    await recordClick(db, { organizationId: org, code: aff.code, sessionRef: session });
    const orderId = await completedOrder(b, $(400)); // 15% = $60
    await processConversion(db, { orderId, sessionRef: session });
    await matureCommissions(db, org, new Date(Date.now() + 30 * 86_400_000));
    // pay out the $60
    const { id: payoutId } = await requestPayout(db, { affiliateId: aff.affiliateId, amountMicros: $(60), actor: OWNER });
    await approvePayout(db, payoutId, OWNER);
    await markPayoutPaid(db, payoutId, { externalReference: 'WIRE-123', method: 'WIRE', actor: OWNER });
    expect((await affiliateBalance(db, aff.affiliateId)).availableMicros).toBe(0);
    expect((await affiliateBalance(db, aff.affiliateId)).lifetimePaidMicros).toBe($(60));
    // now a chargeback reverses the $60 → balance goes negative
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
    await handleDispute(db, { order: order!, opened: true, reason: 'chargeback', actor: OWNER });
    const bal = await affiliateBalance(db, aff.affiliateId);
    expect(bal.availableMicros).toBe(-$(60));
    expect(bal.lifetimePaidMicros).toBe($(60)); // paid history preserved
  });
});

describe('payouts', () => {
  it('rejects below-minimum and over-balance, and prevents double-withdraw under a race', async () => {
    const aff = await activeAffiliate();
    const b = await buyer();
    const session = `s-${crypto.randomUUID()}`;
    await recordClick(db, { organizationId: org, code: aff.code, sessionRef: session });
    const orderId = await completedOrder(b, $(1000)); // 15% = $150 available after maturity
    await processConversion(db, { orderId, sessionRef: session });
    await matureCommissions(db, org, new Date(Date.now() + 30 * 86_400_000));
    expect((await affiliateBalance(db, aff.affiliateId)).availableMicros).toBe($(150));
    await expect(requestPayout(db, { affiliateId: aff.affiliateId, amountMicros: $(10), actor: OWNER })).rejects.toThrow(); // below $50 min
    await expect(requestPayout(db, { affiliateId: aff.affiliateId, amountMicros: $(500), actor: OWNER })).rejects.toThrow(); // over balance
    // two concurrent requests for the full $150 → only one can succeed
    const results = await Promise.allSettled([
      requestPayout(db, { affiliateId: aff.affiliateId, amountMicros: $(150), actor: OWNER }),
      requestPayout(db, { affiliateId: aff.affiliateId, amountMicros: $(150), actor: OWNER }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
  });

  it('a negative manual adjustment reduces available and can go negative', async () => {
    const aff = await activeAffiliate();
    await manualAdjustment(db, { organizationId: org, affiliateId: aff.affiliateId, amountMicros: -$(25), reasonCode: 'FEE_CORRECTION', explanation: 'test negative adjustment', actor: OWNER });
    expect((await affiliateBalance(db, aff.affiliateId)).availableMicros).toBe(-$(25));
  });
});
