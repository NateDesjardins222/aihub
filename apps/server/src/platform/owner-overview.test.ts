/**
 * Overview lifecycle metrics and the account "why locked" reason.
 *
 * Asserts the metric block is present and integer, and that an account's lock
 * reason reflects authoritative status (the same status the order gate reads) —
 * never an opaque label, never a fabricated "tradeable" for a failed account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { accounts, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
let adminToken: string;
const users_: string[] = [];
const KEY = `ov-eval-${Math.random().toString(36).slice(2, 8)}`;

async function makeUser(role: string): Promise<{ id: string; email: string }> {
  const email = `ov-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [u] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword('ov-test-pw'), displayName: role, role, organizationId })
    .returning();
  users_.push(u!.id);
  return { id: u!.id, email };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, {
    organizationId,
    key: KEY,
    name: 'Overview Eval',
    accountType: 'EVALUATION',
    config: {
      rules: {
        accountSizeMicros: 50_000 * M, profitTargetMicros: 3_000 * M, maxLossMicros: 2_000 * M,
        drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null,
        dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null,
        minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0,
        minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true,
      },
      execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
      display: { startingBalanceMicros: 50_000 * M }, payoutRules: null,
    },
  });
  const admin = await makeUser('ADMIN');
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: admin.email, password: 'ov-test-pw' } });
  adminToken = JSON.parse(login.body).accessToken;
});

afterAll(async () => {
  for (const id of users_) await db.delete(users).where(eq(users.id, id));
  await app.close();
});

const auth = () => ({ authorization: `Bearer ${adminToken}` });

describe('overview lifecycle metrics', () => {
  it('returns an integer lifecycle block', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/overview', headers: auth() });
    expect(res.statusCode).toBe(200);
    const life = JSON.parse(res.body).lifecycle;
    for (const key of ['activeEvaluations', 'fundedSim', 'passedEvaluations', 'awaitingFunding', 'passedToday', 'failedToday']) {
      expect(Number.isInteger(life[key])).toBe(true);
      expect(life[key]).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.parse(res.body).accounts.byType).toBeTruthy();
  });
});

describe('account "why locked"', () => {
  it('is tradeable when ACTIVE and states an explicit reason when FAILED', async () => {
    const trader = await makeUser('TRADER');
    const { accountId } = await provisionAccount(db, { organizationId, userId: trader.id, profileKey: KEY });

    const active = await app.inject({ method: 'GET', url: `/api/v1/admin/accounts/${accountId}`, headers: auth() });
    expect(JSON.parse(active.body).lockReason).toMatchObject({ canTrade: true, reason: 'TRADEABLE' });

    await db.update(accounts).set({ status: 'FAILED', failedReason: 'MAX_LOSS_LIMIT' }).where(eq(accounts.id, accountId));
    const failed = await app.inject({ method: 'GET', url: `/api/v1/admin/accounts/${accountId}`, headers: auth() });
    expect(JSON.parse(failed.body).lockReason).toMatchObject({
      canTrade: false,
      reason: 'FAILED',
      detail: 'MAX_LOSS_LIMIT',
    });
  });
});
