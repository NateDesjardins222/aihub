/**
 * M12-L — attachments over the storage seam: safe creation, round-trip read,
 * visibility projection (customer never sees INTERNAL attachments), ownership-based
 * access, and executable rejection at creation. Deterministic; no network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/client.js';
import { organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import type { Actor } from './actor.js';
import { getSupportConfig } from './support-config.js';
import { submitTicket } from './support-tickets.js';
import { canAccessAttachment, createAttachment, getAttachment, listAttachments, readAttachmentBytes } from './support-attachments.js';

let db: Database; let h: { end: (o?: unknown) => Promise<void> }; let org: string; let seq = 0;
const staff: Actor = { type: 'ADMIN', label: 'ops@test', userId: null };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function customer(): Promise<{ id: string; actor: Actor }> {
  seq += 1;
  const [u] = await db.insert(users).values({ email: `att-${seq}-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('att-pw-12345678'), displayName: `Cust ${seq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
  return { id: u!.id, actor: { type: 'USER', userId: u!.id, label: `c${seq}` } };
}
async function mkTicket(): Promise<{ id: string; customerId: string; actor: Actor }> {
  const c = await customer();
  const r = await submitTicket(db, { organizationId: org, customerUserId: c.id, categoryKey: 'TECHNICAL', subject: 'att', body: 'body', actor: c.actor });
  return { id: r.id, customerId: c.id, actor: c.actor };
}

beforeAll(async () => {
  const conn = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = conn.db; h = conn.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m12att-${crypto.randomUUID().slice(0, 8)}`, name: 'ATT' }).returning();
  org = o!.id;
  await getSupportConfig(db, org);
}, 60_000);
afterAll(async () => { await h.end({ timeout: 5 }); });

describe('createAttachment + read', () => {
  it('stores an allowed image and reads it back byte-identical', async () => {
    const t = await mkTicket();
    const a = await createAttachment(db, { ticketId: t.id, uploaderType: 'CUSTOMER', filename: 'shot.png', contentType: 'image/png', bytes: PNG, visibility: 'CUSTOMER', actor: t.actor });
    const row = await getAttachment(db, a.id);
    expect(row).toBeTruthy();
    const blob = await readAttachmentBytes(row!.storageKey);
    expect(blob).toBeTruthy();
    expect(Buffer.compare(blob!.bytes, PNG)).toBe(0);
  });
  it('rejects an executable at creation', async () => {
    const t = await mkTicket();
    await expect(createAttachment(db, { ticketId: t.id, uploaderType: 'CUSTOMER', filename: 'x.exe', contentType: 'application/x-msdownload', bytes: PNG, visibility: 'CUSTOMER', actor: t.actor })).rejects.toBeTruthy();
  });
  it('rejects an oversized file', async () => {
    const t = await mkTicket();
    const big = Buffer.alloc(11 * 1024 * 1024, 1);
    await expect(createAttachment(db, { ticketId: t.id, uploaderType: 'CUSTOMER', filename: 'big.png', contentType: 'image/png', bytes: big, visibility: 'CUSTOMER', actor: t.actor })).rejects.toBeTruthy();
  });
});

describe('visibility projection', () => {
  it('customer listing excludes internal attachments; staff listing includes them', async () => {
    const t = await mkTicket();
    await createAttachment(db, { ticketId: t.id, uploaderType: 'CUSTOMER', filename: 'pub.png', contentType: 'image/png', bytes: PNG, visibility: 'CUSTOMER', actor: t.actor });
    await createAttachment(db, { ticketId: t.id, uploaderType: 'STAFF', filename: 'internal.png', contentType: 'image/png', bytes: PNG, visibility: 'INTERNAL', actor: staff });
    const asCustomer = await listAttachments(db, t.id, { includeInternal: false });
    const asStaff = await listAttachments(db, t.id, { includeInternal: true });
    expect(asCustomer.every((x) => (x as { visibility?: string }).visibility !== 'INTERNAL')).toBe(true);
    expect(asCustomer.some((x) => x.filename === 'internal.png')).toBe(false);
    expect(asStaff.some((x) => x.filename === 'internal.png')).toBe(true);
  });
});

describe('canAccessAttachment', () => {
  it('the owning customer can access their own attachment', async () => {
    const t = await mkTicket();
    const a = await createAttachment(db, { ticketId: t.id, uploaderType: 'CUSTOMER', filename: 'a.png', contentType: 'image/png', bytes: PNG, visibility: 'CUSTOMER', actor: t.actor });
    expect(await canAccessAttachment(db, a.id, { userId: t.customerId, isStaff: false })).toBe(true);
  });
  it('another customer cannot access it', async () => {
    const t = await mkTicket();
    const a = await createAttachment(db, { ticketId: t.id, uploaderType: 'CUSTOMER', filename: 'a.png', contentType: 'image/png', bytes: PNG, visibility: 'CUSTOMER', actor: t.actor });
    const other = await customer();
    expect(await canAccessAttachment(db, a.id, { userId: other.id, isStaff: false })).toBe(false);
  });
  it('a customer cannot access an internal (staff-only) attachment on their own ticket', async () => {
    const t = await mkTicket();
    const a = await createAttachment(db, { ticketId: t.id, uploaderType: 'STAFF', filename: 'i.png', contentType: 'image/png', bytes: PNG, visibility: 'INTERNAL', actor: staff });
    expect(await canAccessAttachment(db, a.id, { userId: t.customerId, isStaff: false })).toBe(false);
  });
  it('staff can access an internal attachment', async () => {
    const t = await mkTicket();
    const a = await createAttachment(db, { ticketId: t.id, uploaderType: 'STAFF', filename: 'i.png', contentType: 'image/png', bytes: PNG, visibility: 'INTERNAL', actor: staff });
    expect(await canAccessAttachment(db, a.id, { userId: null, isStaff: true })).toBe(true);
  });
});
