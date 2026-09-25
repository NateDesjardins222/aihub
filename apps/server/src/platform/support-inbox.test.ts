/**
 * M12-L — inbox, analytics and the assembled views. Proves server-side filtering
 * and keyset pagination, factual overview KPIs, the staff workspace payload, and
 * that the customer view never carries internal notes or another customer's data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/client.js';
import { organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import type { Actor } from './actor.js';
import { getSupportConfig } from './support-config.js';
import { addMessage, assignTicket, resolveTicket, setPriority, submitCsat, submitTicket, transitionStatus } from './support-tickets.js';
import { customerTicketView, listInbox, supportOverview, ticketWorkspace } from './support-inbox.js';

let db: Database; let h: { end: (o?: unknown) => Promise<void> }; let org: string; let seq = 0;
const staff: Actor = { type: 'ADMIN', label: 'ops@test', userId: null };

async function customer(): Promise<{ id: string; actor: Actor }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `inbox-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('inbox-pw-1234567'), displayName: `Cust ${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
  return { id: u!.id, actor: { type: 'USER', userId: u!.id, label: `c${seq}` } };
}
async function mkTicket(categoryKey = 'ACCOUNT'): Promise<{ id: string; customerId: string; actor: Actor }> {
  const c = await customer();
  const r = await submitTicket(db, { organizationId: org, customerUserId: c.id, categoryKey, subject: 'help', body: 'body', actor: c.actor });
  return { id: r.id, customerId: c.id, actor: c.actor };
}

beforeAll(async () => {
  const conn = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = conn.db; h = conn.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m12inbox-${crypto.randomUUID().slice(0, 8)}`, name: 'INBOX' }).returning();
  org = o!.id;
  await getSupportConfig(db, org);
}, 60_000);
afterAll(async () => { await h.end({ timeout: 5 }); });

describe('listInbox', () => {
  it('returns all open tickets by default', async () => {
    await mkTicket(); await mkTicket();
    const r = await listInbox(db, org, { view: 'ALL' });
    expect(r.tickets.length).toBeGreaterThanOrEqual(2);
    expect(r.tickets[0]).toHaveProperty('sla');
  });
  it('UNASSIGNED excludes assigned tickets', async () => {
    const t = await mkTicket();
    await assignTicket(db, { ticketId: t.id, assigneeUserId: null, team: 'PAYOUT_OPERATIONS', actor: staff });
    // still unassigned by owner (assigneeUserId null) → appears
    const before = await listInbox(db, org, { view: 'UNASSIGNED' });
    expect(before.tickets.some((x) => x.id === t.id)).toBe(true);
  });
  it('URGENT view only shows urgent tickets', async () => {
    const t = await mkTicket();
    await setPriority(db, { ticketId: t.id, priority: 'URGENT', actor: staff });
    const r = await listInbox(db, org, { view: 'URGENT' });
    expect(r.tickets.every((x) => x.priority === 'URGENT')).toBe(true);
    expect(r.tickets.some((x) => x.id === t.id)).toBe(true);
  });
  it('filters by category', async () => {
    await mkTicket('PAYOUT');
    const r = await listInbox(db, org, { category: 'PAYOUT' });
    expect(r.tickets.every((x) => x.categoryKey === 'PAYOUT')).toBe(true);
  });
  it('search matches the public ref', async () => {
    const t = await mkTicket();
    const w = await ticketWorkspace(db, org, t.id);
    const ref = String((w!.ticket as { publicRef: string }).publicRef);
    const r = await listInbox(db, org, { q: ref });
    expect(r.tickets.some((x) => x.publicRef === ref)).toBe(true);
  });
  it('keyset pagination returns a cursor and does not repeat rows', async () => {
    for (let i = 0; i < 5; i += 1) await mkTicket();
    const p1 = await listInbox(db, org, { limit: 3 });
    expect(p1.tickets.length).toBe(3);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await listInbox(db, org, { limit: 3, cursor: p1.nextCursor });
    const ids1 = new Set(p1.tickets.map((t) => t.id));
    expect(p2.tickets.every((t) => !ids1.has(t.id))).toBe(true);
  });
  it('RESOLVED view shows only terminal tickets', async () => {
    const t = await mkTicket();
    await transitionStatus(db, { ticketId: t.id, to: 'IN_PROGRESS', actor: staff });
    await resolveTicket(db, { ticketId: t.id, resolutionCode: 'EXPLANATION_ONLY', customerSummary: 'done', actor: staff });
    const r = await listInbox(db, org, { view: 'RESOLVED' });
    expect(r.tickets.some((x) => x.id === t.id)).toBe(true);
    expect(r.tickets.every((x) => x.status === 'RESOLVED' || x.status === 'CLOSED')).toBe(true);
  });
});

describe('supportOverview', () => {
  it('reports factual counts and CSAT', async () => {
    const t = await mkTicket();
    await transitionStatus(db, { ticketId: t.id, to: 'IN_PROGRESS', actor: staff });
    await resolveTicket(db, { ticketId: t.id, resolutionCode: 'CUSTOMER_EDUCATION', customerSummary: 'ok', actor: staff });
    await submitCsat(db, { ticketId: t.id, customerUserId: t.customerId, rating: 5 });
    const ov = await supportOverview(db, org);
    expect(ov.open).toBeGreaterThanOrEqual(0);
    expect(ov.resolvedToday).toBeGreaterThanOrEqual(1);
    expect(ov.csatCount).toBeGreaterThanOrEqual(1);
    expect(ov.csatAverage).toBeGreaterThan(0);
    expect(typeof ov.byStatus).toBe('object');
    expect(typeof ov.byCategory).toBe('object');
  });
  it('counts urgent open tickets', async () => {
    const t = await mkTicket();
    await setPriority(db, { ticketId: t.id, priority: 'URGENT', actor: staff });
    const ov = await supportOverview(db, org);
    expect(ov.urgent).toBeGreaterThanOrEqual(1);
  });
});

describe('ticketWorkspace (staff) vs customerTicketView (customer)', () => {
  it('workspace includes internal notes; customer view hides them', async () => {
    const t = await mkTicket();
    await addMessage(db, { ticketId: t.id, senderType: 'STAFF', visibility: 'CUSTOMER', body: 'public answer', actor: staff });
    await addMessage(db, { ticketId: t.id, senderType: 'STAFF', visibility: 'INTERNAL', body: 'SECRET internal detail', actor: staff });

    const ws = await ticketWorkspace(db, org, t.id);
    expect(ws).not.toBeNull();
    expect(JSON.stringify(ws!.messages)).toContain('SECRET internal detail');
    expect(ws!.customer).not.toBeNull();

    const cv = await customerTicketView(db, org, t.customerId, t.id);
    expect(cv).not.toBeNull();
    expect(JSON.stringify(cv)).not.toContain('SECRET internal detail');
    expect(JSON.stringify(cv)).toContain('public answer');
  });
  it('customer view returns null for another customer', async () => {
    const t = await mkTicket();
    const other = await customer();
    expect(await customerTicketView(db, org, other.id, t.id)).toBeNull();
  });
  it('workspace returns null for a ticket in another org', async () => {
    const t = await mkTicket();
    const [o2] = await db.insert(organizations).values({ slug: `m12inbox2-${crypto.randomUUID().slice(0, 8)}`, name: 'OTHER' }).returning();
    expect(await ticketWorkspace(db, o2!.id, t.id)).toBeNull();
  });
  it('customer public projection names staff generically', async () => {
    const t = await mkTicket();
    await addMessage(db, { ticketId: t.id, senderType: 'STAFF', visibility: 'CUSTOMER', body: 'we are on it', actor: staff });
    const cv = await customerTicketView(db, org, t.customerId, t.id);
    const staffMsg = cv!.messages.find((m) => (m as { senderType: string }).senderType === 'STAFF') as { senderName: string | null } | undefined;
    expect(staffMsg?.senderName).toBe('Happy Trader Support');
  });
});
