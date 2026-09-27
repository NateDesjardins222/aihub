/**
 * Product Recovery Phase 3 — staff RBAC adversarial, the self-escalation edge
 * (STEP 10). Complements the existing owner-staff-http / m10-1 red-team suites;
 * it does NOT repeat what they prove (TRADER denial, ADMIN-can't-invite, the
 * no-self-service-grant override endpoint, mass-assignment role smuggling).
 *
 * The specific thing proven here: a STAFF step-up token — which ANY signed-in
 * operator can mint for their own session — never substitutes for the owner-only
 * permission the endpoint requires. So a lower-privilege operator armed with a
 * perfectly valid reauth token STILL cannot change any role (including their
 * own), disable an operator, or revoke sessions. Role/staff management is the
 * owner-only tier; there is no path by which an ADMIN escalates itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from '../platform/provisioning.js';

const PASSWORD = 'staff-rbac-adv-pw-123';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
/** Non-null accessors — the beforeAll populates every role used below. */
const tok = (role: string): string => tokens[role]!;
const id = (role: string): string => ids[role]!;

async function makeUser(role: string): Promise<{ id: string; token: string }> {
  const email = `rbacadv-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [user] = await db.insert(users).values({
    email, passwordHash: await hashPassword(PASSWORD), displayName: role, role, organizationId,
    isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN',
  }).returning();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return { id: user!.id, token: JSON.parse(res.body).accessToken };
}

function call(method: 'GET' | 'POST', url: string, token?: string | null, payload?: unknown, headers: Record<string, string> = {}) {
  return app
    .inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as never })
    .then((r) => ({ status: r.statusCode, json: r.body ? JSON.parse(r.body) : null }));
}

/** Mint a real STAFF step-up token for an operator's own session. */
async function stepUp(token: string): Promise<string> {
  const r = await call('POST', '/api/v1/admin/security/reauth', token, { password: PASSWORD, class: 'STAFF' });
  expect(r.status).toBe(200);
  return r.json.token as string;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  for (const role of ['SUPPORT', 'ADMIN', 'SUPER_ADMIN']) {
    const u = await makeUser(role);
    tokens[role] = u.token;
    ids[role] = u.id;
  }
}, 60_000);
afterAll(async () => { await app.close(); });

describe('a valid step-up never substitutes for the owner-only permission', () => {
  it('an ADMIN with a valid STAFF step-up still cannot change any role', async () => {
    const step = await stepUp(tok('ADMIN')); // genuinely valid reauth token
    const r = await call('POST', `/api/v1/admin/staff/${id('SUPPORT')}/role`, tok('ADMIN'), { role: 'ADMIN' }, { 'x-stepup-token': step });
    expect(r.status).toBe(403); // lacks roles.manage — the owner-only tier
  });

  it('an ADMIN cannot promote ITSELF to owner, even with a valid step-up', async () => {
    const step = await stepUp(tok('ADMIN'));
    const r = await call('POST', `/api/v1/admin/staff/${id('ADMIN')}/role`, tok('ADMIN'), { role: 'SUPER_ADMIN' }, { 'x-stepup-token': step });
    expect(r.status).toBe(403); // no self-escalation path exists at all
    // And the role is unchanged: /me/access still lacks the owner-only permission.
    const me = await call('GET', '/api/v1/admin/me/access', tok('ADMIN'));
    expect(me.json.role).toBe('ADMIN');
    expect(me.json.permissions).not.toContain('roles.manage');
  });

  it('an ADMIN with a valid STAFF step-up still cannot disable an operator', async () => {
    const step = await stepUp(tok('ADMIN'));
    const r = await call('POST', `/api/v1/admin/staff/${id('SUPPORT')}/disable`, tok('ADMIN'), {}, { 'x-stepup-token': step });
    expect(r.status).toBe(403); // lacks staff.manage
  });

  it('an ADMIN cannot revoke another operator’s sessions (lacks security.manage)', async () => {
    const r = await call('POST', `/api/v1/admin/staff/${id('SUPER_ADMIN')}/revoke-sessions`, tok('ADMIN'), {});
    expect(r.status).toBe(403);
  });

  it('SUPPORT (lower still) is denied role change and disable outright', async () => {
    const step = await stepUp(tok('SUPPORT'));
    expect((await call('POST', `/api/v1/admin/staff/${id('ADMIN')}/role`, tok('SUPPORT'), { role: 'SUPPORT' }, { 'x-stepup-token': step })).status).toBe(403);
    expect((await call('POST', `/api/v1/admin/staff/${id('ADMIN')}/disable`, tok('SUPPORT'), {}, { 'x-stepup-token': step })).status).toBe(403);
  });

  it('an owner CAN change a role with a valid step-up (the control is usable, not just locked)', async () => {
    const step = await stepUp(tok('SUPER_ADMIN'));
    const r = await call('POST', `/api/v1/admin/staff/${id('SUPPORT')}/role`, tok('SUPER_ADMIN'), { role: 'ADMIN' }, { 'x-stepup-token': step });
    expect(r.status).toBe(200);
    expect(r.json.role).toBe('ADMIN');
    // Put it back so the fixture leaves no drift for other assertions.
    const step2 = await stepUp(tok('SUPER_ADMIN'));
    await call('POST', `/api/v1/admin/staff/${id('SUPPORT')}/role`, tok('SUPER_ADMIN'), { role: 'SUPPORT' }, { 'x-stepup-token': step2 });
  });
});
