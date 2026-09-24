/**
 * Copy actions — modify/cancel of copied working orders, group flatten, and
 * divergence detection + resync, all through the REAL engine (scripted market).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, copyChildren, copyGroups, orders, positions, ruleTemplates, users } from '../db/schema.js';
import { TradingEngine } from '../trading/engine.js';
import { AtlasSimulationExecutionProvider } from '../execution/provider.js';
import { ScriptedMarket, ACCOUNT_TRADING_DATE } from '../trading/harness.js';
import { defaultOrganizationId } from './provisioning.js';
import { addFollower, createGroup } from './copy-groups.js';
import { cancelCopyIntent, flattenCopyGroup, modifyCopyIntent, submitCopyIntent } from './copy-orchestrator.js';
import { executeResync, groupSyncView } from './copy-divergence.js';

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

async function makeAccount(): Promise<string> {
  const size = 100_000 * M;
  const [tpl] = await db.insert(ruleTemplates).values({
    name: `Act Tpl ${crypto.randomUUID().slice(0, 6)}`, accountType: 'FUNDED_SIM', accountSizeMicros: size,
    profitTargetMicros: 1_000_000 * M, maxLossMicros: size, drawdownType: 'STATIC', trailingLockAtMicros: null,
    dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: null, maxContracts: 50, microsCountAsFraction: false, minTradingDays: 0, minWinningDays: 0,
    maxTradingDays: null, minDailyPnlToCountMicros: 0, flattenOnBreach: true, payoutRules: {},
  }).returning();
  const [a] = await db.insert(accounts).values({
    organizationId, userId, ruleTemplateId: tpl!.id, name: `Act Acct ${crypto.randomUUID().slice(0, 6)}`,
    accountType: 'FUNDED_SIM', status: 'ACTIVE', startingBalanceMicros: size, balanceMicros: size,
    highWaterMarkMicros: size, drawdownFloorMicros: 0, dayStartBalanceMicros: size, dayStartEquityMicros: size,
    currentTradeDate: ACCOUNT_TRADING_DATE, simulationEnvironment: CLEAN_ENV as never, instrumentLimits: null,
  }).returning();
  accountIds.push(a!.id);
  return a!.id;
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  const handle = createDb(url); db = handle.db; sql = handle.sql;
  organizationId = await defaultOrganizationId(db);
  market = new ScriptedMarket();
  engine = new TradingEngine(db, market);
  await engine.start();
  execution = new AtlasSimulationExecutionProvider(engine);
  const [u] = await db.insert(users).values({ email: `copyact-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'Act', organizationId }).returning();
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

async function posQty(accountId: string, symbol = 'NQ'): Promise<number> {
  const [p] = await db.select().from(positions).where(and(eq(positions.accountId, accountId), eq(positions.symbol, symbol)));
  return p?.qty ?? 0;
}
async function followerOrder(intentId: string, accountId: string) {
  const [c] = await db.select().from(copyChildren).where(and(eq(copyChildren.copyIntentId, intentId), eq(copyChildren.accountId, accountId)));
  if (!c?.orderId) return null;
  const [o] = await db.select().from(orders).where(eq(orders.id, c.orderId));
  return o ?? null;
}

describe('modify / cancel copied working orders', () => {
  it('propagates a limit modify and a cancel to the follower order', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount();
    const f1 = await makeAccount();
    const groupId = await createGroup(db, { userId, name: 'WO', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await addFollower(db, { userId, groupId, accountId: f1 });

    // A resting LIMIT BUY far below market (does not fill).
    const submit = await submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 'wo1', order: { symbol: 'NQ', side: 'BUY', qty: 1, type: 'LIMIT', limitPrice: 19_000 } });
    expect(submit.accepted).toBe(2);
    const beforeMod = await followerOrder(submit.intentId, f1);
    expect(beforeMod?.status).toBe('WORKING');

    const mod = await modifyCopyIntent(db, execution, { userId, groupId, originalIntentId: submit.intentId, idempotencyKey: 'wo1-mod', patch: { limitPrice: 19_010 } });
    expect(mod.rejected).toBe(0);
    const afterMod = await followerOrder(submit.intentId, f1);
    expect(afterMod!.limitTicks).not.toBe(beforeMod!.limitTicks); // level moved

    const cancel = await cancelCopyIntent(db, execution, { userId, groupId, originalIntentId: submit.intentId, idempotencyKey: 'wo1-cxl' });
    expect(cancel.rejected).toBe(0);
    const afterCancel = await followerOrder(submit.intentId, f1);
    expect(afterCancel!.status).toBe('CANCELED');
  }, 45000);
});

describe('flatten copy group', () => {
  it('flattens leader and enabled followers independently', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount();
    const f1 = await makeAccount();
    const groupId = await createGroup(db, { userId, name: 'Flat', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await addFollower(db, { userId, groupId, accountId: f1 });
    await submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 'fl1', order: { symbol: 'NQ', side: 'BUY', qty: 2, type: 'MARKET' } });
    expect(await posQty(leader)).toBe(2);
    expect(await posQty(f1)).toBe(2);

    const res = await flattenCopyGroup(db, execution, { userId, groupId, idempotencyKey: 'fl1-flat', symbol: 'NQ' });
    expect(res.rejected).toBe(0);
    expect(await posQty(leader)).toBe(0);
    expect(await posQty(f1)).toBe(0);
  }, 45000);
});

describe('divergence + resync', () => {
  it('detects a manually-flattened follower and resyncs it on request', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount();
    const f1 = await makeAccount();
    const groupId = await createGroup(db, { userId, name: 'Sync', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await addFollower(db, { userId, groupId, accountId: f1 });
    await submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 'sy1', order: { symbol: 'NQ', side: 'BUY', qty: 2, type: 'MARKET' } });

    let view = await groupSyncView(db, userId, groupId);
    expect(view.status).toBe('SYNCED');

    // Trader manually flattens the follower outside copy context.
    await execution.flatten(f1, userId, 'NQ');
    expect(await posQty(f1)).toBe(0);
    view = await groupSyncView(db, userId, groupId);
    expect(view.status).toBe('DIVERGED');
    const d = view.followers.find((x) => x.accountId === f1)!;
    expect(d.expectedQty).toBe(2);
    expect(d.actualQty).toBe(0);
    expect(d.deltaQty).toBe(2);
    expect(d.side).toBe('BUY');

    // Resync closes the gap through the normal pipeline.
    const results = await executeResync(db, execution, { userId, groupId, idempotencyKey: 'sy1-resync' });
    expect(results.every((r) => r.rejected === 0)).toBe(true);
    expect(await posQty(f1)).toBe(2);
    view = await groupSyncView(db, userId, groupId);
    expect(view.status).toBe('SYNCED');
  }, 45000);
});
