/**
 * M11-I/J — affiliate program over HTTP: the public→owner→portal flow plus the
 * authorization/security matrix. Proves RBAC, step-up reauth, and that an
 * affiliate can never reach another affiliate or change its own economics.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from '../platform/provisioning.js';

const PASSWORD = 'aff-http-pw-12345';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};

async function makeUser(role: string, tag: string) {
  const email = `affhttp-${tag}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
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
  for (const [role, tag] of [['SUPER_ADMIN', 'owner'], ['ADMIN', 'admin'], ['SUPPORT', 'support'], ['TRADER', 'applicant'], ['TRADER', 'other']] as const) {
    const u = await makeUser(role, tag); tok[tag] = u.token; ids[tag] = u.id;
  }
}, 60_000);
afterAll(async () => { await app.close(); });

const OPS = '/api/v1/admin/ops';
const AFF = '/api/v1/affiliates';

describe('public + portal flow', () => {
  let affiliateId = '';
  it('an applicant can apply', async () => {
    const r = await call('POST', `${AFF}/apply`, tok.applicant, { fullName: 'App Licant', email: 'app@creator.test', primaryPlatform: 'YouTube' });
    expect(r.status).toBe(201);
    affiliateId = r.json.affiliateId;
  });
  it('owner sees the application; SUPPORT cannot review applications', async () => {
    expect((await call('GET', `${OPS}/affiliates/applications`, tok.support)).status).toBe(403);
    const r = await call('GET', `${OPS}/affiliates/applications`, tok.owner);
    expect(r.status).toBe(200);
    expect(r.json.applications.some((a: { affiliateId: string }) => a.affiliateId === affiliateId)).toBe(true);
  });
  it('portal shows onboarding before activation, dashboard after', async () => {
    let me = await call('GET', `${AFF}/me`, tok.applicant);
    expect(me.json.onboarding).toBe(true);
    await call('POST', `${OPS}/affiliates/${affiliateId}/review`, tok.owner, { decision: 'APPROVE' });
    me = await call('GET', `${AFF}/me`, tok.applicant);
    expect(me.json.onboarding).toBe(true); // approved but not yet agreed
    const acc = await call('POST', `${AFF}/me/accept-agreement`, tok.applicant);
    expect(acc.status).toBe(200);
    expect(acc.json.code).toBeTruthy();
    me = await call('GET', `${AFF}/me`, tok.applicant);
    expect(me.json.onboarding).toBeUndefined();
    expect(me.json.affiliate.status).toBe('ACTIVE');
    expect(me.json.codes.length).toBeGreaterThanOrEqual(1);
  });
  it('another user is not enrolled and cannot see this affiliate 360 without permission', async () => {
    expect((await call('GET', `${AFF}/me`, tok.other)).json.enrolled).toBe(false);
    expect((await call('GET', `${OPS}/affiliates/${affiliateId}`, tok.other)).status).toBe(403);
  });
});

describe('authorization + reauth matrix', () => {
  let affiliateId = '';
  beforeAll(async () => {
    const r = await call('POST', `${AFF}/apply`, tok.other, { fullName: 'Other Aff', email: 'other-aff@creator.test' });
    affiliateId = r.json.affiliateId;
    await call('POST', `${OPS}/affiliates/${affiliateId}/review`, tok.owner, { decision: 'APPROVE' });
    await call('POST', `${AFF}/me/accept-agreement`, tok.other);
  });
  it('unauthenticated overview is 401; SUPPORT can read; TRADER is 403', async () => {
    expect((await call('GET', `${OPS}/affiliates/overview`)).status).toBe(401);
    expect((await call('GET', `${OPS}/affiliates/overview`, tok.support)).status).toBe(200);
    expect((await call('GET', `${OPS}/affiliates/overview`, tok.applicant)).status).toBe(403);
  });
  it('ADMIN cannot change a rate (owner-tier); owner needs a FINANCIAL step-up', async () => {
    expect((await call('POST', `${OPS}/affiliates/${affiliateId}/rate`, tok.admin, { customRateBps: 2200, reason: 'nope' })).status).toBe(403);
    // owner without step-up → refused
    expect((await call('POST', `${OPS}/affiliates/${affiliateId}/rate`, tok.owner, { customRateBps: 2200, reason: 'strategic' })).status).toBe(403);
    // owner with step-up → allowed
    const step = await call('POST', '/api/v1/admin/security/reauth', tok.owner, { password: PASSWORD, class: 'FINANCIAL' });
    const ok = await call('POST', `${OPS}/affiliates/${affiliateId}/rate`, tok.owner, { customRateBps: 2200, reason: 'strategic' }, { 'x-stepup-token': step.json.token });
    expect(ok.status).toBe(200);
  });
  it('an affiliate cannot mark its own commission adjustments or payouts paid', async () => {
    // No portal route exists for these; the ops routes require owner permission.
    expect((await call('POST', `${OPS}/affiliates/${affiliateId}/adjust`, tok.other, { amountMicros: 100000, reasonCode: 'X', explanation: 'self serve' })).status).toBe(403);
  });
  it('a payout request below the minimum is rejected for the affiliate', async () => {
    const r = await call('POST', `${AFF}/me/payouts`, tok.other, { amountMicros: 1000000 });
    expect(r.status).toBeGreaterThanOrEqual(400); // below $50 min / insufficient balance
  });
  it('the public program + agreement endpoints are readable without auth', async () => {
    expect((await call('GET', `${AFF}/program`)).status).toBe(200);
    expect((await call('GET', `${AFF}/agreement`)).status).toBe(200);
  });
});
