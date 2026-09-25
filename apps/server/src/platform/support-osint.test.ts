/**
 * M12-L — support ↔ Owner OS integration + integrity invariants. Proves the
 * Command Center surfaces support KPIs and attention, global search finds tickets
 * and remediations, the object explorer resolves a ticket with its links, and the
 * new integrity checks (four-eyes on executed remediation; resolved tickets carry
 * a summary) fire correctly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/client.js';
import { organizations, supportRemediations, supportTickets, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import type { Actor } from './actor.js';
import { generateRemediationRef, getSupportConfig } from './support-config.js';
import { setPriority, submitTicket } from './support-tickets.js';
import { commandCenter } from './command-center.js';
import { globalSearch } from './search.js';
import { explainObject } from './object-explorer.js';
import { runIntegrityChecks } from './integrity.js';
import { eq } from 'drizzle-orm';

let db: Database; let h: { end: (o?: unknown) => Promise<void> }; let org: string; let seq = 0;
const staff: Actor = { type: 'ADMIN', label: 'ops@test', userId: null };

async function customer(): Promise<{ id: string; actor: Actor }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `osint-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('osint-pw-1234567'), displayName: `Cust ${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
  return { id: u!.id, actor: { type: 'USER', userId: u!.id, label: `c${seq}` } };
}
async function mkTicket(categoryKey = 'ACCOUNT'): Promise<{ id: string; publicRef: string; customerId: string; actor: Actor }> {
  const c = await customer();
  const r = await submitTicket(db, { organizationId: org, customerUserId: c.id, categoryKey, subject: 'help please', body: 'body', actor: c.actor });
  return { id: r.id, publicRef: r.publicRef, customerId: c.id, actor: c.actor };
}

beforeAll(async () => {
  const conn = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = conn.db; h = conn.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m12osint-${crypto.randomUUID().slice(0, 8)}`, name: 'OSINT' }).returning();
  org = o!.id;
  await getSupportConfig(db, org);
}, 60_000);
afterAll(async () => { await h.end({ timeout: 5 }); });

describe('Command Center', () => {
  it('surfaces support KPIs from real tickets', async () => {
    await mkTicket(); await mkTicket();
    const cc = await commandCenter(db, org);
    expect(cc.kpis).toHaveProperty('openSupportTickets');
    expect(cc.kpis.openSupportTickets).toBeGreaterThanOrEqual(2);
    expect(cc.kpis).toHaveProperty('supportSlaBreached');
    expect(cc.kpis).toHaveProperty('pendingRemediationApprovals');
  });
  it('raises an attention item for unassigned tickets', async () => {
    await mkTicket();
    const cc = await commandCenter(db, org);
    const hasSupportAttention = cc.attention.some((a) => a.link.startsWith('/admin/support'));
    expect(hasSupportAttention).toBe(true);
  });
});

describe('global search', () => {
  it('finds a ticket by public ref', async () => {
    const t = await mkTicket();
    const r = await globalSearch(db, org, t.publicRef);
    const group = r.groups.find((g) => g.type === 'support_ticket');
    expect(group).toBeTruthy();
    expect(group!.results.some((x) => x.id === t.id)).toBe(true);
  });
  it('finds a ticket by subject fragment', async () => {
    await mkTicket();
    const r = await globalSearch(db, org, 'help please');
    expect(r.groups.some((g) => g.type === 'support_ticket')).toBe(true);
  });
  it('finds a remediation by public ref and links to its ticket', async () => {
    const t = await mkTicket();
    const c = await customer();
    const ref = generateRemediationRef();
    await db.insert(supportRemediations).values({ organizationId: org, ticketId: t.id, publicRef: ref, type: 'OTHER', requestedByUserId: c.id, reason: 'goodwill' });
    const r = await globalSearch(db, org, ref);
    const group = r.groups.find((g) => g.type === 'support_remediation');
    expect(group).toBeTruthy();
    expect(group!.results[0]!.id).toBe(t.id); // links to parent ticket
  });
});

describe('object explorer', () => {
  it('resolves a support ticket with its customer and linked objects', async () => {
    const t = await mkTicket();
    const view = await explainObject(db, org, 'support_ticket', t.id);
    expect(view.type).toBe('support_ticket');
    expect(view.title).toBe(t.publicRef);
    expect(view.related.some((r) => r.type === 'customer')).toBe(true);
    expect(view.state).toHaveProperty('status');
  });
  it('rejects a ticket from another org', async () => {
    const t = await mkTicket();
    const [o2] = await db.insert(organizations).values({ slug: `m12osint2-${crypto.randomUUID().slice(0, 8)}`, name: 'OTHER' }).returning();
    await expect(explainObject(db, o2!.id, 'support_ticket', t.id)).rejects.toBeTruthy();
  });
});

describe('integrity checks', () => {
  it('four-eyes check passes on a clean org', async () => {
    const rep = await runIntegrityChecks(db, org, false);
    const c = rep.checks.find((x) => x.key === 'INV_REMEDIATION_FOUR_EYES');
    expect(c).toBeTruthy();
    expect(c!.status).toBe('PASS');
  });
  it('four-eyes check FAILS when an executed remediation was self-approved', async () => {
    const t = await mkTicket();
    const c = await customer();
    await db.insert(supportRemediations).values({
      organizationId: org, ticketId: t.id, publicRef: generateRemediationRef(), type: 'OTHER',
      requestedByUserId: c.id, approvedByUserId: c.id, status: 'EXECUTED', reason: 'self-approved breach', approvedAt: new Date(), executedAt: new Date(),
    });
    const rep = await runIntegrityChecks(db, org, false);
    const check = rep.checks.find((x) => x.key === 'INV_REMEDIATION_FOUR_EYES');
    expect(check!.status).toBe('FAIL');
    expect(check!.affectedCount).toBeGreaterThanOrEqual(1);
  });
  it('resolved-summary check warns when a resolved ticket lacks a summary', async () => {
    const t = await mkTicket();
    await setPriority(db, { ticketId: t.id, priority: 'LOW', actor: staff });
    // Force a terminal status with no summary (bypassing the domain, to prove the check catches drift).
    await db.update(supportTickets).set({ status: 'RESOLVED', resolvedAt: new Date(), resolutionSummaryCustomer: null }).where(eq(supportTickets.id, t.id));
    const rep = await runIntegrityChecks(db, org, false);
    const check = rep.checks.find((x) => x.key === 'INV_RESOLVED_TICKET_HAS_SUMMARY');
    expect(check!.status).toBe('WARN');
    expect(check!.affectedCount).toBeGreaterThanOrEqual(1);
  });
});
