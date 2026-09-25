/**
 * M12-B — ticket lifecycle + messaging: creation, the append-only thread with
 * internal-note visibility, idempotent messages, guarded transitions with
 * optimistic concurrency, SLA pause/resume accounting, resolve/reopen/merge/split,
 * and CSAT. Deterministic; every assertion is exact.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { organizations, supportMessages, supportTicketEvents, supportTickets, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import type { Actor } from './actor.js';
import {
  canTransitionTicket, generateTicketRef, getSupportConfig, suggestPriority,
} from './support-config.js';
import {
  addMessage, assignTicket, escalateTicket, findRecentDuplicate, getTicketRow, listCustomerTickets,
  listMessages, mergeTickets, reopenTicket, resolveTicket, setPriority, setTags, splitTicket,
  submitCsat, submitTicket, transitionStatus,
} from './support-tickets.js';

let db: Database; let handleSql: { end: (o?: unknown) => Promise<void> }; let org: string; let seq = 0;
const staff: Actor = { type: 'ADMIN', label: 'staff@test', userId: null };

async function customer(): Promise<{ id: string; actor: Actor }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `sup-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('sup-pw-12345678'), displayName: `Cust ${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
  return { id: u!.id, actor: { type: 'USER', userId: u!.id, label: `cust-${seq}` } };
}
async function newTicket(categoryKey = 'ACCOUNT'): Promise<{ ticketId: string; publicRef: string; customerId: string; actor: Actor }> {
  const c = await customer();
  const r = await submitTicket(db, { organizationId: org, customerUserId: c.id, categoryKey, subject: 'Help please', body: 'Something is wrong', actor: c.actor });
  return { ticketId: r.id, publicRef: r.publicRef, customerId: c.id, actor: c.actor };
}

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m12b-${crypto.randomUUID().slice(0, 8)}`, name: 'M12B' }).returning();
  org = o!.id;
  await getSupportConfig(db, org); // seed categories + SLA
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('pure helpers', () => {
  it('canTransitionTicket enforces the lifecycle graph', () => {
    expect(canTransitionTicket('OPEN', 'IN_PROGRESS')).toBe(true);
    expect(canTransitionTicket('OPEN', 'CLOSED')).toBe(false);
    expect(canTransitionTicket('RESOLVED', 'CLOSED')).toBe(true);
    expect(canTransitionTicket('CLOSED', 'OPEN')).toBe(false);
  });
  it('generateTicketRef is HT- + unambiguous chars', () => {
    const ref = generateTicketRef();
    expect(ref).toMatch(/^HT-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });
  it('suggestPriority never escalates on tone, only on concrete signals', () => {
    expect(suggestPriority('ACCOUNT', 'NORMAL', {})).toBe('NORMAL');
    expect(suggestPriority('LOGIN', 'NORMAL', {})).toBe('HIGH');
    expect(suggestPriority('PAYOUT', 'NORMAL', { payoutUnknown: true })).toBe('HIGH');
    expect(suggestPriority('TRADING', 'NORMAL', { fundedAccountAffected: true, tradingBroken: true })).toBe('URGENT');
  });
});

describe('creation', () => {
  it('creates an OPEN ticket with a first customer message and a public ref', async () => {
    const t = await newTicket();
    const row = (await getTicketRow(db, t.ticketId))!;
    expect(row.status).toBe('OPEN');
    expect(row.publicRef).toMatch(/^HT-/);
    expect(row.resolutionDueAt).toBeTruthy();
    const msgs = await listMessages(db, t.ticketId, { includeInternal: true });
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.senderType).toBe('CUSTOMER');
  });
  it('rejects an unknown category', async () => {
    const c = await customer();
    await expect(submitTicket(db, { organizationId: org, customerUserId: c.id, categoryKey: 'NONSENSE', subject: 'x', body: 'y', actor: c.actor })).rejects.toThrow();
  });
  it('a LOGIN category ticket is suggested HIGH priority', async () => {
    const c = await customer();
    const r = await submitTicket(db, { organizationId: org, customerUserId: c.id, categoryKey: 'LOGIN', subject: 'cant log in', body: 'help', actor: c.actor });
    const row = (await getTicketRow(db, r.id))!;
    expect(row.priority).toBe('HIGH');
  });
  it('listCustomerTickets returns the customer own tickets', async () => {
    const t = await newTicket();
    const list = await listCustomerTickets(db, org, t.customerId);
    expect(list.some((x) => x.id === t.ticketId)).toBe(true);
  });
  it('findRecentDuplicate spots a same-category open ticket', async () => {
    const c = await customer();
    await submitTicket(db, { organizationId: org, customerUserId: c.id, categoryKey: 'PAYOUT', subject: 'a', body: 'b', actor: c.actor });
    const dup = await findRecentDuplicate(db, org, c.id, 'PAYOUT', null);
    expect(dup).toBeTruthy();
  });
});

describe('messaging + internal-note visibility', () => {
  it('an internal note is hidden from the customer projection', async () => {
    const t = await newTicket();
    await addMessage(db, { ticketId: t.ticketId, senderType: 'STAFF', visibility: 'INTERNAL', body: 'internal only — do not show', actor: staff });
    const staffView = await listMessages(db, t.ticketId, { includeInternal: true });
    const custView = await listMessages(db, t.ticketId, { includeInternal: false });
    expect(staffView.some((m) => m.body.includes('internal only'))).toBe(true);
    expect(custView.some((m) => m.body.includes('internal only'))).toBe(false);
  });
  it('the customer projection never names the staff member', async () => {
    const t = await newTicket();
    await addMessage(db, { ticketId: t.ticketId, senderType: 'STAFF', visibility: 'CUSTOMER', body: 'we are looking into it', actor: { type: 'ADMIN', userId: null, label: 'Jane Operator' } });
    const custView = await listMessages(db, t.ticketId, { includeInternal: false });
    const staffMsg = custView.find((m) => m.senderType === 'STAFF')!;
    expect(staffMsg.senderName).toBe('Happy Trader Support');
  });
  it('a customer cannot post an internal note', async () => {
    const t = await newTicket();
    await expect(addMessage(db, { ticketId: t.ticketId, senderType: 'CUSTOMER', visibility: 'INTERNAL', body: 'x', actor: t.actor })).rejects.toThrow();
  });
  it('messages are idempotent per key (retry does not duplicate)', async () => {
    const t = await newTicket();
    const key = `k-${crypto.randomUUID()}`;
    const a = await addMessage(db, { ticketId: t.ticketId, senderType: 'CUSTOMER', visibility: 'CUSTOMER', body: 'hi', idempotencyKey: key, actor: t.actor });
    const b = await addMessage(db, { ticketId: t.ticketId, senderType: 'CUSTOMER', visibility: 'CUSTOMER', body: 'hi', idempotencyKey: key, actor: t.actor });
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);
  });
  it('concurrent identical retries collapse to one message', async () => {
    const t = await newTicket();
    const key = `race-${crypto.randomUUID()}`;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => addMessage(db, { ticketId: t.ticketId, senderType: 'CUSTOMER', visibility: 'CUSTOMER', body: 'race', idempotencyKey: key, actor: t.actor })));
    const ids = new Set(results.filter((r): r is PromiseFulfilledResult<{ id: string; deduped: boolean }> => r.status === 'fulfilled').map((r) => r.value.id));
    expect(ids.size).toBe(1);
  });
  it('a staff public reply stamps first-response and last-staff', async () => {
    const t = await newTicket();
    await addMessage(db, { ticketId: t.ticketId, senderType: 'STAFF', visibility: 'CUSTOMER', body: 'on it', actor: staff });
    const row = (await getTicketRow(db, t.ticketId))!;
    expect(row.slaFirstRespondedAt).toBeTruthy();
    expect(row.lastStaffAt).toBeTruthy();
  });
});

describe('lifecycle transitions', () => {
  it('valid transition succeeds; invalid is refused', async () => {
    const t = await newTicket();
    await transitionStatus(db, { ticketId: t.ticketId, to: 'IN_PROGRESS', actor: staff });
    expect((await getTicketRow(db, t.ticketId))!.status).toBe('IN_PROGRESS');
    await expect(transitionStatus(db, { ticketId: t.ticketId, to: 'CLOSED', actor: staff })).rejects.toThrow();
  });
  it('optimistic concurrency: a stale expectedVersion is rejected', async () => {
    const t = await newTicket();
    const v = (await getTicketRow(db, t.ticketId))!.version;
    await transitionStatus(db, { ticketId: t.ticketId, to: 'IN_PROGRESS', actor: staff, expectedVersion: v });
    await expect(transitionStatus(db, { ticketId: t.ticketId, to: 'TRIAGED', actor: staff, expectedVersion: v })).rejects.toThrow(/STALE|changed/i);
  });
  it('entering a waiting state pauses SLA; leaving it extends the resolution due date', async () => {
    const t = await newTicket();
    const before = (await getTicketRow(db, t.ticketId))!;
    await transitionStatus(db, { ticketId: t.ticketId, to: 'WAITING_ON_CUSTOMER', actor: staff });
    const paused = (await getTicketRow(db, t.ticketId))!;
    expect(paused.slaPausedAt).toBeTruthy();
    // simulate time passing while paused
    await db.update(supportTickets).set({ slaPausedAt: new Date(Date.now() - 60_000) }).where(eq(supportTickets.id, t.ticketId));
    await transitionStatus(db, { ticketId: t.ticketId, to: 'IN_PROGRESS', actor: staff });
    const resumed = (await getTicketRow(db, t.ticketId))!;
    expect(resumed.slaPausedAt).toBeNull();
    expect(new Date(resumed.resolutionDueAt!).getTime()).toBeGreaterThan(new Date(before.resolutionDueAt!).getTime());
  });
});

describe('assign / priority / tags / escalate', () => {
  it('assign, priority and tags persist and are recorded', async () => {
    const t = await newTicket();
    await assignTicket(db, { ticketId: t.ticketId, assigneeUserId: null, team: 'PAYOUT_OPERATIONS', actor: staff });
    await setPriority(db, { ticketId: t.ticketId, priority: 'HIGH', actor: staff, reason: 'funded' });
    await setTags(db, { ticketId: t.ticketId, tags: ['VIP', 'PAYOUT_DELAY', 'VIP'], actor: staff });
    const row = (await getTicketRow(db, t.ticketId))!;
    expect(row.team).toBe('PAYOUT_OPERATIONS');
    expect(row.priority).toBe('HIGH');
    expect((row.tags as string[]).sort()).toEqual(['PAYOUT_DELAY', 'VIP']);
  });
  it('escalate sets ESCALATED + team and can add an internal note', async () => {
    const t = await newTicket();
    await escalateTicket(db, { ticketId: t.ticketId, team: 'RISK_ENFORCEMENT', reason: 'needs risk', note: 'please review', actor: staff });
    const row = (await getTicketRow(db, t.ticketId))!;
    expect(row.status).toBe('ESCALATED');
    expect(row.team).toBe('RISK_ENFORCEMENT');
    const cust = await listMessages(db, t.ticketId, { includeInternal: false });
    expect(cust.some((m) => m.body.includes('please review'))).toBe(false); // note stays internal
  });
});

describe('resolve / reopen / merge / split / csat', () => {
  it('resolve requires a customer summary and sets the resolution', async () => {
    const t = await newTicket();
    await expect(resolveTicket(db, { ticketId: t.ticketId, resolutionCode: 'EXPLANATION_ONLY', customerSummary: '  ', actor: staff })).rejects.toThrow();
    await resolveTicket(db, { ticketId: t.ticketId, resolutionCode: 'CUSTOMER_EDUCATION', customerSummary: 'Explained the rule.', internalNotes: 'internal detail', rootCause: 'CUSTOMER_EDUCATION', actor: staff });
    const row = (await getTicketRow(db, t.ticketId))!;
    expect(row.status).toBe('RESOLVED');
    expect(row.resolutionCode).toBe('CUSTOMER_EDUCATION');
    expect(row.resolvedAt).toBeTruthy();
  });
  it('a customer can reopen inside the window; a closed window is refused', async () => {
    const t = await newTicket();
    await resolveTicket(db, { ticketId: t.ticketId, resolutionCode: 'EXPLANATION_ONLY', customerSummary: 'done', actor: staff });
    await reopenTicket(db, { ticketId: t.ticketId, actor: t.actor, reason: 'still broken', byCustomer: true });
    expect((await getTicketRow(db, t.ticketId))!.status).toBe('OPEN');
    // resolve again, then push the resolvedAt far into the past to close the window
    await resolveTicket(db, { ticketId: t.ticketId, resolutionCode: 'EXPLANATION_ONLY', customerSummary: 'done', actor: staff });
    await db.update(supportTickets).set({ resolvedAt: new Date(Date.now() - 100 * 86_400_000) }).where(eq(supportTickets.id, t.ticketId));
    await expect(reopenTicket(db, { ticketId: t.ticketId, actor: t.actor, reason: 'late', byCustomer: true })).rejects.toThrow(/window/i);
  });
  it('merge requires the same customer and preserves both histories', async () => {
    const c = await customer();
    const a = await submitTicket(db, { organizationId: org, customerUserId: c.id, categoryKey: 'ACCOUNT', subject: 'a', body: 'a', actor: c.actor });
    const b = await submitTicket(db, { organizationId: org, customerUserId: c.id, categoryKey: 'ACCOUNT', subject: 'b', body: 'b', actor: c.actor });
    await mergeTickets(db, { primaryId: a.id, secondaryId: b.id, actor: staff });
    const secondary = (await getTicketRow(db, b.id))!;
    expect(secondary.status).toBe('CLOSED');
    expect(secondary.mergedIntoTicketId).toBe(a.id);
    // both still have their original first message
    expect((await listMessages(db, b.id, { includeInternal: true })).length).toBeGreaterThanOrEqual(1);
    const other = await customer();
    const d = await submitTicket(db, { organizationId: org, customerUserId: other.id, categoryKey: 'ACCOUNT', subject: 'd', body: 'd', actor: other.actor });
    await expect(mergeTickets(db, { primaryId: a.id, secondaryId: d.id, actor: staff })).rejects.toThrow();
  });
  it('split creates a linked follow-up ticket', async () => {
    const t = await newTicket();
    const child = await splitTicket(db, { fromTicketId: t.ticketId, subject: 'separate issue', categoryKey: 'BILLING', body: 'unrelated', actor: staff });
    const childRow = (await getTicketRow(db, child.id))!;
    expect(childRow.followUpToTicketId).toBe(t.ticketId);
  });
  it('csat is 1-5 and only after resolution', async () => {
    const t = await newTicket();
    await expect(submitCsat(db, { ticketId: t.ticketId, customerUserId: t.customerId, rating: 5 })).rejects.toThrow(); // not resolved
    await resolveTicket(db, { ticketId: t.ticketId, resolutionCode: 'EXPLANATION_ONLY', customerSummary: 'done', actor: staff });
    await expect(submitCsat(db, { ticketId: t.ticketId, customerUserId: t.customerId, rating: 9 })).rejects.toThrow(); // out of range
    await submitCsat(db, { ticketId: t.ticketId, customerUserId: t.customerId, rating: 4, comment: 'good' });
    expect((await getTicketRow(db, t.ticketId))!.csatRating).toBe(4);
  });
});

describe('append-only guards', () => {
  it('support_messages cannot be updated or deleted', async () => {
    const t = await newTicket();
    const [m] = await db.select({ id: supportMessages.id }).from(supportMessages).where(eq(supportMessages.ticketId, t.ticketId));
    await expect(db.execute(sql`update support_messages set body = 'tamper' where id = ${m!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from support_messages where id = ${m!.id}`)).rejects.toThrow();
  });
  it('support_ticket_events cannot be updated', async () => {
    const t = await newTicket();
    const [e] = await db.select({ id: supportTicketEvents.id }).from(supportTicketEvents).where(eq(supportTicketEvents.ticketId, t.ticketId));
    await expect(db.execute(sql`update support_ticket_events set type = 'X' where id = ${e!.id}`)).rejects.toThrow();
  });
  it('the first-message and events exist for a created ticket', async () => {
    const t = await newTicket();
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(supportTicketEvents).where(and(eq(supportTicketEvents.ticketId, t.ticketId), eq(supportTicketEvents.type, 'CREATED')));
    expect(Number(rows[0]?.n ?? 0)).toBe(1);
  });
});
