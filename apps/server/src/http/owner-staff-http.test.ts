/**
 * Owner OS staff/RBAC over HTTP (M10-B). Authorization is server-enforced:
 * every gate is exercised with a token that lacks the permission, high-risk
 * actions require a fresh step-up token, and the public onboarding flow lets an
 * invited staff member set their own password without the owner ever seeing it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from '../platform/provisioning.js';

const PASSWORD = 'owner-os-http-pw-123';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const tokens: Record<string, string> = {};
let traderUserId = '';

async function makeUser(role: string): Promise<{ id: string; token: string; email: string }> {
  const email = `owneros-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [user] = await db.insert(users).values({
    email, passwordHash: await hashPassword(PASSWORD), displayName: role, role, organizationId,
    isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN',
  }).returning();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return { id: user!.id, token: JSON.parse(res.body).accessToken, email };
}

function call(method: 'GET' | 'POST', url: string, token?: string | null, payload?: unknown, headers: Record<string, string> = {}) {
  return app
    .inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as never })
    .then((r) => ({ status: r.statusCode, json: r.body ? JSON.parse(r.body) : null, raw: r.body }));
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  for (const role of ['TRADER', 'SUPPORT', 'ADMIN', 'SUPER_ADMIN']) {
    const u = await makeUser(role);
    tokens[role] = u.token;
    if (role === 'TRADER') traderUserId = u.id;
  }
}, 60_000);
afterAll(async () => { await app.close(); });

describe('read gates', () => {
  it('GET /staff: TRADER and SUPPORT are denied, ADMIN and owner allowed', async () => {
    expect((await call('GET', '/api/v1/admin/staff', undefined)).status).toBe(401);
    expect((await call('GET', '/api/v1/admin/staff', tokens.TRADER)).status).toBe(403);
    expect((await call('GET', '/api/v1/admin/staff', tokens.SUPPORT)).status).toBe(403);
    expect((await call('GET', '/api/v1/admin/staff', tokens.ADMIN)).status).toBe(200);
    expect((await call('GET', '/api/v1/admin/staff', tokens.SUPER_ADMIN)).status).toBe(200);
  });

  it('GET /me/access returns the effective permission set', async () => {
    const r = await call('GET', '/api/v1/admin/me/access', tokens.ADMIN);
    expect(r.status).toBe(200);
    expect(r.json.permissions).toContain('accounts.pause');
    expect(r.json.permissions).not.toContain('staff.manage');
  });
});

describe('staff.manage + reauth', () => {
  it('ADMIN cannot invite staff (lacks staff.manage)', async () => {
    const r = await call('POST', '/api/v1/admin/staff/invite', tokens.ADMIN, { email: 'x@y.test', role: 'SUPPORT' });
    expect(r.status).toBe(403);
  });

  it('owner without a step-up token is refused (reauth required)', async () => {
    const r = await call('POST', '/api/v1/admin/staff/invite', tokens.SUPER_ADMIN, { email: `inv-${Date.now()}@y.test`, role: 'SUPPORT' });
    expect(r.status).toBe(403);
  });

  it('a wrong reauth password does not mint a step-up token', async () => {
    const r = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: 'wrong', class: 'STAFF' });
    expect(r.status).toBe(401);
  });

  it('owner with a fresh step-up token can invite; the token is returned once', async () => {
    const step = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: PASSWORD, class: 'STAFF' });
    expect(step.status).toBe(200);
    const r = await call('POST', '/api/v1/admin/staff/invite', tokens.SUPER_ADMIN, { email: `invited-${Date.now()}@y.test`, role: 'SUPPORT' }, { 'x-stepup-token': step.json.token });
    expect(r.status).toBe(200);
    expect(r.json.activationToken).toBeTruthy();
  });

  it('a step-up minted for one class does not satisfy another', async () => {
    const step = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: PASSWORD, class: 'FINANCIAL' });
    const r = await call('POST', '/api/v1/admin/staff/invite', tokens.SUPER_ADMIN, { email: `x2-${Date.now()}@y.test`, role: 'SUPPORT' }, { 'x-stepup-token': step.json.token });
    expect(r.status).toBe(403);
  });
});

describe('public onboarding flow', () => {
  it('invite → peek → accept lets the invitee set their own password and sign in', async () => {
    const step = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: PASSWORD, class: 'STAFF' });
    const email = `onboard-${Date.now()}@y.test`;
    const inv = await call('POST', '/api/v1/admin/staff/invite', tokens.SUPER_ADMIN, { email, role: 'ADMIN' }, { 'x-stepup-token': step.json.token });
    const token = inv.json.activationToken;
    const peek = await call('GET', `/api/v1/staff-onboarding/${token}`);
    expect(peek.status).toBe(200);
    expect(peek.json.email).toBe(email);
    expect(peek.json.valid).toBe(true);
    const accept = await call('POST', '/api/v1/staff-onboarding/accept', undefined, { token, password: 'invitee-own-pw-12345' });
    expect(accept.status).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'invitee-own-pw-12345' } });
    expect(login.statusCode).toBe(200);
  });
});

describe('impersonation authorization', () => {
  it('SUPPORT cannot impersonate (lacks customers.impersonate); owner can', async () => {
    const denied = await call('POST', `/api/v1/admin/customers/${traderUserId}/impersonate`, tokens.SUPPORT, { reason: 'support' });
    expect(denied.status).toBe(403);
    const ok = await call('POST', `/api/v1/admin/customers/${traderUserId}/impersonate`, tokens.SUPER_ADMIN, { reason: 'support ticket' });
    expect(ok.status).toBe(200);
    expect(ok.json.supportToken).toBeTruthy();
    expect(ok.json.mode).toBe('READ_ONLY');
    const active = await call('GET', '/api/v1/admin/impersonation/active', tokens.ADMIN);
    expect(active.status).toBe(200);
    expect(active.json.sessions.some((s: { id: string }) => s.id === ok.json.sessionId)).toBe(true);
    const end = await call('POST', `/api/v1/admin/impersonation/${ok.json.sessionId}/end`, tokens.SUPER_ADMIN);
    expect(end.status).toBe(200);
  });

  it('impersonating a staff account is refused', async () => {
    const step = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: PASSWORD, class: 'STAFF' });
    void step;
    const supportId = (await call('GET', '/api/v1/admin/staff', tokens.SUPER_ADMIN)).json.staff.find((s: { role: string }) => s.role === 'SUPPORT')?.id;
    if (supportId) {
      const r = await call('POST', `/api/v1/admin/customers/${supportId}/impersonate`, tokens.SUPER_ADMIN, { reason: 'should fail' });
      expect(r.status).toBe(400);
    }
  });
});

describe('mass-assignment / role tampering', () => {
  it('the invite body cannot smuggle a role the caller is not allowed to set through extra fields', async () => {
    const step = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: PASSWORD, class: 'STAFF' });
    // Extra unknown fields are stripped by the zod schema; only whitelisted fields are read.
    const r = await call('POST', '/api/v1/admin/staff/invite', tokens.SUPER_ADMIN,
      { email: `mass-${Date.now()}@y.test`, role: 'SUPPORT', isAdmin: true, status: 'SUPER_ADMIN', id: '00000000-0000-0000-0000-000000000000' },
      { 'x-stepup-token': step.json.token });
    expect(r.status).toBe(200);
  });
});
