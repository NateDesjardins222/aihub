/**
 * Copy-trading HTTP surface — CRUD, ownership/IDOR, validation and the fan-out
 * wiring, against the real app. (Fill behaviour is proven in the orchestrator
 * integration test with the scripted engine; here we prove the routes are
 * owner-scoped and correctly wired.)
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
let otherAccountId: string;
const users_: string[] = [];
const EVAL_KEY = `copyrt-eval-${Math.random().toString(36).slice(2, 8)}`;
const leaderAndFollowers: string[] = [];

function cfg() {
  return {
    rules: { accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M, drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: 50_000 * M }, payoutRules: null, fundedDestinationKey: null,
  };
}
async function makeUser(): Promise<{ id: string; email: string }> {
  const email = `copyrt-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [u] = await db.insert(users).values({ email, passwordHash: await hashPassword('cpw'), displayName: 'Copy RT', organizationId }).returning();
  users_.push(u!.id);
  return { id: u!.id, email };
}
async function tokenFor(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'cpw' } });
  return JSON.parse(res.body).accessToken;
}
async function acct(userId: string): Promise<string> {
  const p = await resolveProfileByKey(db, organizationId, EVAL_KEY);
  return (await provisionAccount(db, { organizationId, userId, profileVersionId: p.versionId, activate: true })).accountId;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'false';
  app = (await buildApp()).app; await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'Copy RT Eval', accountType: 'EVALUATION', config: cfg() });
  const me = await makeUser(); const other = await makeUser();
  token = await tokenFor(me.email); otherToken = await tokenFor(other.email);
  for (let i = 0; i < 3; i += 1) leaderAndFollowers.push(await acct(me.id));
  otherAccountId = await acct(other.id);
});
afterAll(async () => { if (users_.length) await db.delete(users).where(inArray(users.id, users_)); await app.close(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const get = (u: string, t = token) => app.inject({ method: 'GET', url: u, headers: auth(t) });
const post = (u: string, b: Record<string, unknown>, t = token) => app.inject({ method: 'POST', url: u, headers: auth(t), payload: b });
const patch = (u: string, b: Record<string, unknown>, t = token) => app.inject({ method: 'PATCH', url: u, headers: auth(t), payload: b });
const del = (u: string, t = token) => app.inject({ method: 'DELETE', url: u, headers: auth(t) });

describe('copy trading routes', () => {
  let groupId: string;

  it('lists eligible accounts and creates a group with an owned leader', async () => {
    const elig = JSON.parse((await get('/api/v1/copy/eligible-accounts')).body);
    expect(elig.accounts.length).toBeGreaterThanOrEqual(3);
    const res = await post('/api/v1/copy/groups', { name: 'My Copy', leaderAccountId: leaderAndFollowers[0], sizingMode: 'MULTIPLIER' });
    expect(res.statusCode).toBe(201);
    const g = JSON.parse(res.body);
    groupId = g.id;
    expect(g.leader.accountId).toBe(leaderAndFollowers[0]);
  });

  it('rejects a leader the caller does not own (no IDOR)', async () => {
    const res = await post('/api/v1/copy/groups', { name: 'Bad', leaderAccountId: otherAccountId });
    expect(res.statusCode).toBe(404);
  });

  it('adds/updates/removes followers with sizing', async () => {
    expect((await post(`/api/v1/copy/groups/${groupId}/followers`, { accountId: leaderAndFollowers[1], sizingMultiplierMilli: 500 })).statusCode).toBe(201);
    const g = JSON.parse((await patch(`/api/v1/copy/groups/${groupId}/followers/${leaderAndFollowers[1]}`, { enabled: false })).body);
    expect(g.followers[0].enabled).toBe(false);
    const g2 = JSON.parse((await del(`/api/v1/copy/groups/${groupId}/followers/${leaderAndFollowers[1]}`)).body);
    expect(g2.followers).toHaveLength(0);
  });

  it('cannot add a follower the caller does not own', async () => {
    expect((await post(`/api/v1/copy/groups/${groupId}/followers`, { accountId: otherAccountId })).statusCode).toBe(404);
  });

  it('another trader cannot see or mutate the group', async () => {
    expect((await get(`/api/v1/copy/groups/${groupId}`, otherToken)).statusCode).toBe(404);
    expect((await post(`/api/v1/copy/groups/${groupId}/pause`, {}, otherToken)).statusCode).toBe(404);
  });

  it('pauses, refuses intents while paused, then resumes', async () => {
    expect(JSON.parse((await post(`/api/v1/copy/groups/${groupId}/pause`, {})).body).status).toBe('PAUSED');
    const blocked = await post(`/api/v1/copy/groups/${groupId}/intents`, { idempotencyKey: 'x1', order: { symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' } });
    expect(blocked.statusCode).toBe(400);
    expect(JSON.parse((await post(`/api/v1/copy/groups/${groupId}/resume`, {})).body).status).toBe('ACTIVE');
  });

  it('accepts an intent and fans out one child per member (leader + follower)', async () => {
    await post(`/api/v1/copy/groups/${groupId}/followers`, { accountId: leaderAndFollowers[2], sizingMultiplierMilli: 1000 });
    const res = await post(`/api/v1/copy/groups/${groupId}/intents`, { idempotencyKey: 'i1', order: { symbol: 'NQ', side: 'BUY', qty: 2, type: 'MARKET' } });
    expect(res.statusCode).toBe(201);
    const out = JSON.parse(res.body);
    expect(out.total).toBe(2); // leader + one enabled follower
    // Idempotent replay over HTTP returns the same intent.
    const again = JSON.parse((await post(`/api/v1/copy/groups/${groupId}/intents`, { idempotencyKey: 'i1', order: { symbol: 'NQ', side: 'BUY', qty: 2, type: 'MARKET' } })).body);
    expect(again.intentId).toBe(out.intentId);
    expect(again.reused).toBe(true);
  });

  it('exposes the derived sync view and recent intents', async () => {
    const sync = JSON.parse((await get(`/api/v1/copy/groups/${groupId}/sync`)).body);
    expect(['SYNCED', 'DIVERGED', 'PAUSED']).toContain(sync.status);
    const intents = JSON.parse((await get(`/api/v1/copy/groups/${groupId}/intents`)).body);
    expect(intents.intents.length).toBeGreaterThanOrEqual(1);
  });
});
