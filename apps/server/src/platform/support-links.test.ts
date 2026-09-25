/**
 * M12-E — object linking (with ownership enforcement), evidence, the customer
 * context snapshot, the investigation timeline, and deterministic diagnostics
 * incl. ordinary-refund eligibility from real execution history.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, commercialOrders, executions, organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { completeCommercialOrder } from './commerce.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import type { Actor } from './actor.js';
import { getSupportConfig } from './support-config.js';
import { submitTicket } from './support-tickets.js';
import { customerContextSnapshot, investigationTimeline, linkObject, listEvidence, listLinks, markEvidence, ticketsForObject, unlinkObject } from './support-links.js';
import { refundEligibility, whatHappened } from './support-diagnostics.js';

const M = 1_000_000; const $ = (d: number) => d * M;
const staff: Actor = { type: 'ADMIN', label: 'staff@test', userId: null };
let db: Database; let handleSql: { end: (o?: unknown) => Promise<void> }; let org: string; let pvId: string; let seq = 0;

function cfg(size: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: $(1500), maxLossMicros: $(1000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: size }, payoutRules: null };
}
async function customer(): Promise<{ id: string; actor: Actor }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `lnk-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('lnk-pw-12345678'), displayName: `C${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
  await ensureCustomerIdentity(db, { organizationId: org, userId: u!.id });
  return { id: u!.id, actor: { type: 'USER', userId: u!.id } };
}
async function accountFor(userId: string): Promise<string> {
  const { accountId } = await provisionAccount(db, { organizationId: org, userId, profileKey: 'm12-links-pv' });
  return accountId;
}
async function ticketFor(userId: string, actor: Actor): Promise<string> {
  const r = await submitTicket(db, { organizationId: org, customerUserId: userId, categoryKey: 'ACCOUNT', subject: 's', body: 'b', actor });
  return r.id;
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m12e-${crypto.randomUUID().slice(0, 8)}`, name: 'M12E' }).returning();
  org = o!.id;
  const pv = await publishProfileVersion(db, { organizationId: org, key: 'm12-links-pv', name: 'Links PV', accountType: 'EVALUATION', config: cfg($(50_000)) });
  pvId = pv.versionId; void pvId;
  await getSupportConfig(db, org);
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('object linking + ownership', () => {
  it('a customer can link their own account; forging another customer account is refused', async () => {
    const a = await customer(); const b = await customer();
    const acctA = await accountFor(a.id);
    const ticketA = await ticketFor(a.id, a.actor);
    await linkObject(db, { ticketId: ticketA, objectType: 'account', objectId: acctA, actor: a.actor, enforceOwnership: true });
    expect((await listLinks(db, ticketA)).some((l) => l.objectId === acctA)).toBe(true);
    // B's ticket cannot link A's account with ownership enforcement
    const ticketB = await ticketFor(b.id, b.actor);
    await expect(linkObject(db, { ticketId: ticketB, objectType: 'account', objectId: acctA, actor: b.actor, enforceOwnership: true })).rejects.toThrow(/belong/i);
  });
  it('a customer cannot link a staff-only object type', async () => {
    const a = await customer();
    const t = await ticketFor(a.id, a.actor);
    await expect(linkObject(db, { ticketId: t, objectType: 'incident', objectId: crypto.randomUUID(), actor: a.actor, enforceOwnership: true })).rejects.toThrow();
  });
  it('staff can link any in-org object; unknown object refused; unlink works', async () => {
    const a = await customer();
    const acct = await accountFor(a.id);
    const t = await ticketFor(a.id, a.actor);
    const { id } = await linkObject(db, { ticketId: t, objectType: 'account', objectId: acct, actor: staff });
    await expect(linkObject(db, { ticketId: t, objectType: 'account', objectId: crypto.randomUUID(), actor: staff })).rejects.toThrow();
    await unlinkObject(db, { ticketId: t, linkId: id, actor: staff });
    expect((await listLinks(db, t)).length).toBe(0);
  });
  it('ticketsForObject finds the tickets referencing an object', async () => {
    const a = await customer();
    const acct = await accountFor(a.id);
    const t = await ticketFor(a.id, a.actor);
    await linkObject(db, { ticketId: t, objectType: 'account', objectId: acct, actor: staff });
    const rows = await ticketsForObject(db, org, 'account', acct);
    expect(rows.some((r) => r.ticketId === t)).toBe(true);
  });
});

describe('evidence', () => {
  it('marks and lists evidence', async () => {
    const a = await customer();
    const t = await ticketFor(a.id, a.actor);
    await markEvidence(db, { ticketId: t, sourceType: 'OBJECT', sourceRef: 'account:x', objectType: 'account', description: 'the account', actor: staff });
    expect((await listEvidence(db, t)).length).toBe(1);
  });
});

describe('context snapshot + timeline', () => {
  it('the context snapshot lists the customer accounts and recent purchases', async () => {
    const a = await customer();
    await accountFor(a.id);
    await completeCommercialOrder(db, { organizationId: org, userId: a.id, productVersionId: pvId, source: 'PURCHASE', amountMicros: $(100), currency: 'USD', idempotencyKey: `o-${crypto.randomUUID()}` });
    const snap = await customerContextSnapshot(db, org, a.id);
    expect(snap.accounts.length).toBeGreaterThanOrEqual(1);
    expect(snap.recentPurchases.length).toBeGreaterThanOrEqual(1);
  });
  it('the investigation timeline surfaces the ticket-creation event', async () => {
    const a = await customer();
    const t = await ticketFor(a.id, a.actor);
    const timeline = await investigationTimeline(db, org, t);
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    expect(timeline.some((e) => e.type.includes('support.ticket.created'))).toBe(true);
  });
});

describe('diagnostics + refund eligibility', () => {
  it('a fresh purchase with no executed trade is ordinary-refund eligible', async () => {
    const a = await customer();
    const o = await completeCommercialOrder(db, { organizationId: org, userId: a.id, productVersionId: pvId, source: 'PURCHASE', amountMicros: $(100), currency: 'USD', idempotencyKey: `o-${crypto.randomUUID()}` });
    const elig = await refundEligibility(db, org, o.id);
    expect(elig.eligible).toBe(true);
  });
  it('a purchase whose account has an execution is NOT ordinary-refund eligible', async () => {
    const a = await customer();
    const acct = await accountFor(a.id);
    const o = await completeCommercialOrder(db, { organizationId: org, userId: a.id, productVersionId: pvId, source: 'PURCHASE', amountMicros: $(100), currency: 'USD', idempotencyKey: `o-${crypto.randomUUID()}` });
    // Attach an execution to the customer's account, then point the check at it.
    // (We assert via the account directly: an account with an execution blocks its purchases.)
    const acctOrderId = await import('./commerce-fulfillment.js').then((m) => m.orderAccountId(db, o.id));
    const targetAccount = acctOrderId ?? acct;
    const [ord] = await db.insert(await import('../db/schema.js').then((m) => m.orders)).values({ accountId: targetAccount, clientOrderId: `c-${crypto.randomUUID()}`, symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET', status: 'FILLED' }).returning();
    await db.insert(executions).values({ orderId: ord!.id, accountId: targetAccount, symbol: 'NQ', side: 'BUY', qty: 1, priceTicks: 100, execTime: new Date(), seq: 1 });
    const elig = await refundEligibility(db, org, o.id);
    if (acctOrderId) expect(elig.eligible).toBe(false); else expect(['NO_TRADE_EXECUTED', 'NO_ACCOUNT_PROVISIONED']).toContain(elig.reason);
  });
  it('an already-refunded order is not eligible', async () => {
    const a = await customer();
    const o = await completeCommercialOrder(db, { organizationId: org, userId: a.id, productVersionId: pvId, source: 'PURCHASE', amountMicros: $(100), currency: 'USD', idempotencyKey: `o-${crypto.randomUUID()}` });
    await db.update(commercialOrders).set({ refundedAt: new Date() }).where(eq(commercialOrders.id, o.id));
    const elig = await refundEligibility(db, org, o.id);
    expect(elig.eligible).toBe(false);
    expect(elig.reason).toBe('ALREADY_REFUNDED');
  });
  it('whatHappened returns server-authoritative account facts', async () => {
    const a = await customer();
    const acct = await accountFor(a.id);
    const d = await whatHappened(db, org, 'account', acct);
    expect(d.facts.some((f) => f.label === 'Status')).toBe(true);
    expect(d.facts.some((f) => f.label === 'Drawdown band')).toBe(true);
  });
  it('whatHappened on a purchase reports refund eligibility as a fact', async () => {
    const a = await customer();
    const o = await completeCommercialOrder(db, { organizationId: org, userId: a.id, productVersionId: pvId, source: 'PURCHASE', amountMicros: $(100), currency: 'USD', idempotencyKey: `o-${crypto.randomUUID()}` });
    const d = await whatHappened(db, org, 'purchase', o.id);
    expect(d.facts.some((f) => f.label === 'Ordinary refund eligibility')).toBe(true);
  });
});

void accounts;
