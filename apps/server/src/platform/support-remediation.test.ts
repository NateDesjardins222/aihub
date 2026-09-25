/**
 * M12-G — remediation: request → four-eyes approve → canonical execute, with
 * idempotency (no double adjustment/refund) and truthful FAILED on ineligible
 * refunds. Support never mutates money directly — execution calls the real engines.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { commercialOrders, executions, orders, organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { completeCommercialOrder } from './commerce.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { orderAccountId } from './commerce-fulfillment.js';
import { listAdjustments } from './account-ops.js';
import type { Actor } from './actor.js';
import { getSupportConfig } from './support-config.js';
import { submitTicket } from './support-tickets.js';
import { approveRemediation, denyRemediation, executeRemediation, getRemediation, requestRemediation } from './support-remediation.js';

const M = 1_000_000; const $ = (d: number) => d * M;
let db: Database; let handleSql: { end: (o?: unknown) => Promise<void> }; let org: string; let pvId: string; let seq = 0;
let requester: Actor; let approver: Actor;

function cfg(size: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: $(1500), maxLossMicros: $(1000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: size }, payoutRules: null };
}
async function staffUser(): Promise<Actor> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `rstaff-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('r-pw-12345678'), displayName: `Staff ${seq}`, role: 'ADMIN', isAdmin: true, organizationId: org }).returning({ id: users.id });
  return { type: 'ADMIN', userId: u!.id, label: `staff-${seq}` };
}
async function customer(): Promise<{ id: string; actor: Actor }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `rcust-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('r-pw-12345678'), displayName: `C${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
  await ensureCustomerIdentity(db, { organizationId: org, userId: u!.id });
  return { id: u!.id, actor: { type: 'USER', userId: u!.id } };
}
async function ticketFor(userId: string, actor: Actor): Promise<string> {
  const r = await submitTicket(db, { organizationId: org, customerUserId: userId, categoryKey: 'ACCOUNT', subject: 's', body: 'b', actor });
  return r.id;
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m12g-${crypto.randomUUID().slice(0, 8)}`, name: 'M12G' }).returning();
  org = o!.id;
  const pv = await publishProfileVersion(db, { organizationId: org, key: 'm12-rem-pv', name: 'Rem PV', accountType: 'EVALUATION', config: cfg($(50_000)) });
  pvId = pv.versionId;
  await getSupportConfig(db, org);
  requester = await staffUser(); approver = await staffUser();
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('request + approval (four-eyes)', () => {
  it('requires a reason and a staff identity', async () => {
    const c = await customer(); const t = await ticketFor(c.id, c.actor);
    await expect(requestRemediation(db, { ticketId: t, type: 'OTHER', reason: '  ', actor: requester })).rejects.toThrow();
    await expect(requestRemediation(db, { ticketId: t, type: 'OTHER', reason: 'x', actor: { type: 'ADMIN', userId: null } })).rejects.toThrow();
  });
  it('the requester cannot approve their own remediation (four-eyes)', async () => {
    const c = await customer(); const t = await ticketFor(c.id, c.actor);
    const r = await requestRemediation(db, { ticketId: t, type: 'OTHER', reason: 'please', actor: requester });
    await expect(approveRemediation(db, { remediationId: r.id, actor: requester })).rejects.toThrow(/four-eyes|other than/i);
    const ok = await approveRemediation(db, { remediationId: r.id, actor: approver });
    expect(ok.status).toBe('APPROVED');
  });
  it('approval is idempotent', async () => {
    const c = await customer(); const t = await ticketFor(c.id, c.actor);
    const r = await requestRemediation(db, { ticketId: t, type: 'OTHER', reason: 'please', actor: requester });
    await approveRemediation(db, { remediationId: r.id, actor: approver });
    const again = await approveRemediation(db, { remediationId: r.id, actor: approver });
    expect(again.status).toBe('APPROVED');
  });
  it('deny records the reason and blocks execution', async () => {
    const c = await customer(); const t = await ticketFor(c.id, c.actor);
    const r = await requestRemediation(db, { ticketId: t, type: 'OTHER', reason: 'please', actor: requester });
    await denyRemediation(db, { remediationId: r.id, reason: 'not warranted', actor: approver });
    expect((await getRemediation(db, r.id))!.status).toBe('DENIED');
    await expect(executeRemediation(db, { remediationId: r.id, actor: approver })).rejects.toThrow();
  });
  it('a request with an idempotency key is deduped', async () => {
    const c = await customer(); const t = await ticketFor(c.id, c.actor);
    const key = `idem-${crypto.randomUUID()}`;
    const a = await requestRemediation(db, { ticketId: t, type: 'OTHER', reason: 'please', idempotencyKey: key, actor: requester });
    const b = await requestRemediation(db, { ticketId: t, type: 'OTHER', reason: 'please', idempotencyKey: key, actor: requester });
    expect(b.id).toBe(a.id);
  });
});

describe('execution through canonical services', () => {
  it('ACCOUNT_ADJUSTMENT applies a real admin adjustment exactly once', async () => {
    const c = await customer();
    const { accountId } = await provisionAccount(db, { organizationId: org, userId: c.id, profileKey: 'm12-rem-pv' });
    const t = await ticketFor(c.id, c.actor);
    const r = await requestRemediation(db, { ticketId: t, type: 'ACCOUNT_ADJUSTMENT', reason: 'goodwill credit', amountMicros: $(100), detail: { accountId, direction: 'CREDIT', reasonCode: 'GOODWILL' }, actor: requester });
    await approveRemediation(db, { remediationId: r.id, actor: approver });
    const res = await executeRemediation(db, { remediationId: r.id, actor: approver });
    expect(res.status).toBe('EXECUTED');
    // idempotent: executing again does not double-apply
    await executeRemediation(db, { remediationId: r.id, actor: approver });
    const adjustments = await listAdjustments(db, accountId);
    expect(adjustments.length).toBe(1);
  });
  it('concurrent execution applies exactly once', async () => {
    const c = await customer();
    const { accountId } = await provisionAccount(db, { organizationId: org, userId: c.id, profileKey: 'm12-rem-pv' });
    const t = await ticketFor(c.id, c.actor);
    const r = await requestRemediation(db, { ticketId: t, type: 'ACCOUNT_ADJUSTMENT', reason: 'goodwill', amountMicros: $(50), detail: { accountId, direction: 'CREDIT', reasonCode: 'GOODWILL' }, actor: requester });
    await approveRemediation(db, { remediationId: r.id, actor: approver });
    await Promise.allSettled([
      executeRemediation(db, { remediationId: r.id, actor: approver }),
      executeRemediation(db, { remediationId: r.id, actor: approver }),
      executeRemediation(db, { remediationId: r.id, actor: approver }),
    ]);
    expect((await listAdjustments(db, accountId)).length).toBe(1);
  });
  it('an ordinary REFUND executes when eligible and marks the order refunded', async () => {
    const c = await customer();
    const o = await completeCommercialOrder(db, { organizationId: org, userId: c.id, productVersionId: pvId, source: 'PURCHASE', amountMicros: $(100), currency: 'USD', idempotencyKey: `o-${crypto.randomUUID()}` });
    const t = await ticketFor(c.id, c.actor);
    const r = await requestRemediation(db, { ticketId: t, type: 'REFUND', reason: 'changed mind, no trades', detail: { orderId: o.id }, actor: requester });
    await approveRemediation(db, { remediationId: r.id, actor: approver });
    const res = await executeRemediation(db, { remediationId: r.id, actor: approver });
    expect(res.status).toBe('EXECUTED');
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, o.id));
    expect(order!.refundedAt).toBeTruthy();
  });
  it('an ordinary REFUND FAILS truthfully when a trade has executed', async () => {
    const c = await customer();
    const o = await completeCommercialOrder(db, { organizationId: org, userId: c.id, productVersionId: pvId, source: 'PURCHASE', amountMicros: $(100), currency: 'USD', idempotencyKey: `o-${crypto.randomUUID()}` });
    const accountId = await orderAccountId(db, o.id);
    if (accountId) {
      const [ord] = await db.insert(orders).values({ accountId, clientOrderId: `c-${crypto.randomUUID()}`, symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET', status: 'FILLED' }).returning();
      await db.insert(executions).values({ orderId: ord!.id, accountId, symbol: 'NQ', side: 'BUY', qty: 1, priceTicks: 100, execTime: new Date(), seq: 1 });
    }
    const t = await ticketFor(c.id, c.actor);
    const r = await requestRemediation(db, { ticketId: t, type: 'REFUND', reason: 'wants refund', detail: { orderId: o.id }, actor: requester });
    await approveRemediation(db, { remediationId: r.id, actor: approver });
    const res = await executeRemediation(db, { remediationId: r.id, actor: approver });
    if (accountId) {
      expect(res.status).toBe('FAILED');
      expect(res.failureReason).toMatch(/not eligible|TRADE_EXECUTED/i);
    }
  });
  it('a controlled type with no safe auto-executor records MANUAL_ACTION_REQUIRED', async () => {
    const c = await customer(); const t = await ticketFor(c.id, c.actor);
    const r = await requestRemediation(db, { ticketId: t, type: 'TRADING_REMEDIATION', reason: 'investigate', actor: requester });
    await approveRemediation(db, { remediationId: r.id, actor: approver });
    const res = await executeRemediation(db, { remediationId: r.id, actor: approver });
    expect(res.status).toBe('EXECUTED');
    expect(res.executionRef).toBe('MANUAL_ACTION_REQUIRED');
  });
  it('execution requires APPROVED', async () => {
    const c = await customer(); const t = await ticketFor(c.id, c.actor);
    const r = await requestRemediation(db, { ticketId: t, type: 'OTHER', reason: 'x', actor: requester });
    await expect(executeRemediation(db, { remediationId: r.id, actor: approver })).rejects.toThrow(/Cannot execute|NOT_APPROVED/i);
  });
});
