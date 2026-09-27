/**
 * Product Recovery Phase 2 — WRONG-ACCOUNT / CROSS-CUSTOMER EXECUTION SAFETY
 * (STEP 9), proven at the REAL HTTP order boundary.
 *
 * The order path trusts the accountId in the request body; the ONLY thing that
 * stops one customer executing on another's account is `assertOwnership` on the
 * route. Phase-1/2 mapping found this guard had NO test and NO test drove
 * POST /orders at all. This closes that gap over HTTP against real Postgres:
 *
 *  - a trader submitting an order/flatten for ANOTHER identity's account is hard
 *    rejected (404 ACCOUNT_NOT_FOUND) and that account is left completely
 *    untouched (no order, no execution, no position);
 *  - a trader submitting for their OWN account passes the ownership gate;
 *  - an unauthenticated caller is rejected.
 *
 * Any cross-customer execution here would be a HARD-STOP P0.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { accounts, ruleTemplates, users, orders as ordersTable, executions as executionsTable, positions as positionsTable } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';

const PASSWORD = 'trading-authz-pw-2026';
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
const cleanup: string[] = [];

interface Trader { userId: string; token: string; accountId: string; email: string }

async function makeTrader(): Promise<Trader> {
  const suffix = randomUUID().slice(0, 8);
  const email = `authz-${suffix}@test.local`;
  const [user] = await db.insert(users).values({
    email, passwordHash: await hashPassword(PASSWORD), displayName: `Authz ${suffix}`, role: 'TRADER',
  }).returning();
  const size = 50_000 * 1_000_000;
  const [tpl] = await db.insert(ruleTemplates).values({
    name: `Authz ${suffix}`, accountType: 'PRACTICE', accountSizeMicros: size,
    profitTargetMicros: 3_000 * 1_000_000, maxLossMicros: 2_000 * 1_000_000,
    drawdownType: 'STATIC', consistencyFormula: 'BEST_DAY_OVER_TOTAL', maxContracts: 5,
    microsCountAsFraction: false, payoutRules: {},
  }).returning();
  const [acct] = await db.insert(accounts).values({
    userId: user!.id, ruleTemplateId: tpl!.id, name: `Authz ${suffix}`, accountType: 'PRACTICE',
    status: 'ACTIVE', startingBalanceMicros: size, balanceMicros: size, highWaterMarkMicros: size,
    drawdownFloorMicros: size - 2_000 * 1_000_000, dayStartBalanceMicros: size, dayStartEquityMicros: size,
    currentTradeDate: '2026-09-15',
  }).returning();
  cleanup.push(user!.id);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  return { userId: user!.id, token: JSON.parse(res.body).accessToken as string, accountId: acct!.id, email };
}

function order(token: string | null, accountId: string) {
  return app.inject({
    method: 'POST', url: '/api/v1/orders',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { accountId, clientOrderId: randomUUID(), symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' },
  });
}

async function countFor(accountId: string): Promise<{ orders: number; execs: number; positions: number }> {
  const o = await db.select().from(ordersTable).where(eq(ordersTable.accountId, accountId));
  const e = await db.select().from(executionsTable).where(eq(executionsTable.accountId, accountId));
  const p = await db.select().from(positionsTable).where(eq(positionsTable.accountId, accountId));
  return { orders: o.length, execs: e.length, positions: p.filter((r) => Number((r as Record<string, unknown>)['qty']) !== 0).length };
}

beforeAll(async () => { app = (await buildApp()).app; await app.ready(); db = getDb().db; });
afterAll(async () => {
  for (const id of cleanup) await db.delete(users).where(eq(users.id, id)).catch(() => {});
  await app.close();
});

let A: Trader; let B: Trader;
beforeEach(async () => { A = await makeTrader(); B = await makeTrader(); });

describe('wrong-account / cross-customer execution safety (real HTTP order path)', () => {
  it('a trader CANNOT submit an order for another identity\'s account, and that account is untouched', async () => {
    const before = await countFor(B.accountId);
    const res = await order(A.token, B.accountId); // A's token, B's account
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('ACCOUNT_NOT_FOUND');
    const after = await countFor(B.accountId);
    expect(after).toEqual(before); // B has no new order / execution / position
    expect(after.orders).toBe(0);
    expect(after.execs).toBe(0);
    expect(after.positions).toBe(0);
  });

  it('a trader CANNOT flatten a position on another identity\'s account', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/positions/NQ/flatten',
      headers: { authorization: `Bearer ${A.token}` }, payload: { accountId: B.accountId },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('a trader submitting for their OWN account passes the ownership gate (not a 404)', async () => {
    const res = await order(A.token, A.accountId);
    // Ownership passed: the request is NOT rejected as ACCOUNT_NOT_FOUND. It may
    // still be 201 (filled) or 422 (e.g. market data unavailable in a headless
    // test), but never the cross-account 404 — that is the authorization proof.
    expect(res.statusCode).not.toBe(404);
    if (res.statusCode === 422) {
      expect(JSON.parse(res.body).error.code).not.toBe('ACCOUNT_NOT_FOUND');
    }
  });

  it('an unauthenticated caller cannot submit an order', async () => {
    const res = await order(null, A.accountId);
    expect([401, 403]).toContain(res.statusCode);
  });
});
