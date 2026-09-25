/**
 * Owner OS account operations over HTTP (M10-E). The financial-correction path
 * requires accounts.adjust AND a FINANCIAL step-up; ADMIN lacks accounts.adjust
 * (four-eyes → owner); pause needs accounts.pause; there is no raw balance edit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { accounts, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../platform/provisioning.js';
import { publishProfileVersion } from '../platform/profiles.js';

const M = 1_000_000; const $ = (d: number) => d * M;
const PASSWORD = 'acctops-http-pw-1';
const KEY = 'm10e-http-50k';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const tokens: Record<string, string> = {};
let accountId = '';

async function makeUser(role: string) {
  const email = `acctopshttp-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), displayName: role, role, isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN', organizationId }).returning();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return JSON.parse(res.body).accessToken as string;
}
function call(method: 'GET' | 'POST', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as never }).then((r) => ({ status: r.statusCode, json: r.body ? JSON.parse(r.body) : null }));
}

function cfg(size: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: $(3000), maxLossMicros: $(2000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: size, priceMicros: $(135) }, payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } }, fundedDestinationKey: null, whopPlanId: null };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app; await app.ready();
  db = getDb().db; organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: KEY, name: 'AcctOps HTTP 50K', accountType: 'EVALUATION', config: cfg($(50_000)) });
  for (const role of ['TRADER', 'SUPPORT', 'ADMIN', 'SUPER_ADMIN']) tokens[role] = await makeUser(role);
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.role, 'TRADER')).limit(1);
  const prov = await provisionAccount(db, { organizationId, userId: u!.id, profileKey: KEY });
  accountId = prov.accountId;
  await db.update(accounts).set({ status: 'ACTIVE', activatedAt: new Date() }).where(eq(accounts.id, accountId));
}, 60_000);
afterAll(async () => { await app.close(); });


describe('account adjustment authorization (no raw balance edit)', () => {
  it('SUPPORT and ADMIN cannot adjust (accounts.adjust is owner-only)', async () => {
    const body = { type: 'CREDIT', amountMicros: $(10), reasonCode: 'GOODWILL_CREDIT', explanation: 'test credit' };
    expect((await call('POST', `/api/v1/admin/ops/accounts/${accountId}/adjust`, tokens.SUPPORT, body)).status).toBe(403);
    expect((await call('POST', `/api/v1/admin/ops/accounts/${accountId}/adjust`, tokens.ADMIN, body)).status).toBe(403);
  });

  it('owner without FINANCIAL step-up is refused; with it, the adjustment is recorded', async () => {
    const body = { type: 'CREDIT', amountMicros: $(10), reasonCode: 'GOODWILL_CREDIT', explanation: 'test credit' };
    expect((await call('POST', `/api/v1/admin/ops/accounts/${accountId}/adjust`, tokens.SUPER_ADMIN, body)).status).toBe(403);
    const step = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: PASSWORD, class: 'FINANCIAL' });
    const ok = await call('POST', `/api/v1/admin/ops/accounts/${accountId}/adjust`, tokens.SUPER_ADMIN, body, { 'x-stepup-token': step.json.token });
    expect(ok.status).toBe(200);
    expect(ok.json.id).toBeTruthy();
  });

  it('the adjustments list reflects recorded corrections', async () => {
    const r = await call('GET', `/api/v1/admin/ops/accounts/${accountId}/adjustments`, tokens.SUPPORT);
    expect(r.status).toBe(200);
    expect(r.json.adjustments.length).toBeGreaterThanOrEqual(1);
  });

  it('pause needs accounts.pause: support denied, admin allowed', async () => {
    expect((await call('POST', `/api/v1/admin/ops/accounts/${accountId}/pause`, tokens.SUPPORT, { reason: 'review' })).status).toBe(403);
    const ok = await call('POST', `/api/v1/admin/ops/accounts/${accountId}/pause`, tokens.ADMIN, { reason: 'review pause' });
    expect(ok.status).toBe(200);
    expect(ok.json.adminHold).toBe('LOCKED');
    await call('POST', `/api/v1/admin/ops/accounts/${accountId}/resume`, tokens.ADMIN, { reason: 'cleared' });
  });

  it('there is no raw balance PUT/PATCH endpoint on the account', async () => {
    const put = await app.inject({ method: 'PUT', url: `/api/v1/admin/ops/accounts/${accountId}`, headers: { authorization: `Bearer ${tokens.SUPER_ADMIN}` }, payload: { balanceMicros: $(999999) } as never });
    expect([404, 405]).toContain(put.statusCode);
  });
});
