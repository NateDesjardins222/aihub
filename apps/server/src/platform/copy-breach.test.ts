/**
 * Copy-trading breach behaviour (CT-I, docs/copy-trading-failure-modes-v1.md).
 *
 *  - A leader breach (account.failed / account.locked) PAUSES the group at once
 *    and never promotes a follower; pausing flattens nothing.
 *  - The submit path guards the same thing: an ineligible leader pauses the
 *    group and refuses the intent.
 *  - A follower breach ISOLATES that follower (its child is rejected by its own
 *    risk pipeline) while the leader and the other followers keep trading and
 *    the group stays ACTIVE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, copyGroups, ruleTemplates, users } from '../db/schema.js';
import { TradingEngine } from '../trading/engine.js';
import { AtlasSimulationExecutionProvider } from '../execution/provider.js';
import { ScriptedMarket, ACCOUNT_TRADING_DATE } from '../trading/harness.js';
import { defaultOrganizationId } from './provisioning.js';
import { addFollower, createGroup, getGroupView } from './copy-groups.js';
import { submitCopyIntent } from './copy-orchestrator.js';
import { attachCopyBreachHandler } from './copy-breach.js';
import { events } from './events.js';

const M = 1_000_000;
const CLEAN_ENV = { fillModel: 'SIMPLE' as const, latencyMs: 0, marketSlippageTicks: 0, stopSlippageTicks: 0, requireThroughTradeForLimit: false, feesEnabled: false, useBarRange: true };

let db: Database;
let sql: ReturnType<typeof createDb>['sql'];
let market: ScriptedMarket;
let engine: TradingEngine;
let execution: AtlasSimulationExecutionProvider;
let organizationId: string;
let userId: string;
let detach: () => void;
const accountIds: string[] = [];

async function makeAccount(): Promise<string> {
  const size = 100_000 * M;
  const [tpl] = await db.insert(ruleTemplates).values({
    name: `Breach Tpl ${crypto.randomUUID().slice(0, 6)}`, accountType: 'FUNDED_SIM', accountSizeMicros: size,
    profitTargetMicros: 1_000_000 * M, maxLossMicros: size, drawdownType: 'STATIC', trailingLockAtMicros: null,
    dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: null, maxContracts: 50, microsCountAsFraction: false, minTradingDays: 0, minWinningDays: 0,
    maxTradingDays: null, minDailyPnlToCountMicros: 0, flattenOnBreach: true, payoutRules: {},
  }).returning();
  const [a] = await db.insert(accounts).values({
    organizationId, userId, ruleTemplateId: tpl!.id, name: `Breach Acct ${crypto.randomUUID().slice(0, 6)}`,
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
  detach = attachCopyBreachHandler(db);
  const [u] = await db.insert(users).values({ email: `copybreach-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'Breach', organizationId }).returning();
  userId = u!.id;
});

afterAll(async () => {
  detach();
  engine.stop();
  if (accountIds.length > 0) {
    await db.delete(copyGroups).where(eq(copyGroups.userId, userId));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
  await db.delete(users).where(eq(users.id, userId));
  await sql.end({ timeout: 5 });
});

describe('leader breach pauses the group', () => {
  it('pauses the ACTIVE group led by an account that fails — no follower promotion', async () => {
    const leader = await makeAccount();
    const f1 = await makeAccount();
    const groupId = await createGroup(db, { userId, name: 'Breach L', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await addFollower(db, { userId, groupId, accountId: f1 });
    expect((await getGroupView(db, userId, groupId)).status).toBe('ACTIVE');

    // The engine/lifecycle announces the leader failed. The bystander subscriber
    // (awaited by the bus) pauses the group.
    await events.publish(db, { type: 'account.failed', organizationId, accountId: leader, userId, payload: {} });

    const view = await getGroupView(db, userId, groupId);
    expect(view.status).toBe('PAUSED');
    // The leader is unchanged in the group (no silent promotion of the follower).
    expect(view.leader?.accountId).toBe(leader);
    expect(view.followers.map((f) => f.accountId)).toEqual([f1]);
  }, 30000);

  it('an account.locked leader also pauses the group', async () => {
    const leader = await makeAccount();
    const groupId = await createGroup(db, { userId, name: 'Breach Lock', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await events.publish(db, { type: 'account.locked', organizationId, accountId: leader, userId, payload: {} });
    expect((await getGroupView(db, userId, groupId)).status).toBe('PAUSED');
  }, 30000);
});

describe('submit-time leader guard', () => {
  it('refuses an intent and pauses when the leader is no longer eligible', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount();
    const f1 = await makeAccount();
    const groupId = await createGroup(db, { userId, name: 'Guard', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await addFollower(db, { userId, groupId, accountId: f1 });

    // Leader becomes ineligible out of band.
    await db.update(accounts).set({ status: 'FAILED', failedReason: 'MLL' }).where(eq(accounts.id, leader));

    await expect(
      submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 'guard1', order: { symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' } }),
    ).rejects.toThrow(/no longer eligible/i);
    expect((await getGroupView(db, userId, groupId)).status).toBe('PAUSED');
  }, 30000);
});

describe('follower breach isolates the follower', () => {
  it('rejects only the breached follower and keeps the group trading', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount();
    const good = await makeAccount();
    const bad = await makeAccount();
    const groupId = await createGroup(db, { userId, name: 'Isolate', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await addFollower(db, { userId, groupId, accountId: good });
    await addFollower(db, { userId, groupId, accountId: bad });

    // One follower breaches (locked) but stays enabled in the group.
    await db.update(accounts).set({ status: 'LOCKED', failedReason: 'DAILY' }).where(eq(accounts.id, bad));

    const res = await submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 'iso1', order: { symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' } });
    // Leader + good follower accepted; bad follower rejected — isolated, not fatal.
    expect(res.accepted).toBe(2);
    expect(res.rejected).toBe(1);
    const badChild = res.children.find((c) => c.accountId === bad)!;
    expect(badChild.status).toBe('REJECTED');
    // The group is still ACTIVE — a follower breach does not stop the group.
    expect((await getGroupView(db, userId, groupId)).status).toBe('ACTIVE');
  }, 30000);
});
