/**
 * Copy-trading torture (CT-L) — one leader + four followers through the REAL
 * engine (scripted market), exercising the invariants the milestone cares about:
 *
 *  - deterministic per-account sizing (SAME / MULTIPLIER / FIXED), floor
 *    rounding, and explicit zero -> SKIP;
 *  - a forced follower rejection isolates that follower and never rolls back the
 *    valid children (partial success);
 *  - exactly-once under concurrency (identical concurrent submits collapse to one
 *    intent and one order per account) and idempotent replay;
 *  - bracket OFFSETS produce each account's OWN protective OCO legs (independent,
 *    no shared order rows);
 *  - group flatten closes every account independently;
 *  - zero cross-account leakage: an order on one account never moves another's
 *    position or balance beyond its own sized fills.
 *
 * Everything runs through execution.submitOrder / the orchestrator — never a
 * second fill path — so risk, limits, brackets and OCO all come from the one
 * authoritative engine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { accounts, copyChildren, copyGroups, orders, positions, ruleTemplates, users } from '../db/schema.js';
import { TradingEngine } from '../trading/engine.js';
import { AtlasSimulationExecutionProvider } from '../execution/provider.js';
import { ScriptedMarket, ACCOUNT_TRADING_DATE } from '../trading/harness.js';
import { defaultOrganizationId } from './provisioning.js';
import { addFollower, createGroup, getGroupView } from './copy-groups.js';
import { flattenCopyGroup, submitCopyIntent } from './copy-orchestrator.js';

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

async function makeAccount(maxContracts = 50): Promise<string> {
  const size = 100_000 * M;
  const [tpl] = await db.insert(ruleTemplates).values({
    name: `Tort Tpl ${crypto.randomUUID().slice(0, 6)}`, accountType: 'FUNDED_SIM', accountSizeMicros: size,
    profitTargetMicros: 1_000_000 * M, maxLossMicros: size, drawdownType: 'STATIC', trailingLockAtMicros: null,
    dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: null, maxContracts, microsCountAsFraction: false, minTradingDays: 0, minWinningDays: 0,
    maxTradingDays: null, minDailyPnlToCountMicros: 0, flattenOnBreach: true, payoutRules: {},
  }).returning();
  const [a] = await db.insert(accounts).values({
    organizationId, userId, ruleTemplateId: tpl!.id, name: `Tort Acct ${crypto.randomUUID().slice(0, 6)}`,
    accountType: 'FUNDED_SIM', status: 'ACTIVE', startingBalanceMicros: size, balanceMicros: size,
    highWaterMarkMicros: size, drawdownFloorMicros: 0, dayStartBalanceMicros: size, dayStartEquityMicros: size,
    currentTradeDate: ACCOUNT_TRADING_DATE, simulationEnvironment: CLEAN_ENV as never, instrumentLimits: null,
  }).returning();
  accountIds.push(a!.id);
  return a!.id;
}

async function posQty(accountId: string, symbol = 'NQ'): Promise<number> {
  const [p] = await db.select().from(positions).where(and(eq(positions.accountId, accountId), eq(positions.symbol, symbol)));
  return p?.qty ?? 0;
}
async function balance(accountId: string): Promise<number> {
  const [a] = await db.select({ b: accounts.balanceMicros }).from(accounts).where(eq(accounts.id, accountId));
  return a?.b ?? 0;
}
async function protectiveLegs(accountId: string) {
  return db
    .select({ id: orders.id, role: orders.bracketRole, oco: orders.ocoGroupId, status: orders.status })
    .from(orders)
    .where(and(eq(orders.accountId, accountId), inArray(orders.bracketRole, ['STOP_LOSS', 'TAKE_PROFIT'])));
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  const handle = createDb(url); db = handle.db; sql = handle.sql;
  organizationId = await defaultOrganizationId(db);
  market = new ScriptedMarket();
  engine = new TradingEngine(db, market);
  await engine.start();
  execution = new AtlasSimulationExecutionProvider(engine);
  const [u] = await db.insert(users).values({ email: `copytort-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'Tort', organizationId }).returning();
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

describe('sizing fan-out + forced reject + isolation', () => {
  it('sizes each follower deterministically, skips a rounded-zero, isolates a rejecting follower', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount();
    const f1 = await makeAccount();           // ×1.0
    const fHalf = await makeAccount();         // ×0.5 -> floor
    const fDouble = await makeAccount();       // ×2.0
    const fCap = await makeAccount(1);         // ×1.0 but maxContracts 1 -> rejects qty 4
    const groupId = await createGroup(db, { userId, name: 'Tort Size', leaderAccountId: leader, sizingMode: 'MULTIPLIER', organizationId });
    await addFollower(db, { userId, groupId, accountId: f1, sizingMultiplierMilli: 1000 });
    await addFollower(db, { userId, groupId, accountId: fHalf, sizingMultiplierMilli: 500 });
    await addFollower(db, { userId, groupId, accountId: fDouble, sizingMultiplierMilli: 2000 });
    await addFollower(db, { userId, groupId, accountId: fCap, sizingMultiplierMilli: 1000 });

    const res = await submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 't-size', order: { symbol: 'NQ', side: 'BUY', qty: 4, type: 'MARKET' } });

    // leader 4, f1 4, fHalf 2 (floor 2.0), fDouble 8, fCap rejected (4 > maxContracts 1).
    expect(await posQty(leader)).toBe(4);
    expect(await posQty(f1)).toBe(4);
    expect(await posQty(fHalf)).toBe(2);
    expect(await posQty(fDouble)).toBe(8);
    expect(await posQty(fCap)).toBe(0);

    expect(res.accepted).toBe(4);     // leader + f1 + fHalf + fDouble
    expect(res.rejected).toBe(1);     // fCap
    expect(res.children.find((c) => c.accountId === fCap)!.status).toBe('REJECTED');
    // Valid children were NOT rolled back by the one rejection (partial success).
    expect(res.children.filter((c) => c.status === 'ACCEPTED')).toHaveLength(4);
  }, 60000);

  it('a rounded-to-zero follower is an explicit SKIP, not an order', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount();
    const fTiny = await makeAccount(); // ×0.001 of 1 -> 0 -> skip
    const groupId = await createGroup(db, { userId, name: 'Tort Skip', leaderAccountId: leader, sizingMode: 'MULTIPLIER', organizationId });
    await addFollower(db, { userId, groupId, accountId: fTiny, sizingMultiplierMilli: 1 });

    const res = await submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 't-skip', order: { symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' } });
    expect(res.skipped).toBe(1);
    const skip = res.children.find((c) => c.accountId === fTiny)!;
    expect(skip.status).toBe('SKIPPED');
    expect(await posQty(fTiny)).toBe(0);
    // No order row was created for the skipped follower.
    const [child] = await db.select().from(copyChildren).where(and(eq(copyChildren.copyIntentId, res.intentId), eq(copyChildren.accountId, fTiny)));
    expect(child?.orderId ?? null).toBeNull();
  }, 60000);
});

describe('exactly-once under concurrency + idempotent replay', () => {
  it('collapses identical concurrent submits to one intent and one order per account', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount();
    const f1 = await makeAccount();
    const f2 = await makeAccount();
    const groupId = await createGroup(db, { userId, name: 'Tort Conc', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await addFollower(db, { userId, groupId, accountId: f1 });
    await addFollower(db, { userId, groupId, accountId: f2 });

    const key = 't-conc';
    const results = await Promise.all(
      Array.from({ length: 8 }, () => submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: key, order: { symbol: 'NQ', side: 'BUY', qty: 2, type: 'MARKET' } })),
    );
    // Exactly one intent id across all concurrent callers.
    const intentIds = new Set(results.map((r) => r.intentId));
    expect(intentIds.size).toBe(1);

    // One order per member account, one position of exactly 2 — not 16.
    expect(await posQty(leader)).toBe(2);
    expect(await posQty(f1)).toBe(2);
    expect(await posQty(f2)).toBe(2);
    for (const acct of [leader, f1, f2]) {
      const rows = await db.select().from(orders).where(eq(orders.accountId, acct));
      expect(rows).toHaveLength(1);
    }
  }, 60000);
});

describe('bracket / OCO independence + group flatten', () => {
  it('gives each account its own protective OCO legs, then flattens all independently', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount();
    const f1 = await makeAccount();
    const f2 = await makeAccount();
    const groupId = await createGroup(db, { userId, name: 'Tort OCO', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await addFollower(db, { userId, groupId, accountId: f1 });
    await addFollower(db, { userId, groupId, accountId: f2 });

    const startBalances = { leader: await balance(leader), f1: await balance(f1), f2: await balance(f2) };

    await submitCopyIntent(db, execution, {
      userId, groupId, idempotencyKey: 't-oco',
      order: { symbol: 'NQ', side: 'BUY', qty: 2, type: 'MARKET', bracket: { stopLoss: { unit: 'TICKS', value: 40 }, takeProfit: { unit: 'TICKS', value: 80 } } },
    });

    // Each account has its OWN two protective legs sharing its OWN oco group id;
    // no two accounts share an oco group (no cross-account bracket).
    const ocoIds: string[] = [];
    for (const acct of [leader, f1, f2]) {
      const legs = await protectiveLegs(acct);
      expect(legs).toHaveLength(2);
      const roles = legs.map((l) => l.role).sort();
      expect(roles).toEqual(['STOP_LOSS', 'TAKE_PROFIT']);
      const oco = legs[0]!.oco;
      expect(oco).not.toBeNull();
      expect(legs.every((l) => l.oco === oco)).toBe(true);
      ocoIds.push(oco!);
    }
    expect(new Set(ocoIds).size).toBe(3); // three distinct oco groups, one per account

    // Positions open -> balances unchanged (fees off): no money moved or leaked.
    expect(await balance(leader)).toBe(startBalances.leader);
    expect(await balance(f1)).toBe(startBalances.f1);
    expect(await balance(f2)).toBe(startBalances.f2);

    // Group flatten closes every account and cancels the protective legs.
    const flat = await flattenCopyGroup(db, execution, { userId, groupId, idempotencyKey: 't-oco-flat', symbol: 'NQ' });
    expect(flat.rejected).toBe(0);
    for (const acct of [leader, f1, f2]) {
      expect(await posQty(acct)).toBe(0);
      const working = await db.select().from(orders).where(and(eq(orders.accountId, acct), inArray(orders.status, ['WORKING', 'ACCEPTED', 'PARTIALLY_FILLED'])));
      expect(working).toHaveLength(0);
    }
  }, 60000);
});

describe('rapid mixed sequence keeps every account consistent', () => {
  it('scales in, reduces, and flattens without cross-account leakage', async () => {
    await market.quote('NQ', 20_000);
    const leader = await makeAccount();
    const f1 = await makeAccount();
    const solo = await makeAccount(); // NOT in the group — must never be touched
    const groupId = await createGroup(db, { userId, name: 'Tort Seq', leaderAccountId: leader, sizingMode: 'SAME', organizationId });
    await addFollower(db, { userId, groupId, accountId: f1 });

    // An independent position on the non-member account, to prove isolation.
    await execution.submitOrder({ accountId: solo, userId, clientOrderId: 'solo-1', symbol: 'NQ', side: 'BUY', qty: 5, type: 'MARKET' });
    expect(await posQty(solo)).toBe(5);

    await submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 'seq-1', order: { symbol: 'NQ', side: 'BUY', qty: 3, type: 'MARKET' } });
    expect(await posQty(leader)).toBe(3);
    expect(await posQty(f1)).toBe(3);
    expect(await posQty(solo)).toBe(5); // untouched

    // Reduce by selling 1 across the group.
    await submitCopyIntent(db, execution, { userId, groupId, idempotencyKey: 'seq-2', order: { symbol: 'NQ', side: 'SELL', qty: 1, type: 'MARKET' } });
    expect(await posQty(leader)).toBe(2);
    expect(await posQty(f1)).toBe(2);
    expect(await posQty(solo)).toBe(5); // still untouched

    // Flatten the group; the solo account keeps its position.
    await flattenCopyGroup(db, execution, { userId, groupId, idempotencyKey: 'seq-flat', symbol: 'NQ' });
    expect(await posQty(leader)).toBe(0);
    expect(await posQty(f1)).toBe(0);
    expect(await posQty(solo)).toBe(5); // never in the group -> never flattened

    // Group is still ACTIVE and auditable.
    expect((await getGroupView(db, userId, groupId)).status).toBe('ACTIVE');
  }, 60000);
});
