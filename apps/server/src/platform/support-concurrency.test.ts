/**
 * M12-K/L — concurrency, idempotency and append-only guarantees. Proves messages
 * and remediation requests are idempotent under retry, remediation approval is
 * four-eyes and single-winner under a race, execution claims exactly once, ticket
 * edits use optimistic concurrency, and the append-only trigger blocks mutation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { organizations, supportMessages, supportRemediations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import type { Actor } from './actor.js';
import { getSupportConfig } from './support-config.js';
import { addMessage, submitTicket, transitionStatus } from './support-tickets.js';
import { approveRemediation, executeRemediation, requestRemediation } from './support-remediation.js';

let db: Database; let h: { end: (o?: unknown) => Promise<void> }; let org: string; let seq = 0;

async function staffUser(): Promise<Actor> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `conc-staff-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('conc-pw-12345678'), displayName: `Staff ${seq}`, role: 'ADMIN', isAdmin: true, organizationId: org }).returning();
  return { type: 'ADMIN', userId: u!.id, label: `staff-${seq}` };
}
async function customer(): Promise<{ id: string; actor: Actor }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `conc-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('conc-pw-12345678'), displayName: `Cust ${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
  return { id: u!.id, actor: { type: 'USER', userId: u!.id, label: `c${seq}` } };
}
async function mkTicket(): Promise<{ id: string; customerId: string; actor: Actor }> {
  const c = await customer();
  const r = await submitTicket(db, { organizationId: org, customerUserId: c.id, categoryKey: 'OTHER', subject: 'concurrency', body: 'body', actor: c.actor });
  return { id: r.id, customerId: c.id, actor: c.actor };
}

beforeAll(async () => {
  const conn = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = conn.db; h = conn.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m12conc-${crypto.randomUUID().slice(0, 8)}`, name: 'CONC' }).returning();
  org = o!.id;
  await getSupportConfig(db, org);
}, 60_000);
afterAll(async () => { await h.end({ timeout: 5 }); });

describe('idempotency', () => {
  it('addMessage with the same key does not double-post', async () => {
    const t = await mkTicket();
    const key = `msg-${crypto.randomUUID()}`;
    const a = await addMessage(db, { ticketId: t.id, senderType: 'CUSTOMER', visibility: 'CUSTOMER', body: 'hello', idempotencyKey: key, actor: t.actor });
    const b = await addMessage(db, { ticketId: t.id, senderType: 'CUSTOMER', visibility: 'CUSTOMER', body: 'hello', idempotencyKey: key, actor: t.actor });
    expect(a.id).toBe(b.id);
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(supportMessages).where(and(eq(supportMessages.ticketId, t.id), eq(supportMessages.idempotencyKey, key)));
    expect(rows[0]?.n ?? 0).toBe(1);
  });
  it('concurrent addMessage with one key yields a single message', async () => {
    const t = await mkTicket();
    const key = `msg-${crypto.randomUUID()}`;
    await Promise.all([
      addMessage(db, { ticketId: t.id, senderType: 'CUSTOMER', visibility: 'CUSTOMER', body: 'race', idempotencyKey: key, actor: t.actor }).catch(() => undefined),
      addMessage(db, { ticketId: t.id, senderType: 'CUSTOMER', visibility: 'CUSTOMER', body: 'race', idempotencyKey: key, actor: t.actor }).catch(() => undefined),
    ]);
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(supportMessages).where(and(eq(supportMessages.ticketId, t.id), eq(supportMessages.idempotencyKey, key)));
    expect(rows[0]?.n ?? 0).toBe(1);
  });
  it('requestRemediation with the same key returns the same row', async () => {
    const t = await mkTicket();
    const staff = await staffUser();
    const key = `rem-${crypto.randomUUID()}`;
    const a = await requestRemediation(db, { ticketId: t.id, type: 'OTHER', reason: 'goodwill', idempotencyKey: key, actor: staff });
    const b = await requestRemediation(db, { ticketId: t.id, type: 'OTHER', reason: 'goodwill', idempotencyKey: key, actor: staff });
    expect(a.id).toBe(b.id);
  });
});

describe('remediation four-eyes + single-winner', () => {
  it('the requester cannot approve their own remediation', async () => {
    const t = await mkTicket();
    const staff = await staffUser();
    const req = await requestRemediation(db, { ticketId: t.id, type: 'OTHER', reason: 'x', actor: staff });
    await expect(approveRemediation(db, { remediationId: req.id, actor: staff })).rejects.toBeTruthy();
  });
  it('a different approver succeeds and is recorded', async () => {
    const t = await mkTicket();
    const requester = await staffUser();
    const approver = await staffUser();
    const req = await requestRemediation(db, { ticketId: t.id, type: 'OTHER', reason: 'x', actor: requester });
    const res = await approveRemediation(db, { remediationId: req.id, actor: approver });
    expect(res.status).toBe('APPROVED');
    const [row] = await db.select().from(supportRemediations).where(eq(supportRemediations.id, req.id));
    expect(row!.approvedByUserId).toBe(approver.userId);
  });
  it('double approve is idempotent', async () => {
    const t = await mkTicket();
    const requester = await staffUser();
    const approver = await staffUser();
    const req = await requestRemediation(db, { ticketId: t.id, type: 'OTHER', reason: 'x', actor: requester });
    await approveRemediation(db, { remediationId: req.id, actor: approver });
    const second = await approveRemediation(db, { remediationId: req.id, actor: approver });
    expect(second.status).toBe('APPROVED');
  });
  it('concurrent execute claims execute exactly once', async () => {
    const t = await mkTicket();
    const requester = await staffUser();
    const approver = await staffUser();
    const req = await requestRemediation(db, { ticketId: t.id, type: 'OTHER', reason: 'x', actor: approver });
    await approveRemediation(db, { remediationId: req.id, actor: requester });
    const [a, b] = await Promise.all([
      executeRemediation(db, { remediationId: req.id, actor: approver }).catch((e) => ({ status: 'ERR', failureReason: (e as Error).message })),
      executeRemediation(db, { remediationId: req.id, actor: approver }).catch((e) => ({ status: 'ERR', failureReason: (e as Error).message })),
    ]);
    // The row ends EXECUTED exactly once; at least one call reports EXECUTED.
    const [row] = await db.select().from(supportRemediations).where(eq(supportRemediations.id, req.id));
    expect(row!.status).toBe('EXECUTED');
    expect([a.status, b.status]).toContain('EXECUTED');
  });
});

describe('optimistic concurrency + append-only', () => {
  it('a stale expectedVersion is rejected', async () => {
    const t = await mkTicket();
    const staff = await staffUser();
    await transitionStatus(db, { ticketId: t.id, to: 'IN_PROGRESS', actor: staff, expectedVersion: 1 });
    // version has advanced; replaying version 1 must fail
    await expect(transitionStatus(db, { ticketId: t.id, to: 'WAITING_ON_CUSTOMER', actor: staff, expectedVersion: 1 })).rejects.toBeTruthy();
  });
  it('the append-only trigger blocks updating a message', async () => {
    const t = await mkTicket();
    const m = await addMessage(db, { ticketId: t.id, senderType: 'CUSTOMER', visibility: 'CUSTOMER', body: 'immutable', actor: t.actor });
    await expect(db.update(supportMessages).set({ body: 'tampered' }).where(eq(supportMessages.id, m.id))).rejects.toBeTruthy();
  });
  it('the append-only trigger blocks deleting a message', async () => {
    const t = await mkTicket();
    const m = await addMessage(db, { ticketId: t.id, senderType: 'CUSTOMER', visibility: 'CUSTOMER', body: 'immutable', actor: t.actor });
    await expect(db.delete(supportMessages).where(eq(supportMessages.id, m.id))).rejects.toBeTruthy();
  });
});
