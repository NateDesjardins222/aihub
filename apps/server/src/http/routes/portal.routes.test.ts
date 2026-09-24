/**
 * Customer portal HTTP surface — ownership, presentation-only mutations, and the
 * privacy rules, against the real app. Every route is the caller's own; another
 * trader's account is a 404 (no IDOR), and an active account cannot be archived.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { getDb } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../../platform/provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from '../../platform/profiles.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
let token: string;
let otherToken: string;
let accountId: string;
const users_: string[] = [];
const EVAL_KEY = `portalrt-eval-${Math.random().toString(36).slice(2, 8)}`;

async function makeUser(): Promise<{ id: string; email: string }> {
  const email = `portalrt-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [u] = await db.insert(users).values({ email, passwordHash: await hashPassword('prt-pw'), displayName: 'Port Trader', organizationId }).returning();
  users_.push(u!.id);
  return { id: u!.id, email };
}
async function tokenFor(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'prt-pw' } });
  if (res.statusCode !== 200) throw new Error(`login ${res.statusCode}`);
  return JSON.parse(res.body).accessToken;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'false';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, {
    organizationId, key: EVAL_KEY, name: 'Portal RT Eval 25K', accountType: 'EVALUATION',
    config: {
      rules: {
        accountSizeMicros: 25_000 * M, profitTargetMicros: 1_500 * M, maxLossMicros: 1_000 * M,
        drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null,
        dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null,
        minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0,
        minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true,
      },
      execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
      display: { startingBalanceMicros: 25_000 * M, priceMicros: 65 * M }, payoutRules: null, fundedDestinationKey: null,
    },
  });
  const me = await makeUser();
  const other = await makeUser();
  token = await tokenFor(me.email);
  otherToken = await tokenFor(other.email);
  const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
  accountId = (await provisionAccount(db, { organizationId, userId: me.id, profileVersionId: product.versionId, activate: true })).accountId;
});

afterAll(async () => {
  if (users_.length > 0) await db.delete(users).where(inArray(users.id, users_));
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const get = (url: string, t = token) => app.inject({ method: 'GET', url, headers: auth(t) });
const post = (url: string, t = token) => app.inject({ method: 'POST', url, headers: auth(t) });
const patch = (url: string, body: Record<string, unknown>, t = token) => app.inject({ method: 'PATCH', url, headers: auth(t), payload: body });

describe('portal accounts', () => {
  it('lists the caller’s own accounts with the active-slot count', async () => {
    const body = JSON.parse((await get('/api/v1/portal/accounts')).body);
    expect(body.accounts.some((a: { id: string }) => a.id === accountId)).toBe(true);
    expect(body.activeSlotsUsed).toBeGreaterThanOrEqual(1);
    expect(body.maxActiveSlots).toBe(5);
  });

  it('sets a nickname (presentation-only) reflected in the detail', async () => {
    expect((await patch(`/api/v1/portal/accounts/${accountId}/nickname`, { nickname: 'Runner' })).statusCode).toBe(200);
    const detail = JSON.parse((await get(`/api/v1/portal/accounts/${accountId}`)).body);
    expect(detail.nickname).toBe('Runner');
    expect(detail.priceMicros).toBe(65 * M);
  });

  it('does not leak another trader’s account (no IDOR)', async () => {
    expect((await get(`/api/v1/portal/accounts/${accountId}`, otherToken)).statusCode).toBe(404);
    expect((await get(`/api/v1/portal/accounts/${accountId}/analytics`, otherToken)).statusCode).toBe(404);
    expect((await patch(`/api/v1/portal/accounts/${accountId}/nickname`, { nickname: 'x' }, otherToken)).statusCode).toBe(404);
  });

  it('refuses to archive an active account', async () => {
    const res = await post(`/api/v1/portal/accounts/${accountId}/archive`);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error?.code ?? JSON.parse(res.body).code).toBe('CANNOT_ARCHIVE_ACTIVE');
  });

  it('returns analytics for the owner', async () => {
    const res = await get(`/api/v1/portal/accounts/${accountId}/analytics`);
    expect(res.statusCode).toBe(200);
    const a = JSON.parse(res.body);
    expect(a.accountId).toBe(accountId);
    expect(a.trades.totalTrades).toBe(0); // no trades yet
  });

  it('refuses a reset on an account that is not a failed evaluation', async () => {
    expect((await get(`/api/v1/portal/accounts/${accountId}/reset-quote`)).statusCode).toBe(400);
  });

  it('exposes an Atlas handoff descriptor', async () => {
    const h = JSON.parse((await get(`/api/v1/portal/accounts/${accountId}/handoff`)).body);
    expect(h.tradable).toBe(true);
    expect(h.terminalPath).toContain(h.publicId);
  });
});

describe('portal recognition + profile', () => {
  it('lists (empty) certificates and achievements', async () => {
    expect(JSON.parse((await get('/api/v1/portal/certificates')).body).certificates).toEqual([]);
    const ach = JSON.parse((await get('/api/v1/portal/achievements')).body);
    expect(ach.achievementsPublic).toBe(false);
    expect(ach.achievements).toEqual([]);
  });

  it('toggles achievements visibility', async () => {
    expect((await patch('/api/v1/portal/achievements/visibility', { isPublic: true })).statusCode).toBe(200);
    expect(JSON.parse((await get('/api/v1/portal/achievements')).body).achievementsPublic).toBe(true);
  });

  it('sets a preferred display name but rejects one containing an email', async () => {
    expect((await patch('/api/v1/portal/profile', { preferredDisplayName: 'nate@x.com' })).statusCode).toBe(400);
    expect((await patch('/api/v1/portal/profile', { preferredDisplayName: 'Ace' })).statusCode).toBe(200);
    expect(JSON.parse((await get('/api/v1/portal/profile')).body).preferredDisplayName).toBe('Ace');
  });
});
