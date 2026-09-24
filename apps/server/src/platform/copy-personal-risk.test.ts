/**
 * Copy trading × personal risk controls (M5-H). Each copied child order enters
 * its own follower account's normal risk pipeline → its own personal gate. One
 * follower's personal rejection never rolls back the leader or other followers.
 * No special "copy risk" logic — personal controls belong to each account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, copyGroups, positions, ruleTemplates, users } from '../db/schema.js';
import { TradingEngine } from '../trading/engine.js';
import { AtlasSimulationExecutionProvider } from '../execution/provider.js';
import { ScriptedMarket, OPEN_MARKET_TS, ACCOUNT_TRADING_DATE } from '../trading/harness.js';
import { defaultOrganizationId } from './provisioning.js';
import { addFollower, createGroup } from './copy-groups.js';
import { submitCopyIntent } from './copy-orchestrator.js';
import { upsertPersonalControl } from './personal-risk.js';

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
    name: `CPR Tpl ${crypto.randomUUID().slice(0, 6)}`, accountType: 'FUNDED_SIM', accountSizeMicros: size,
    profitTargetMicros: 1_000_000 * M, maxLossMicros: size, drawdownType: 'STATIC', trailingLockAtMicros: null,
    dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: null, maxContracts: 50, microsCountAsFraction: false, minTradingDays: 0, minWinningDays: 0,
    maxTradingDays: null, minDailyPnlToCountMicros: 0, flattenOnBreach: true, payoutRules: {},
  }).returning();
  const [a] = await db.insert(accounts).values({
    organizationId, userId, ruleTemplateId: tpl!.id, name: `CPR Acct ${crypto.randomUUID().slice(0, 6)}`,
    accountType: 'FUNDED_SIM', status: 'ACTIVE', startingBalanceMicros: size, balanceMicros: size,
    highWaterMarkMicros: size, drawdownFloorMicros: 0, dayStartBalanceMicros: size, dayStartEquityMicros: size,
    currentTradeDate: ACCOUNT_TRADING_DATE, simulationEnvironment: CLEAN_ENV as never, instrumentLimits: null,
  }).returning();
  accountIds.push(a!.id);
  return a!.id;
}

async function posQty(accountId: string): Promise<number> {
  const [p] = await db.select({ qty: positions.qty }).from(positions).where(eq(positions.accountId, accountId));
  return p?.qty ?? 0;
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  const handle = createDb(url); db = handle.db; sql = handle.sql;
  organizationId = await defaultOrganizationId(db);
  market = new ScriptedMarket();
  engine = new TradingEngine(db, market);
  await engine.start();
  execution = new AtlasSimulationExecutionProvider(engine);
  const [u] = await db.insert(users).values({ email: `cpr-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'CPR', organizationId }).returning();
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

describe('copy trading respects each follower’s personal controls (M5-H)', () => {
  it('a follower personal rejection isolates to that child; others are unaffected', async () => {
    await market.quote('NQ', 20_000, OPEN_MARKET_TS);
    const leader = await makeAccount();
    const a = await makeAccount(); // no controls → accepted
    const b = await makeAccount(); // max trades reached → rejected
    const c = await makeAccount(); // no controls → accepted
    const d = await makeAccount(); // outside trading window → rejected

    // B: cap at 1 trade, then pre-open one so the copied order is at the cap.
    await upsertPersonalControl(db, { accountId: b, ownerUserId: userId, actorUserId: userId, controlType: 'MAX_TRADES', enabled: true, mode: 'FLEXIBLE', value: { valueInt: 1 } });
    await engine.submitOrder({ accountId: b, userId, clientOrderId: `pre-${b}`, symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' });
    // D: a trading window that excludes the market time (10:00 CT at OPEN_MARKET_TS).
    await upsertPersonalControl(db, { accountId: d, ownerUserId: userId, actorUserId: userId, controlType: 'TRADING_WINDOW', enabled: true, mode: 'FLEXIBLE', value: { windowStart: '11:00', windowEnd: '12:00' } });

    const groupId = await createGroup(db, { userId, name: 'PR Fan', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await addFollower(db, { userId, groupId, accountId: a });
    await addFollower(db, { userId, groupId, accountId: b });
    await addFollower(db, { userId, groupId, accountId: c });
    await addFollower(db, { userId, groupId, accountId: d });

    const res = await submitCopyIntent(db, execution, {
      userId, groupId, idempotencyKey: 'pr-fan-1',
      order: { symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' },
    });

    const byAcct = new Map(res.children.map((ch) => [ch.accountId, ch]));
    expect(byAcct.get(leader)!.status).toBe('ACCEPTED');
    expect(byAcct.get(a)!.status).toBe('ACCEPTED');
    expect(byAcct.get(c)!.status).toBe('ACCEPTED');
    expect(byAcct.get(b)!.status).toBe('REJECTED');
    expect(byAcct.get(b)!.rejectCode).toBe('PERSONAL_MAX_TRADES');
    expect(byAcct.get(d)!.status).toBe('REJECTED');
    expect(byAcct.get(d)!.rejectCode).toBe('PERSONAL_TRADING_WINDOW');

    // No rollback: accepted followers and the leader keep their fills.
    expect(await posQty(leader)).toBe(1);
    expect(await posQty(a)).toBe(1);
    expect(await posQty(c)).toBe(1);
    // B kept only its pre-open (copy rejected, not applied). D never opened.
    expect(await posQty(b)).toBe(1);
    expect(await posQty(d)).toBe(0);
  }, 45000);
});
