/**
 * M11-F/G — payouts (provider-neutral + truthful), balances under in-flight, the
 * PAID money move with required evidence, privacy masking of referred customers,
 * and the append-only guards on the ledger + agreement acceptances.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { affiliateAgreementAcceptances, affiliateLedger, organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { publishProfileVersion } from './profiles.js';
import { completeCommercialOrder } from './commerce.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import type { Actor } from './actor.js';
import { submitApplication, reviewApplication, acceptAffiliateAgreement, maskName } from './affiliates.js';
import { recordClick } from './affiliate-attribution.js';
import { processConversion, matureCommissions, affiliateBalance, manualAdjustment } from './affiliate-commissions.js';
import {
  affiliatePayoutProviderStatus, inFlightPayoutTotal, requestPayout,
  approvePayout, cancelPayout, failPayout, markPayoutPaid, listPayouts,
} from './affiliate-payouts.js';
import { listConversionsForAffiliate, affiliateDashboard } from './affiliate-analytics.js';

const M = 1_000_000; const $ = (d: number) => d * M;
const OWNER: Actor = { type: 'ADMIN', label: 'owner@test', userId: null };
let db: Database; let handleSql: { end: (o?: unknown) => Promise<void> }; let org: string; let pvId: string; let seq = 0;
const FUTURE = () => new Date(Date.now() + 60 * 86_400_000);

function cfg(size: number, price: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: $(1500), maxLossMicros: $(1000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: size, priceMicros: $(price) }, payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } }, fundedDestinationKey: null, whopPlanId: null };
}
async function buyer(): Promise<string> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `pb-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('pb-pw-12345678'), displayName: `Firstname Lastname${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
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
/** Give an affiliate `amount` of matured, withdrawable balance. */
async function fund(affiliateId: string, code: string, revenue: number): Promise<void> {
  const b = await buyer();
  const s = `s-${crypto.randomUUID()}`;
  await recordClick(db, { organizationId: org, code, sessionRef: s });
  const o = await completeCommercialOrder(db, { organizationId: org, userId: b, productVersionId: pvId, source: 'PURCHASE', amountMicros: revenue, currency: 'USD', idempotencyKey: `ord-${crypto.randomUUID()}` });
  await processConversion(db, { orderId: o.id, sessionRef: s });
  await matureCommissions(db, org, FUTURE());
  void affiliateId;
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m11pay-${crypto.randomUUID().slice(0, 8)}`, name: 'M11PAY' }).returning();
  org = o!.id;
  const pv = await publishProfileVersion(db, { organizationId: org, key: 'm11-pay-pv', name: 'Pay PV', accountType: 'EVALUATION', config: cfg($(25_000), 65) });
  pvId = pv.versionId;
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('provider status is truthful', () => {
  it('reports NOT configured and NOT verified when no provider is set, with an honest note', () => {
    const s = affiliatePayoutProviderStatus();
    expect(s.configured).toBe(false);
    expect(s.verified).toBe(false);
    expect(typeof s.note).toBe('string');
    expect(s.note.length).toBeGreaterThan(0);
  });
  it('never claims a payout was sent from configuration alone', () => {
    const s = affiliatePayoutProviderStatus();
    expect(s.status).not.toBe('PAID');
    expect(s.verified).toBe(false);
  });
});

describe('payout requests + balances', () => {
  it('rejects a request below the configured minimum', async () => {
    const a = await activeAffiliate();
    await fund(a.affiliateId, a.code, $(1000)); // $150 available
    await expect(requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(10), actor: OWNER })).rejects.toThrow();
  });
  it('rejects a request above the withdrawable balance', async () => {
    const a = await activeAffiliate();
    await fund(a.affiliateId, a.code, $(1000)); // $150 available
    await expect(requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(500), actor: OWNER })).rejects.toThrow();
  });
  it('a valid request moves funds in-flight and reduces withdrawable (not available)', async () => {
    const a = await activeAffiliate();
    await fund(a.affiliateId, a.code, $(1000)); // $150
    await requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(100), actor: OWNER });
    const bal = await affiliateBalance(db, a.affiliateId);
    expect(bal.availableMicros).toBe($(150));       // not paid yet
    expect(bal.inFlightPayoutMicros).toBe($(100));
    expect(bal.withdrawableMicros).toBe($(50));
    expect((await inFlightPayoutTotal(db, a.affiliateId)).inFlightPayoutMicros).toBe($(100));
  });
  it('cancelling a request restores withdrawable', async () => {
    const a = await activeAffiliate();
    await fund(a.affiliateId, a.code, $(1000));
    const { id } = await requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(100), actor: OWNER });
    await cancelPayout(db, id, OWNER, 'changed mind');
    const bal = await affiliateBalance(db, a.affiliateId);
    expect(bal.inFlightPayoutMicros).toBe(0);
    expect(bal.withdrawableMicros).toBe($(150));
  });
  it('a second request cannot exceed the remaining withdrawable', async () => {
    const a = await activeAffiliate();
    await fund(a.affiliateId, a.code, $(1000)); // $150
    await requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(100), actor: OWNER });
    await expect(requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(100), actor: OWNER })).rejects.toThrow();
  });
  it('two concurrent full-balance requests: exactly one succeeds', async () => {
    const a = await activeAffiliate();
    await fund(a.affiliateId, a.code, $(1000)); // $150
    const rs = await Promise.allSettled([
      requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(150), actor: OWNER }),
      requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(150), actor: OWNER }),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled').length).toBe(1);
  });
});

describe('payout lifecycle + the PAID money move', () => {
  it('markPaid requires an external reference and method', async () => {
    const a = await activeAffiliate();
    await fund(a.affiliateId, a.code, $(1000));
    const { id } = await requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(100), actor: OWNER });
    await approvePayout(db, id, OWNER);
    // @ts-expect-error — deliberately missing evidence
    await expect(markPayoutPaid(db, id, { actor: OWNER })).rejects.toThrow();
  });
  it('marking PAID debits the ledger; available drops and lifetimePaid rises', async () => {
    const a = await activeAffiliate();
    await fund(a.affiliateId, a.code, $(1000)); // $150
    const { id } = await requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(120), actor: OWNER });
    await approvePayout(db, id, OWNER);
    await markPayoutPaid(db, id, { externalReference: 'WIRE-9', method: 'WIRE', evidenceRef: 'receipt.pdf', actor: OWNER });
    const bal = await affiliateBalance(db, a.affiliateId);
    expect(bal.availableMicros).toBe($(30));
    expect(bal.lifetimePaidMicros).toBe($(120));
    expect(bal.inFlightPayoutMicros).toBe(0);
  });
  it('a failed payout returns the funds to withdrawable', async () => {
    const a = await activeAffiliate();
    await fund(a.affiliateId, a.code, $(1000));
    const { id } = await requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(100), actor: OWNER });
    await approvePayout(db, id, OWNER);
    await failPayout(db, id, OWNER, 'provider rejected');
    expect((await affiliateBalance(db, a.affiliateId)).withdrawableMicros).toBe($(150));
  });
  it('listPayouts returns the affiliate rows', async () => {
    const a = await activeAffiliate();
    await fund(a.affiliateId, a.code, $(1000));
    await requestPayout(db, { affiliateId: a.affiliateId, amountMicros: $(100), actor: OWNER });
    const rows = await listPayouts(db, a.affiliateId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('privacy: referred customers are masked', () => {
  it('maskName masks all but the first letter of each part', () => {
    expect(maskName('Nathan Desjardins')).toMatch(/^N\*+ D\*+$/);
    expect(maskName('')).toBe('Customer');
  });
  it('the conversion list never exposes the customer email or full name', async () => {
    const a = await activeAffiliate();
    await fund(a.affiliateId, a.code, $(300));
    const rows = await listConversionsForAffiliate(db, a.affiliateId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      // the customer's real name/email are never included (customerName is nulled out)
      expect((r as Record<string, unknown>)['customerName']).toBeUndefined();
      expect((r as Record<string, unknown>)['customerEmail']).toBeUndefined();
      expect(r.customer).toMatch(/\*/); // masked
    }
  });
  it('the affiliate dashboard exposes no customer PII', async () => {
    const a = await activeAffiliate();
    await fund(a.affiliateId, a.code, $(300));
    const d = await affiliateDashboard(db, a.affiliateId);
    const json = JSON.stringify(d);
    expect(json).not.toContain('@atlas.test');
  });
});

describe('append-only guards', () => {
  it('the affiliate ledger cannot be UPDATEd', async () => {
    const a = await activeAffiliate();
    await manualAdjustment(db, { organizationId: org, affiliateId: a.affiliateId, amountMicros: $(5), reasonCode: 'X', explanation: 'seed a ledger row', actor: OWNER });
    await expect(db.execute(sql`update affiliate_ledger set amount_micros = 0 where affiliate_id = ${a.affiliateId}`)).rejects.toThrow();
  });
  it('the affiliate ledger cannot be DELETEd', async () => {
    const a = await activeAffiliate();
    await manualAdjustment(db, { organizationId: org, affiliateId: a.affiliateId, amountMicros: $(5), reasonCode: 'X', explanation: 'seed a ledger row', actor: OWNER });
    await expect(db.execute(sql`delete from affiliate_ledger where affiliate_id = ${a.affiliateId}`)).rejects.toThrow();
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(affiliateLedger).where(eq(affiliateLedger.affiliateId, a.affiliateId));
    expect(Number(row!.n)).toBeGreaterThanOrEqual(1);
  });
  it('agreement acceptances cannot be UPDATEd', async () => {
    const a = await activeAffiliate();
    const [acc] = await db.select().from(affiliateAgreementAcceptances).where(eq(affiliateAgreementAcceptances.affiliateId, a.affiliateId));
    expect(acc).toBeTruthy();
    await expect(db.execute(sql`update affiliate_agreement_acceptances set ip = '0.0.0.0' where id = ${acc!.id}`)).rejects.toThrow();
  });
});
