/**
 * Firm exposure: minis and micros are never combined, and quantities are
 * correct contracts.
 *
 * The bug this guards is aggregating NQ and MNQ (or ES/MES, GC/MGC, CL/MCL) into
 * one contract count as if a $20/point mini and a $2/point micro were the same
 * instrument. They are separate buckets with separate point values, always.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { accounts, positions, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { projectAccount } from './projection.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
let adminToken: string;
const users_: string[] = [];
const KEY = `exposure-eval-${Math.random().toString(36).slice(2, 8)}`;

async function makeUser(role: string): Promise<string> {
  const email = `exp-${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [u] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword('exposure-test-pw'), displayName: role, role, organizationId })
    .returning();
  users_.push(u!.id);
  return u!.id;
}

async function tokenFor(userId: string): Promise<string> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u!.email, password: 'exposure-test-pw' } });
  return JSON.parse(login.body).accessToken;
}

async function accountWithPositions(
  pos: Array<{ symbol: string; side: 'LONG' | 'SHORT'; qty: number }>,
): Promise<string> {
  const userId = await makeUser('TRADER');
  const { accountId } = await provisionAccount(db, { organizationId, userId, profileKey: KEY });
  for (const p of pos) {
    await db.insert(positions).values({
      accountId,
      symbol: p.symbol,
      side: p.side,
      qty: p.side === 'SHORT' ? -Math.abs(p.qty) : Math.abs(p.qty),
      costBasisMicros: p.qty * 1000 * M,
    });
  }
  await projectAccount(db, accountId);
  return accountId;
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
    name: 'Exposure Eval',
    accountType: 'EVALUATION',
    config: {
      rules: {
        accountSizeMicros: 50_000 * M,
        profitTargetMicros: 3_000 * M,
        maxLossMicros: 2_000 * M,
        drawdownType: 'STATIC',
        trailingLockAtMicros: null,
        dailyLossLimitMicros: null,
        dailyLossPolicy: 'LOCK_DAY',
        consistencyFormula: 'BEST_DAY_OVER_TOTAL',
        consistencyThreshold: null,
        minTradingDays: 0,
        minWinningDays: 0,
        maxTradingDays: null,
        minDailyPnlToCountMicros: 0,
        minWinningDayPnlMicros: 1,
        maxContracts: 50,
        microsCountAsFraction: true,
        flattenOnBreach: true,
      },
      execution: null,
      instruments: { allowed: null, maxContracts: 50, perInstrument: {} },
      display: { startingBalanceMicros: 50_000 * M },
      payoutRules: null,
    },
  });
  adminToken = await tokenFor(await makeUser('ADMIN'));
});

afterAll(async () => {
  if (users_.length > 0) {
    const owned = await db.select({ id: accounts.id }).from(accounts).where(inArray(accounts.userId, users_));
    const ids = owned.map((a) => a.id);
    if (ids.length > 0) await db.delete(positions).where(inArray(positions.accountId, ids));
  }
  for (const id of users_) await db.delete(users).where(eq(users.id, id));
  await app.close();
});

describe('firm exposure', () => {
  it('keeps minis and micros in separate buckets with their own point values', async () => {
    // Account A: NQ +5 long, MNQ -3 short. Account B: NQ -2 short.
    await accountWithPositions([
      { symbol: 'NQ', side: 'LONG', qty: 5 },
      { symbol: 'MNQ', side: 'SHORT', qty: 3 },
    ]);
    await accountWithPositions([{ symbol: 'NQ', side: 'SHORT', qty: 2 }]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/exposure',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const bySymbol = new Map<string, Record<string, number>>(
      (JSON.parse(res.body).symbols as Array<Record<string, number> & { symbol: string }>).map((s) => [s.symbol, s]),
    );

    const nq = bySymbol.get('NQ')!;
    const mnq = bySymbol.get('MNQ')!;
    expect(nq).toBeTruthy();
    expect(mnq).toBeTruthy();
    // NQ and MNQ are DISTINCT buckets — never summed.
    expect(nq.symbol).toBe('NQ');
    expect(mnq.symbol).toBe('MNQ');
    // NQ: gross long 5, gross short 2, net +3.
    expect(nq.grossLong).toBe(5);
    expect(nq.grossShort).toBe(2);
    expect(nq.net).toBe(3);
    // MNQ: gross short 3, net -3.
    expect(mnq.grossShort).toBe(3);
    expect(mnq.net).toBe(-3);
    // Point values are the instrument registry's, and differ 10x.
    expect(nq.pointValueMicros).toBe(20_000_000);
    expect(mnq.pointValueMicros).toBe(2_000_000);
  });

  it('refuses exposure to a trader', async () => {
    const trader = await tokenFor(await makeUser('TRADER'));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/exposure',
      headers: { authorization: `Bearer ${trader}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
