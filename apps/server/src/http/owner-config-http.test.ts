/**
 * Owner OS configuration + kill switches over HTTP (M10-F). Flag writes need
 * system.feature_flags.manage; kill switches need system.kill_switches.manage +
 * a KILL_SWITCH step-up. The DISABLE_NEW_ORDERS switch blocks NEW order
 * placement (423) while leaving the risk-reducing cancel-all endpoint reachable.
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
import { releaseKillSwitch } from '../platform/kill-switches.js';
import { SYSTEM_ACTOR } from '../platform/actor.js';

const M = 1_000_000; const $ = (d: number) => d * M;
const PASSWORD = 'cfg-http-pw-12345';
const KEY = 'm10f-http-50k';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const tokens: Record<string, string> = {};
let traderToken = ''; let accountId = '';

async function makeUser(role: string) {
  const email = `cfghttp-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [u] = await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), displayName: role, role, isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN', organizationId }).returning();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return { id: u!.id, token: JSON.parse(res.body).accessToken as string };
}
function call(method: 'GET' | 'POST' | 'DELETE', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as never }).then((r) => ({ status: r.statusCode, json: r.body ? JSON.parse(r.body) : null }));
}
function cfg(size: number) {
  return { rules: { accountSizeMicros: size, profitTargetMicros: $(3000), maxLossMicros: $(2000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true }, execution: null, instruments: { allowed: null, maxContracts: 50, perInstrument: {} }, display: { startingBalanceMicros: size, priceMicros: $(135) }, payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } }, fundedDestinationKey: null, whopPlanId: null };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app; await app.ready();
  db = getDb().db; organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: KEY, name: 'Cfg HTTP 50K', accountType: 'EVALUATION', config: cfg($(50_000)) });
  for (const role of ['SUPPORT', 'ADMIN', 'SUPER_ADMIN']) tokens[role] = (await makeUser(role)).token;
  const t = await makeUser('TRADER'); traderToken = t.token;
  const prov = await provisionAccount(db, { organizationId, userId: t.id, profileKey: KEY });
  accountId = prov.accountId;
  await db.update(accounts).set({ status: 'ACTIVE', activatedAt: new Date() }).where(eq(accounts.id, accountId));
}, 60_000);
afterAll(async () => { await releaseKillSwitch(db, 'DISABLE_NEW_ORDERS', 'cleanup', SYSTEM_ACTOR, organizationId).catch(() => {}); await app.close(); });

describe('feature flag authorization', () => {
  it('SUPPORT cannot write flags; ADMIN can', async () => {
    expect((await call('POST', '/api/v1/admin/ops/config/flags', tokens.SUPPORT, { key: 'NEW_CHECKOUT', enabled: true })).status).toBe(403);
    const ok = await call('POST', '/api/v1/admin/ops/config/flags', tokens.ADMIN, { key: 'NEW_CHECKOUT', enabled: true });
    expect(ok.status).toBe(200);
    expect(ok.json.enabled).toBe(true);
  });
});

describe('kill switch authorization', () => {
  it('kill switches list requires system.read (support ok)', async () => {
    const r = await call('GET', '/api/v1/admin/ops/config/kill-switches', tokens.SUPPORT);
    expect(r.status).toBe(200);
    expect(r.json.switches.length).toBeGreaterThan(0);
  });
  it('ADMIN cannot engage a kill switch (owner-only); owner needs a KILL_SWITCH step-up', async () => {
    expect((await call('POST', '/api/v1/admin/ops/config/kill-switches/DISABLE_NEW_ORDERS/engage', tokens.ADMIN, { reason: 'x' })).status).toBe(403);
    expect((await call('POST', '/api/v1/admin/ops/config/kill-switches/DISABLE_NEW_ORDERS/engage', tokens.SUPER_ADMIN, { reason: 'incident' })).status).toBe(403);
  });
});

describe('DISABLE_NEW_ORDERS blocks new exposure but not risk reduction', () => {
  it('engages, blocks POST /orders with 423, leaves cancel-all reachable, then releases', async () => {
    const step = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: PASSWORD, class: 'KILL_SWITCH' });
    const eng = await call('POST', '/api/v1/admin/ops/config/kill-switches/DISABLE_NEW_ORDERS/engage', tokens.SUPER_ADMIN, { reason: 'emergency halt' }, { 'x-stepup-token': step.json.token });
    expect(eng.status).toBe(200);

    const newOrder = await call('POST', '/api/v1/orders', traderToken, { accountId, symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET', tif: 'DAY' });
    expect(newOrder.status).toBe(423); // new exposure blocked

    // cancel-all is a separate risk-reducing endpoint and must NOT be kill-switched.
    const cancelAll = await call('POST', '/api/v1/orders/cancel-all', traderToken, { accountId });
    expect(cancelAll.status).not.toBe(423);

    const step2 = await call('POST', '/api/v1/admin/security/reauth', tokens.SUPER_ADMIN, { password: PASSWORD, class: 'KILL_SWITCH' });
    const rel = await call('POST', '/api/v1/admin/ops/config/kill-switches/DISABLE_NEW_ORDERS/release', tokens.SUPER_ADMIN, { reason: 'resolved' }, { 'x-stepup-token': step2.json.token });
    expect(rel.status).toBe(200);
  });
});
