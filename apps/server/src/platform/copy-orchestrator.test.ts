/**
 * Copy orchestrator — one intent fans out to independent account executions
 * through the REAL trading engine (scripted market), with sizing, partial
 * rejection, skip, idempotency and per-account isolation. No mock engine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, copyChildren, copyGroups, orders, positions, ruleTemplates, users } from '../db/schema.js';
import { TradingEngine } from '../trading/engine.js';
import { AtlasSimulationExecutionProvider } from '../execution/provider.js';
import { ScriptedMarket, ACCOUNT_TRADING_DATE } from '../trading/harness.js';
import { defaultOrganizationId } from './provisioning.js';
import { addFollower, createGroup, updateFollower } from './copy-groups.js';
import { submitCopyIntent } from './copy-orchestrator.js';

const M = 1_000_000;
const CLEAN_ENV = { fillModel: 'SIMPLE' as const, latencyMs: 0, marketSlippageTicks: 0, stopSlippageTicks: 0, requireThroughTradeForLimit: false, feesEnabled: false, useBarRange: true };

let db: Database;
let sql: ReturnType<typeof createDb>['sql'];
let market: ScriptedMarket;
let engine: TradingEngine;
let execution: AtlasSimulationExecutionProvider;
let organizationId: string;
let userId: string;
const accountIds: string[] = [];

async function makeAccount(maxContracts: number): Promise<string> {
  const size = 100_000 * M;
  const [tpl] = await db.insert(ruleTemplates).values({
    name: `Copy Tpl ${crypto.randomUUID().slice(0, 6)}`, accountType: 'FUNDED_SIM', accountSizeMicros: size,
    profitTargetMicros: 1_000_000 * M, maxLossMicros: size, drawdownType: 'STATIC', trailingLockAtMicros: null,
    dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: null, maxContracts, microsCountAsFraction: false, minTradingDays: 0, minWinningDays: 0,
    maxTradingDays: null, minDailyPnlToCountMicros: 0, flattenOnBreach: true, payoutRules: {},
  }).returning();
  const [a] = await db.insert(accounts).values({
    organizationId, userId, ruleTemplateId: tpl!.id, name: `Copy Acct ${crypto.randomUUID().slice(0, 6)}`,
    accountType: 'FUNDED_SIM', status: 'ACTIVE', startingBalanceMicros: size, balanceMicros: size,
    highWaterMarkMicros: size, drawdownFloorMicros: 0, dayStartBalanceMicros: size, dayStartEquityMicros: size,
    currentTradeDate: ACCOUNT_TRADING_DATE, simulationEnvironment: CLEAN_ENV as never, instrumentLimits: null,
  }).returning();
  accountIds.push(a!.id);
  return a!.id;
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  const handle = createDb(url);
  db = handle.db; sql = handle.sql;
  organizationId = await defaultOrganizationId(db);
  market = new ScriptedMarket();
  engine = new TradingEngine(db, market);
  await engine.start();
  execution = new AtlasSimulationExecutionProvider(engine);
  const [u] = await db.insert(users).values({ email: `copyorch-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'Copy', organizationId }).returning();
  userId = u!.id;
});

afterAll(async () => {
  engine.stop();
  if (accountIds.length > 0) {
    await db.delete(copyGroups).where(eq(copyGroups.userId, userId));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
  await db.delete(users).where(eq(users.id, userId));
  await sql.end({ timeout: 5 });
});

async function posQty(accountId: string): Promise<number> {
  const [p] = await db.select().from(positions).where(and(eq(positions.accountId, accountId), eq(positions.symbol, 'NQ')));
  return p?.qty ?? 0;
}
async function orderCount(accountId: string): Promise<number> {
  const rows = await db.select({ id: orders.id }).from(orders).where(eq(orders.accountId, accountId));
  return rows.length;
}

describe('copy fan-out through the real engine', () => {
  it('one MARKET intent fans out with sizing, partial rejection and skip; accounts stay isolated', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount(50);
    const f1 = await makeAccount(50); // x1.0 → 2
    const f2 = await makeAccount(50); // x0.5 → 1
    const f3 = await makeAccount(50); // x0.25 → floor(0.5)=0 → SKIP
    const f4 = await makeAccount(1); // x2.0 → 4 but cap 1 → REJECT

    const groupId = await createGroup(db, { userId, name: 'Fan', leaderAccountId: leader, sizingMode: 'MULTIPLIER', organizationId });
    await addFollower(db, { userId, groupId, accountId: f1, sizingMultiplierMilli: 1000 });
    await addFollower(db, { userId, groupId, accountId: f2, sizingMultiplierMilli: 500 });
    await addFollower(db, { userId, groupId, accountId: f3, sizingMultiplierMilli: 250 });
    await addFollower(db, { userId, groupId, accountId: f4, sizingMultiplierMilli: 2000 });

    const res = await submitCopyIntent(db, execution, {
      userId, groupId, idempotencyKey: 'k1',
      order: { symbol: 'NQ', side: 'BUY', qty: 2, type: 'MARKET' },
    });

    expect(res.total).toBe(5);
    expect(res.accepted).toBe(3); // leader + f1 + f2
    expect(res.skipped).toBe(1); // f3
    expect(res.rejected).toBe(1); // f4
    const byAcct = new Map(res.children.map((c) => [c.accountId, c]));
    expect(byAcct.get(leader)!.status).toBe('ACCEPTED');
    expect(byAcct.get(f4)!.status).toBe('REJECTED');
    expect(byAcct.get(f4)!.rejectCode).toBe('MAX_CONTRACTS_EXCEEDED');
    expect(byAcct.get(f3)!.status).toBe('SKIPPED');

    // Positions reflect independent, correctly-sized fills.
    expect(await posQty(leader)).toBe(2);
    expect(await posQty(f1)).toBe(2);
    expect(await posQty(f2)).toBe(1);
    expect(await posQty(f3)).toBe(0);
    expect(await posQty(f4)).toBe(0); // rejected — no position, no leakage
  }, 45000);

  it('is idempotent: the same key does not fan out twice', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount(50);
    const f1 = await makeAccount(50);
    const groupId = await createGroup(db, { userId, name: 'Idem', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await addFollower(db, { userId, groupId, accountId: f1 });

    const first = await submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 'dup', order: { symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' } });
    const second = await submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 'dup', order: { symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' } });

    expect(second.reused).toBe(true);
    expect(first.intentId).toBe(second.intentId);
    expect(await posQty(leader)).toBe(1); // not 2
    expect(await orderCount(leader)).toBe(1); // exactly one order
    expect(await orderCount(f1)).toBe(1);
  }, 45000);

  it('concurrent identical submits collapse to one intent and one order per account', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount(50);
    const f1 = await makeAccount(50);
    const groupId = await createGroup(db, { userId, name: 'Race', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await addFollower(db, { userId, groupId, accountId: f1 });

    const [a, b] = await Promise.all([
      submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 'race', order: { symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' } }),
      submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 'race', order: { symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' } }),
    ]);
    expect(a.intentId).toBe(b.intentId);
    const intents = await db.select({ id: copyGroups.id }).from(copyGroups).where(eq(copyGroups.id, groupId));
    expect(intents).toHaveLength(1);
    expect(await orderCount(leader)).toBe(1);
    expect(await posQty(leader)).toBe(1);
    // exactly one child per account for the single intent
    const kids = await db.select().from(copyChildren).where(eq(copyChildren.copyIntentId, a.intentId));
    expect(kids).toHaveLength(2);
  }, 45000);

  it('a paused group refuses new intents', async () => {
    const leader = await makeAccount(50);
    const groupId = await createGroup(db, { userId, name: 'Paused', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await db.update(copyGroups).set({ status: 'PAUSED' }).where(eq(copyGroups.id, groupId));
    await expect(
      submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 'p1', order: { symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' } }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  }, 30000);
});
