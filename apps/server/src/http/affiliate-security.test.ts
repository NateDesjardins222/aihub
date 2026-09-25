/**
 * M11-J — affiliate SECURITY acceptance over HTTP. Proves the authorization
 * boundaries hold: portal isolation (an affiliate only ever sees its own record),
 * RBAC on owner routes, FINANCIAL step-up on money actions, privacy of referred
 * customers, and that unauthenticated callers are refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from '../platform/provisioning.js';

const PASSWORD = 'aff-sec-pw-123456';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const tok: Record<string, string> = {};

async function makeUser(role: string, tag: string): Promise<string> {
  const email = `affsec-${tag}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), displayName: `${role} ${tag}`, role, isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN', organizationId }).returning();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return JSON.parse(res.body).accessToken as string;
}
function call(method: 'GET' | 'POST', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as never }).then((r) => ({ status: r.statusCode, json: r.body ? JSON.parse(r.body) : null }));
}
const OPS = '/api/v1/admin/ops';
const AFF = '/api/v1/affiliates';

/** Enrol a TRADER token as an ACTIVE affiliate; returns its affiliateId. */
async function enrol(token: string | undefined, email: string): Promise<string> {
  const r = await call('POST', `${AFF}/apply`, token, { fullName: 'Sec Aff', email });
  const affiliateId = r.json.affiliateId as string;
  await call('POST', `${OPS}/affiliates/${affiliateId}/review`, tok.owner, { decision: 'APPROVE' });
  await call('POST', `${AFF}/me/accept-agreement`, token);
  return affiliateId;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app; await app.ready();
  db = getDb().db; organizationId = await defaultOrganizationId(db);
  tok.owner = await makeUser('SUPER_ADMIN', 'owner');
  tok.admin = await makeUser('ADMIN', 'admin');
  tok.support = await makeUser('SUPPORT', 'support');
  tok.affA = await makeUser('TRADER', 'affa');
  tok.affB = await makeUser('TRADER', 'affb');
  tok.outsider = await makeUser('TRADER', 'outsider');
}, 60_000);
afterAll(async () => { await app.close(); });

describe('portal isolation', () => {
  let affA = ''; let affB = '';
  beforeAll(async () => {
    affA = await enrol(tok.affA, 'seca@creator.test');
    affB = await enrol(tok.affB, 'secb@creator.test');
  });
  it('each affiliate sees only its own record via /me', async () => {
    const a = await call('GET', `${AFF}/me`, tok.affA);
    const b = await call('GET', `${AFF}/me`, tok.affB);
    expect(a.json.affiliate.id).toBe(affA);
    expect(b.json.affiliate.id).toBe(affB);
    expect(a.json.affiliate.id).not.toBe(b.json.affiliate.id);
  });
  it('an outsider is not enrolled', async () => {
    expect((await call('GET', `${AFF}/me`, tok.outsider)).json.enrolled).toBe(false);
  });
  it('an affiliate cannot read another affiliate 360 via the owner route', async () => {
    expect((await call('GET', `${OPS}/affiliates/${affB}`, tok.affA)).status).toBe(403);
  });
  it('an affiliate cannot list the owner affiliate directory', async () => {
    expect((await call('GET', `${OPS}/affiliates`, tok.affA)).status).toBe(403);
  });
  it('the portal conversion feed never includes a raw email', async () => {
    const r = await call('GET', `${AFF}/me/conversions`, tok.affA);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain('@creator.test');
    expect(JSON.stringify(r.json)).not.toContain('@atlas.test');
  });
});

describe('RBAC on owner routes', () => {
  it('unauthenticated overview is 401', async () => {
    expect((await call('GET', `${OPS}/affiliates/overview`)).status).toBe(401);
  });
  it('SUPPORT may read the overview but not review applications', async () => {
    expect((await call('GET', `${OPS}/affiliates/overview`, tok.support)).status).toBe(200);
    expect((await call('GET', `${OPS}/affiliates/applications`, tok.support)).status).toBe(403);
  });
  it('a TRADER may not read the overview', async () => {
    expect((await call('GET', `${OPS}/affiliates/overview`, tok.affA)).status).toBe(403);
  });
});

describe('FINANCIAL step-up on money actions', () => {
  let affId = '';
  beforeAll(async () => { affId = await enrol(await makeUser('TRADER', 'affc'), 'secc@creator.test'); });
  it('ADMIN cannot change a rate (owner-tier permission)', async () => {
    expect((await call('POST', `${OPS}/affiliates/${affId}/rate`, tok.admin, { customRateBps: 2000, reason: 'nope' })).status).toBe(403);
  });
  it('owner without a step-up token is refused', async () => {
    expect((await call('POST', `${OPS}/affiliates/${affId}/rate`, tok.owner, { customRateBps: 2000, reason: 'strategic' })).status).toBe(403);
  });
  it('owner with a FINANCIAL step-up succeeds', async () => {
    const step = await call('POST', '/api/v1/admin/security/reauth', tok.owner, { password: PASSWORD, class: 'FINANCIAL' });
    const ok = await call('POST', `${OPS}/affiliates/${affId}/rate`, tok.owner, { customRateBps: 2000, reason: 'strategic' }, { 'x-stepup-token': step.json.token });
    expect(ok.status).toBe(200);
  });
  it('config edit requires a step-up (refused without one)', async () => {
    expect((await call('POST', `${OPS}/affiliates/config`, tok.owner, { minPayoutMicros: 60000000 })).status).toBe(403);
  });
  it('a commission adjustment requires a step-up (refused without one)', async () => {
    expect((await call('POST', `${OPS}/affiliates/${affId}/adjust`, tok.owner, { amountMicros: 1000, reasonCode: 'X', explanation: 'no step up' })).status).toBe(403);
  });
});

describe('portal self-service guards', () => {
  it('unauthenticated cannot reach the portal', async () => {
    expect((await call('GET', `${AFF}/me`)).status).toBe(401);
  });
  it('an over-balance payout request is refused', async () => {
    const r = await call('POST', `${AFF}/me/payouts`, tok.affA, { amountMicros: 999_000_000 });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  it('the public program + agreement remain readable without auth', async () => {
    expect((await call('GET', `${AFF}/program`)).status).toBe(200);
    expect((await call('GET', `${AFF}/agreement`)).status).toBe(200);
  });
});
