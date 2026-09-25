/**
 * Owner OS authorization over HTTP (M10-L). The console's safety model is
 * server-side: every ops route is gated by a granular permission (not role rank),
 * high-risk actions demand a fresh step-up token, and per-user DENY/GRANT
 * overrides are honoured on the live request. These tests exercise that matrix
 * end to end — unauthenticated → 401, wrong permission → 403, correct permission
 * → 200, DENY beats role, GRANT lifts a floor, and reauth is really required.
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

const PASSWORD = 'authz-http-pw-12345';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};

async function makeUser(role: string, tag: string) {
  const email = `authz-${tag}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [u] = await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), displayName: `${role} ${tag}`, role, isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN', organizationId }).returning();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return { id: u!.id, token: JSON.parse(res.body).accessToken as string };
}
function call(method: 'GET' | 'POST', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as never }).then((r) => ({ status: r.statusCode, json: r.body ? JSON.parse(r.body) : null }));
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app; await app.ready();
  db = getDb().db; organizationId = await defaultOrganizationId(db);
  for (const [role, tag] of [['SUPPORT', 'support'], ['ADMIN', 'admin'], ['SUPER_ADMIN', 'owner'], ['TRADER', 'trader']] as const) {
    const u = await makeUser(role, tag); ids[role] = u.id; tokens[role] = u.token;
  }
}, 60_000);
afterAll(async () => { await app.close(); });

const CC = '/api/v1/admin/ops/command-center';

describe('authentication', () => {
  it('an unauthenticated request is refused (401)', async () => {
    expect((await call('GET', CC)).status).toBe(401);
  });
  it('a garbage bearer token is refused (401)', async () => {
    expect((await call('GET', CC, 'not-a-real-jwt')).status).toBe(401);
  });
});

describe('permission-gated reads', () => {
  it('a TRADER has no console access (403)', async () => {
    expect((await call('GET', CC, tokens.TRADER)).status).toBe(403);
  });
  it('SUPPORT can read the command center (system.read)', async () => {
    expect((await call('GET', CC, tokens.SUPPORT)).status).toBe(200);
  });
  it('ADMIN and SUPER_ADMIN can read the command center', async () => {
    expect((await call('GET', CC, tokens.ADMIN)).status).toBe(200);
    expect((await call('GET', CC, tokens.SUPER_ADMIN)).status).toBe(200);
  });
  it('SUPPORT cannot read the staff directory (needs staff.read)', async () => {
    expect((await call('GET', '/api/v1/admin/staff', tokens.SUPPORT)).status).toBe(403);
  });
  it('ADMIN can read the staff directory', async () => {
    expect((await call('GET', '/api/v1/admin/staff', tokens.ADMIN)).status).toBe(200);
  });
  it('SUPPORT cannot read financial summary (needs finance.read — it can)', async () => {
    // finance.read IS a SUPPORT default; this documents that boundary explicitly.
    expect((await call('GET', '/api/v1/admin/ops/finance/summary', tokens.SUPPORT)).status).toBe(200);
  });
});

describe('per-user overrides are honoured on the live request', () => {
  it('a DENY of system.read removes an ADMIN’s command-center access', async () => {
    const denied = await makeUser('ADMIN', 'denied');
    expect((await call('GET', CC, denied.token)).status).toBe(200);
    await setPermissionOverride(db, denied.id, 'system.read', 'DENY', SYSTEM_ACTOR);
    expect((await call('GET', CC, denied.token)).status).toBe(403);
    await setPermissionOverride(db, denied.id, 'system.read', 'CLEAR', SYSTEM_ACTOR);
    expect((await call('GET', CC, denied.token)).status).toBe(200);
  });
  it('a GRANT lifts a SUPPORT user above its default floor (staff.read)', async () => {
    const granted = await makeUser('SUPPORT', 'granted');
    expect((await call('GET', '/api/v1/admin/staff', granted.token)).status).toBe(403);
    await setPermissionOverride(db, granted.id, 'staff.read', 'GRANT', SYSTEM_ACTOR);
    expect((await call('GET', '/api/v1/admin/staff', granted.token)).status).toBe(200);
  });
});

describe('write authorization', () => {
  it('SUPPORT cannot write a feature flag; ADMIN can', async () => {
    expect((await call('POST', '/api/v1/admin/ops/config/flags', tokens.SUPPORT, { key: 'NEW_CHECKOUT', enabled: true })).status).toBe(403);
    expect((await call('POST', '/api/v1/admin/ops/config/flags', tokens.ADMIN, { key: 'NEW_CHECKOUT', enabled: false })).status).toBe(200);
  });
  it('creating a task needs tasks.manage (SUPPORT holds it)', async () => {
    const r = await call('POST', '/api/v1/admin/ops/tasks', tokens.SUPPORT, { title: 'Look into a mismatch', priority: 'NORMAL' });
    expect(r.status).toBe(200);
  });
});

describe('step-up reauthentication is really required', () => {
  it('engaging a kill switch is owner-only AND needs a KILL_SWITCH step-up', async () => {
    // ADMIN lacks the permission entirely.
    expect((await call('POST', '/api/v1/admin/ops/config/kill-switches/MAINTENANCE_MODE/engage', tokens.ADMIN, { reason: 'x' })).status).toBe(403);
    // Owner has the permission but no step-up token → refused.
    expect((await call('POST', '/api/v1/admin/ops/config/kill-switches/MAINTENANCE_MODE/engage', tokens.SUPER_ADMIN, { reason: 'drill' })).status).toBe(403);
    // Owner with a fresh step-up token → allowed; then release the same way.
    const step = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: PASSWORD, class: 'KILL_SWITCH' });
    expect(step.status).toBe(200);
    const eng = await call('POST', '/api/v1/admin/ops/config/kill-switches/MAINTENANCE_MODE/engage', tokens.SUPER_ADMIN, { reason: 'maintenance drill' }, { 'x-stepup-token': step.json.token });
    expect(eng.status).toBe(200);
    const step2 = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: PASSWORD, class: 'KILL_SWITCH' });
    const rel = await call('POST', '/api/v1/admin/ops/config/kill-switches/MAINTENANCE_MODE/release', tokens.SUPER_ADMIN, { reason: 'done' }, { 'x-stepup-token': step2.json.token });
    expect(rel.status).toBe(200);
  });
  it('a step-up token for the wrong class does not satisfy KILL_SWITCH', async () => {
    const wrong = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: PASSWORD, class: 'STAFF' });
    const eng = await call('POST', '/api/v1/admin/ops/config/kill-switches/MAINTENANCE_MODE/engage', tokens.SUPER_ADMIN, { reason: 'x' }, { 'x-stepup-token': wrong.json.token });
    expect(eng.status).toBe(403);
  });
  it('reauth with a wrong password is refused (401)', async () => {
    const r = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: 'wrong-password', class: 'KILL_SWITCH' });
    expect(r.status).toBe(401);
  });
});
