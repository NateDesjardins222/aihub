/**
 * Internal staff notes: authorization, tenant isolation, append-only, and that
 * a note is stored as inert text.
 *
 * Against the real database and HTTP layer. The guarantees under test are the
 * ones that keep owner-side data safe: a trader can never reach these; another
 * organisation can never read or write them; a note body is stored verbatim as
 * text (no interpretation, no injection); and a correction redacts rather than
 * rewrites, leaving an audit trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { auditLog, organizations, traderNotes, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];
const orgs_: string[] = [];

async function makeUser(role: string, orgId = organizationId): Promise<{ id: string; token: string }> {
  const email = `note-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword('note-test-password'), displayName: role, role, organizationId: orgId })
    .returning();
  users_.push(user!.id);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'note-test-password' } });
  return { id: user!.id, token: JSON.parse(login.body).accessToken };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
});

afterAll(async () => {
  if (users_.length > 0) await db.delete(traderNotes).where(inArray(traderNotes.subjectUserId, users_));
  for (const id of users_) await db.delete(users).where(eq(users.id, id));
  for (const id of orgs_) await db.delete(organizations).where(eq(organizations.id, id));
  await app.close();
});

describe('staff notes', () => {
  it('lets SUPPORT create and read notes, and writes an audit row', async () => {
    const support = await makeUser('SUPPORT');
    const trader = await makeUser('TRADER');
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${trader.id}/notes`,
      headers: { authorization: `Bearer ${support.token}` },
      payload: { category: 'SUPPORT', body: 'Called about a reset.' },
    });
    expect(create.statusCode).toBe(201);
    const noteId = JSON.parse(create.body).note.id;

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${trader.id}/notes`,
      headers: { authorization: `Bearer ${support.token}` },
    });
    expect(list.statusCode).toBe(200);
    const notes = JSON.parse(list.body).notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe('Called about a reset.');
    expect(notes[0].author).toContain('@atlas.test');

    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, trader.id), eq(auditLog.action, 'trader_note.created')));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit.some((a) => (a.newState as { noteId?: string })?.noteId === noteId)).toBe(true);
  });

  it('stores a note body verbatim as text (no interpretation, no injection)', async () => {
    const admin = await makeUser('ADMIN');
    const trader = await makeUser('TRADER');
    const hostile = `<script>alert(1)</script> Robert'); DROP TABLE users;-- 日本語 \n newline`;
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${trader.id}/notes`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { category: 'GENERAL', body: hostile },
    });
    expect(create.statusCode).toBe(201);
    expect(JSON.parse(create.body).note.body).toBe(hostile);
    // The users table is obviously still there — the SQL-like text was inert.
    const stillThere = await db.select({ id: users.id }).from(users).where(eq(users.id, trader.id));
    expect(stillThere).toHaveLength(1);
    // And the stored row is byte-identical to what was sent.
    const [stored] = await db.select().from(traderNotes).where(eq(traderNotes.subjectUserId, trader.id));
    expect(stored!.body).toBe(hostile);
  });

  it('refuses a trader any access to notes', async () => {
    const trader = await makeUser('TRADER');
    const other = await makeUser('TRADER');
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${other.id}/notes`,
      headers: { authorization: `Bearer ${trader.token}` },
    });
    expect(read.statusCode).toBe(403);
    const write = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${other.id}/notes`,
      headers: { authorization: `Bearer ${trader.token}` },
      payload: { body: 'should not work' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('does not leak notes across organisations', async () => {
    const support = await makeUser('SUPPORT');
    const [otherOrg] = await db
      .insert(organizations)
      .values({ slug: `note-other-${crypto.randomUUID().slice(0, 6)}`, name: 'Note Other Firm' })
      .returning();
    orgs_.push(otherOrg!.id);
    const foreign = await makeUser('TRADER', otherOrg!.id);

    // Reading a foreign trader's notes is a 404 (no existence oracle), not a 200
    // with someone else's data.
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${foreign.id}/notes`,
      headers: { authorization: `Bearer ${support.token}` },
    });
    expect(read.statusCode).toBe(404);
    const write = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${foreign.id}/notes`,
      headers: { authorization: `Bearer ${support.token}` },
      payload: { body: 'cross-tenant' },
    });
    expect(write.statusCode).toBe(404);
  });

  it('redacts append-only (ADMIN only), keeping the row', async () => {
    const admin = await makeUser('ADMIN');
    const support = await makeUser('SUPPORT');
    const trader = await makeUser('TRADER');
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${trader.id}/notes`,
      headers: { authorization: `Bearer ${support.token}` },
      payload: { body: 'sensitive detail' },
    });
    const noteId = JSON.parse(create.body).note.id;

    // SUPPORT cannot redact.
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${trader.id}/notes/${noteId}/redact`,
      headers: { authorization: `Bearer ${support.token}` },
    });
    expect(denied.statusCode).toBe(403);

    const redact = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${trader.id}/notes/${noteId}/redact`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(redact.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${trader.id}/notes`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const notes = JSON.parse(list.body).notes;
    expect(notes).toHaveLength(1); // row kept
    expect(notes[0].redacted).toBe(true);
    expect(notes[0].body).toBeNull(); // body hidden
  });
});
