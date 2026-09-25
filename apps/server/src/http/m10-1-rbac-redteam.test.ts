/**
 * M10.1 hardening — RBAC red-team over HTTP.
 *
 * An adversarial sweep of the Owner OS authorization surface: for a matrix of
 * endpoints, prove that under-privileged actors are refused (401 unauthenticated,
 * 403 without the permission) and that privileged reads succeed. Also red-teams
 * privilege escalation via overrides: DENY beats role, a granted permission is
 * scoped, and the owner's protected controls cannot be stripped.
 *
 * These are safety assertions: a single 200 where a 403 is required would be a P0.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from '../platform/provisioning.js';
import { setPermissionOverride } from '../platform/staff.js';
import { SYSTEM_ACTOR } from '../platform/actor.js';

const PASSWORD = 'redteam-pw-12345';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const tok: Record<string, string> = {};

async function makeUser(role: string) {
  const email = `redteam-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [u] = await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), displayName: role, role, isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN', organizationId }).returning();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return { id: u!.id, token: JSON.parse(res.body).accessToken as string };
}
function call(method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) {
  return app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never }).then((r) => r.statusCode);
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app; await app.ready();
  db = getDb().db; organizationId = await defaultOrganizationId(db);
  for (const role of ['TRADER', 'SUPPORT', 'ADMIN', 'SUPER_ADMIN']) tok[role] = (await makeUser(role)).token;
}, 60_000);
afterAll(async () => { await app.close(); });

const OPS = '/api/v1/admin/ops';
const ADMIN = '/api/v1/admin';

// Read endpoints and the roles that MAY read them. Everyone else must be refused.
const READS: Array<{ path: string; allow: string[] }> = [
  { path: `${OPS}/command-center`, allow: ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] },
  { path: `${OPS}/daily-brief`, allow: ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] },
  { path: `${OPS}/finance/summary`, allow: ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] },
  { path: `${OPS}/search?q=demo`, allow: ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] },
  { path: `${OPS}/events?limit=5`, allow: ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] },
  { path: `${OPS}/system/doctor`, allow: ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] },
  { path: `${OPS}/system/integrity`, allow: ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] },
  { path: `${OPS}/providers`, allow: ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] },
  { path: `${OPS}/incidents`, allow: ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] },
  { path: `${OPS}/alerts`, allow: ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] },
  { path: `${OPS}/config/flags`, allow: ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] },
  { path: `${OPS}/config/kill-switches`, allow: ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'] },
  { path: `${ADMIN}/staff`, allow: ['ADMIN', 'SUPER_ADMIN'] }, // SUPPORT lacks staff.read
];

describe('read authorization matrix', () => {
  it.each(READS)('unauthenticated is refused: $path', async ({ path }) => {
    expect(await call('GET', path)).toBe(401);
  });
  it.each(READS)('TRADER is refused: $path', async ({ path }) => {
    expect(await call('GET', path, tok.TRADER)).toBe(403);
  });
  for (const role of ['SUPPORT', 'ADMIN', 'SUPER_ADMIN']) {
    it.each(READS)(`${role} gets the expected result: $path`, async ({ path, allow }) => {
      const status = await call('GET', path, tok[role]);
      if (allow.includes(role)) expect(status).toBe(200);
      else expect(status).toBe(403);
    });
  }
});

// Write endpoints and the roles whose PERMISSION layer allows them (reauth-gated
// ones still 403 without a step-up, which is covered in owner-authz-http; here we
// assert the deny side, which is the security-critical direction).
const WRITE_DENY: Array<{ method: 'POST'; path: string; body: unknown; deny: string[] }> = [
  { method: 'POST', path: `${OPS}/config/flags`, body: { key: 'NEW_CHECKOUT', enabled: false }, deny: ['TRADER', 'SUPPORT'] },
  { method: 'POST', path: `${OPS}/incidents`, body: { title: 'redteam', severity: 'WARNING' }, deny: ['TRADER', 'SUPPORT'] },
  { method: 'POST', path: `${OPS}/config/kill-switches/MAINTENANCE_MODE/engage`, body: { reason: 'redteam' }, deny: ['TRADER', 'SUPPORT', 'ADMIN'] },
  { method: 'POST', path: `${ADMIN}/staff/invite`, body: { email: 'x@y.z', role: 'SUPPORT' }, deny: ['TRADER', 'SUPPORT', 'ADMIN'] },
];

describe('write authorization deny matrix', () => {
  for (const w of WRITE_DENY) {
    it.each(w.deny)(`%s cannot ${w.method} ${w.path}`, async (role) => {
      expect(await call(w.method, w.path, tok[role], w.body)).toBe(403);
    });
    it(`unauthenticated cannot ${w.method} ${w.path}`, async () => {
      expect(await call(w.method, w.path, undefined, w.body)).toBe(401);
    });
  }
});

describe('privilege-escalation red-team via overrides', () => {
  it('a DENY on system.read blocks an ADMIN read even though the role grants it', async () => {
    const victim = await makeUser('ADMIN');
    expect(await call('GET', `${OPS}/command-center`, victim.token)).toBe(200);
    await setPermissionOverride(db, victim.id, 'system.read', 'DENY', SYSTEM_ACTOR);
    expect(await call('GET', `${OPS}/command-center`, victim.token)).toBe(403);
    await setPermissionOverride(db, victim.id, 'system.read', 'CLEAR', SYSTEM_ACTOR);
    expect(await call('GET', `${OPS}/command-center`, victim.token)).toBe(200);
  });

  it('a GRANT is scoped to exactly one permission (no lateral escalation)', async () => {
    const u = await makeUser('SUPPORT');
    // Grant staff.read only; staff.manage must remain refused.
    await setPermissionOverride(db, u.id, 'staff.read', 'GRANT', SYSTEM_ACTOR);
    expect(await call('GET', `${ADMIN}/staff`, u.token)).toBe(200);
    expect(await call('POST', `${ADMIN}/staff/invite`, u.token, { email: 'z@z.z', role: 'SUPPORT' })).toBe(403);
  });

  it('an ADMIN cannot grant themselves a permission (no self-service escalation endpoint)', async () => {
    const u = await makeUser('ADMIN');
    // The override endpoint requires roles.manage (owner-only); ADMIN is refused.
    expect(await call('POST', `${ADMIN}/staff/${u.id}/permission`, u.token, { permission: 'accounts.adjust', effect: 'GRANT' })).toBe(403);
  });

  it('a TRADER token cannot reach any owner surface at all', async () => {
    for (const p of [`${OPS}/command-center`, `${ADMIN}/staff`, `${OPS}/finance/summary`, `${OPS}/config/flags`]) {
      expect(await call('GET', p, tok.TRADER)).toBe(403);
    }
  });
});
