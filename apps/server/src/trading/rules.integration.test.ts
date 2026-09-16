import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { requireInstrument } from '@atlas/instruments';
import { accounts, orders as ordersTable, positions as positionsTable } from '../db/schema.js';
import { TradingEngine } from './engine.js';
import { ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';

/**
 * The rule engine against a real database and a real matching engine.
 *
 * Every test here is a way an account can be lost, because that is the part a
 * simulator must get right: a programme that fails you late has taught you a
 * habit that will fail you for real.
 */

const NQ = requireInstrument('NQ');
const D = 1_000_000;
/** NQ is $5 a tick, 4 ticks a point: one point on one contract is $20. */
const POINT = 20 * D;

let fixture: TestFixture;
let market: ScriptedMarket;
let engine: TradingEngine;
let seq = 0;

const CLEAN_ENV = {
  fillModel: 'SIMPLE' as const,
  latencyMs: 0,
  marketSlippageTicks: 0,
  stopSlippageTicks: 0,
  requireThroughTradeForLimit: false,
  feesEnabled: false,
  useBarRange: true,
};

async function setup(rules: Parameters<typeof createFixture>[0] extends infer _ ? NonNullable<Parameters<typeof createFixture>[0]>['rules'] : never): Promise<void> {
  fixture = await createFixture({ environment: CLEAN_ENV, startingBalanceMicros: 50_000 * D, rules });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
}

function cid(label: string): string {
  seq += 1;
  return `${label}-${seq}-${Date.now()}`;
}

async function submit(input: Partial<Parameters<TradingEngine['submitOrder']>[0]> = {}) {
  return engine.submitOrder({
    accountId: fixture.accountId,
    userId: fixture.userId,
    clientOrderId: cid('r'),
    symbol: 'NQ',
    side: 'BUY',
    qty: 1,
    type: 'MARKET',
    ...input,
  });
}

async function account() {
  const [row] = await fixture.db.select().from(accounts).where(eq(accounts.id, fixture.accountId));
  return row!;
}

async function positionQty(symbol = 'NQ'): Promise<number> {
  const [row] = await fixture.db
    .select()
    .from(positionsTable)
    .where(eq(positionsTable.accountId, fixture.accountId));
  return row?.symbol === symbol ? row.qty : (row?.qty ?? 0);
}

async function openOrders() {
  const rows = await fixture.db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.accountId, fixture.accountId));
  return rows.filter((r) => r.status === 'WORKING' || r.status === 'PARTIALLY_FILLED');
}

afterEach(async () => {
  engine.stop();
  await fixture.close();
});

// -------------------------------------------------------------- drawdown ---

describe('drawdown enforcement', () => {
  it('fails the account on an UNREALIZED loss and closes everything', async () => {
    // 2,000 of room. Two NQ contracts lose that in 50 points.
    await setup({ maxLossMicros: 2_000 * D, drawdownType: 'STATIC' });
    await market.quote('NQ', 20_000);
    await submit({ qty: 2, side: 'BUY' });
    await settle(30);
    expect(await positionQty()).toBe(2);

    await market.quote('NQ', 19_949);
    await settle(60);

    const a = await account();
    expect(a.status).toBe('FAILED');
    expect(a.failedReason).toBe('MAX_LOSS_LIMIT');
    // The breach closed the position rather than leaving it to get worse.
    expect(await positionQty()).toBe(0);
  });

  it('refuses new orders once failed, and says why', async () => {
    await setup({ maxLossMicros: 500 * D, drawdownType: 'STATIC' });
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 19_970);
    await settle(60);
    expect((await account()).status).toBe('FAILED');

    await expect(submit({ qty: 1 })).rejects.toMatchObject({ reason: 'ACCOUNT_FAILED' });
  });

  it('cancels working orders and brackets when a breach lands', async () => {
    await setup({ maxLossMicros: 1_000 * D, drawdownType: 'STATIC' });
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY', bracket: { stopLossTicks: 400, takeProfitTicks: 800 } });
    await settle(40);
    // A resting order far from the market, which the breach must also cancel.
    await submit({ qty: 1, side: 'BUY', type: 'LIMIT', limitTicks: 19_000 * 4 });
    await settle(30);
    expect((await openOrders()).length).toBeGreaterThan(0);

    await market.quote('NQ', 19_940);
    await settle(80);

    expect((await account()).status).toBe('FAILED');
    expect(await openOrders()).toHaveLength(0);
    expect(await positionQty()).toBe(0);
  });

  it('trails the floor up on unrealized profit, then holds it', async () => {
    await setup({
      maxLossMicros: 2_000 * D,
      drawdownType: 'INTRADAY_TRAILING',
      trailingLockAtMicros: 0,
    });
    const start = (await account()).drawdownFloorMicros;
    expect(start).toBe(48_000 * D);

    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);

    // 40 points of open profit: the floor follows it up by 800.
    await market.quote('NQ', 20_040);
    await settle(60);
    expect((await account()).drawdownFloorMicros).toBe(48_800 * D);

    // Give it back: the floor does not follow back down.
    await market.quote('NQ', 20_010);
    await settle(60);
    expect((await account()).drawdownFloorMicros).toBe(48_800 * D);

    // Far enough ahead and the floor locks at the starting balance.
    await market.quote('NQ', 20_150);
    await settle(60);
    expect((await account()).drawdownFloorMicros).toBe(50_000 * D);
  });

  it('a trailing floor that has moved can fail an account still in profit', async () => {
    // The lesson the rule exists to teach: 100 points up then 30 back is a
    // breach on a tight trailing programme, even though the account is green.
    await setup({
      maxLossMicros: 1_000 * D,
      drawdownType: 'INTRADAY_TRAILING',
      trailingLockAtMicros: null,
    });
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 20_100);
    await settle(60);
    await market.quote('NQ', 20_045);
    await settle(80);

    const a = await account();
    expect(a.status).toBe('FAILED');
    expect(a.balanceMicros).toBeGreaterThan(50_000 * D);
  });
});

// ------------------------------------------------------------ daily limit ---

describe('daily loss limit', () => {
  it('locks the day without failing the account', async () => {
    await setup({ maxLossMicros: 10_000 * D, dailyLossLimitMicros: 600 * D });
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 19_965);
    await settle(80);

    const a = await account();
    expect(a.status).toBe('LOCKED');
    expect(a.lockedUntilDate).toBe('2026-09-16');
    expect(await positionQty()).toBe(0);
    await expect(submit({ qty: 1 })).rejects.toMatchObject({ reason: 'ACCOUNT_LOCKED' });
  });

  it('fails the account outright when the programme says so', async () => {
    await setup({
      maxLossMicros: 10_000 * D,
      dailyLossLimitMicros: 600 * D,
      dailyLossPolicy: 'FAIL',
    });
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 19_965);
    await settle(80);

    expect((await account()).status).toBe('FAILED');
  });

  it('lets the lock expire when the trading day rolls', async () => {
    await setup({ maxLossMicros: 10_000 * D, dailyLossLimitMicros: 600 * D });
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 19_965);
    await settle(80);
    expect((await account()).status).toBe('LOCKED');

    // The next session: 16 September, 10:00 CT.
    await market.quote('NQ', 20_000, Date.UTC(2026, 8, 16, 15, 0, 0));
    await settle(80);
    await engine.enforceRules(fixture.accountId);

    const a = await account();
    expect(a.status).toBe('ACTIVE');
    expect(a.currentTradeDate).toBe('2026-09-16');
    expect(a.lockedUntilDate).toBeNull();
    // And the day's loss allowance starts again.
    const valuation = await engine.valuation(fixture.accountId);
    expect(valuation!.rules.remainingDailyLossMicros).toBe(600 * D);
    // The day that closed counted as a trading day.
    expect(a.tradingDaysCount).toBe(1);
  });
});

// ------------------------------------------------------------- the target ---

describe('the profit target', () => {
  it('reports GOAL_REACHED but keeps trading until the days are done', async () => {
    await setup({
      maxLossMicros: 10_000 * D,
      profitTargetMicros: 300 * D,
      minTradingDays: 2,
    });
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 20_020);
    await settle(30);
    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(60);

    const valuation = await engine.valuation(fixture.accountId);
    expect(valuation!.rules.profitTargetMet).toBe(true);
    expect(valuation!.rules.status).toBe('GOAL_REACHED');
    expect(valuation!.rules.canTrade).toBe(true);
    const days = valuation!.rules.requirements.find((r) => r.key === 'MIN_TRADING_DAYS');
    expect(days?.met).toBe(false);

    // Still tradable.
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    expect(await positionQty()).toBe(1);
  });

  it('passes when the target and the days are both satisfied', async () => {
    await setup({ maxLossMicros: 10_000 * D, profitTargetMicros: 300 * D, minTradingDays: 1 });
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 20_020);
    await settle(30);
    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(60);

    // Roll into the next day so the first one counts.
    await market.quote('NQ', 20_020, Date.UTC(2026, 8, 16, 15, 0, 0));
    await settle(40);
    await engine.enforceRules(fixture.accountId);

    const valuation = await engine.valuation(fixture.accountId);
    expect(valuation!.rules.tradingDaysCount).toBe(1);
    expect(valuation!.rules.status).toBe('PASSED');
  });
});

// ------------------------------------------------------------- adversarial ---

describe('adversarial', () => {
  it('does not double-liquidate when the breach is re-evaluated', async () => {
    await setup({ maxLossMicros: 1_000 * D, drawdownType: 'STATIC' });
    await market.quote('NQ', 20_000);
    await submit({ qty: 2, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 19_970);
    await settle(60);
    expect((await account()).status).toBe('FAILED');
    expect(await positionQty()).toBe(0);

    // Several more marks, each of which re-runs the rules.
    for (const price of [19_960, 19_950, 19_940]) {
      await market.quote('NQ', price);
      await settle(30);
    }
    await engine.enforceRules(fixture.accountId);

    expect(await positionQty()).toBe(0);
    const all = await fixture.db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.accountId, fixture.accountId));
    // One entry and exactly one liquidation, never a second.
    expect(all.filter((o) => o.clientOrderId.startsWith('liquidate-'))).toHaveLength(1);
  });

  it('keeps the account failed when the liquidation cannot fill', async () => {
    await setup({ maxLossMicros: 1_000 * D, drawdownType: 'STATIC' });
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);

    // The breach arrives on a bar, and then the feed goes stale before the
    // liquidation can be priced.
    await market.quote('NQ', 19_940);
    market.setStale(true);
    await settle(60);
    await engine.enforceRules(fixture.accountId);

    const a = await account();
    expect(a.status).toBe('FAILED');
    // Honest: the position is still open, because nothing could close it.
    expect(await positionQty()).toBe(1);

    // When the feed recovers, the position is closed on the next evaluation.
    market.setStale(false);
    await market.quote('NQ', 19_940);
    await settle(60);
    await engine.enforceRules(fixture.accountId);
    expect(await positionQty()).toBe(0);
  });

  it('a breach mid-partial-fill closes what actually filled', async () => {
    await setup({ maxLossMicros: 1_200 * D, drawdownType: 'STATIC' });
    await market.quote('NQ', 20_000);
    await submit({ qty: 3, side: 'BUY' });
    await settle(30);
    expect(await positionQty()).toBe(3);

    await market.quote('NQ', 19_980);
    await settle(80);

    expect((await account()).status).toBe('FAILED');
    expect(await positionQty()).toBe(0);
  });

  it('counts the trading day only when the day actually moved', async () => {
    await setup({ maxLossMicros: 10_000 * D, minDailyPnlToCountMicros: 100 * D });
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 20_001);
    await settle(30);
    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(60);

    await market.quote('NQ', 20_001, Date.UTC(2026, 8, 16, 15, 0, 0));
    await settle(40);
    await engine.enforceRules(fixture.accountId);

    // $20 of profit is not a trading day under a $100 threshold.
    expect((await account()).tradingDaysCount).toBe(0);
  });
});
