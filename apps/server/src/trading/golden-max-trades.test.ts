/**
 * Product Recovery Phase 2 — GOLDEN behavioral scenario (STEP 5).
 *
 * "Trader sets MAX TRADES PER DAY = 1" proven end-to-end through the REAL order
 * boundary, with cross-layer assertions via the state probe and a reconnect
 * (fresh engine on the same DB) to prove the restriction is durable authoritative
 * state, not client memory.
 *
 * Entry points are the same ones the product uses:
 *  - control saved via `upsertPersonalControl` (the domain service the Portal
 *    HTTP route `PUT /portal/accounts/:id/controls/:type` wraps)
 *  - orders submitted via `engine.submitOrder` (the method the Atlas HTTP order
 *    route `POST /orders` wraps)
 * The pure evaluator is NEVER called directly. Real Postgres + ScriptedMarket.
 *
 * This mirrors the human golden path in docs/company/HUMAN_GOLDEN_PATH.md so
 * Nathan can reproduce the same behavior manually in the browser.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { requireInstrument } from '@atlas/instruments';
import { TradingEngine, OrderRejectedError } from './engine.js';
import { OPEN_MARKET_TS, ACCOUNT_TRADING_DATE, ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';
import { upsertPersonalControl } from '../platform/personal-risk.js';
import { probeAccountState } from '../platform/state-probe.js';
import { orders as ordersTable, executions as executionsTable } from '../db/schema.js';

requireInstrument('NQ');

const CLEAN_ENV = {
  fillModel: 'SIMPLE' as const,
  latencyMs: 0,
  marketSlippageTicks: 0,
  stopSlippageTicks: 0,
  requireThroughTradeForLimit: false,
  feesEnabled: false,
  useBarRange: true,
};

let fixture: TestFixture;
let market: ScriptedMarket;
let engine: TradingEngine;
let seq = 0;
const cid = (): string => `golden-${(seq += 1)}-${Date.now()}`;

async function newEngine(): Promise<TradingEngine> {
  const e = new TradingEngine(fixture.db, market);
  await e.start();
  return e;
}

async function countOrders(): Promise<number> {
  const rows = await fixture.db.select().from(ordersTable).where(eq(ordersTable.accountId, fixture.accountId));
  return rows.length;
}
async function countExecutions(): Promise<number> {
  const rows = await fixture.db.select().from(executionsTable).where(eq(executionsTable.accountId, fixture.accountId));
  return rows.length;
}

beforeEach(async () => {
  // A Core-50K-shaped evaluation account (STEP 2): 50k start, 3k target,
  // 2k EOD trailing drawdown, 5 minis. The scenario itself is about MAX_TRADES.
  fixture = await createFixture({
    environment: CLEAN_ENV,
    maxContracts: 5,
    startingBalanceMicros: 50_000 * 1_000_000,
    rules: {
      profitTargetMicros: 3_000 * 1_000_000,
      maxLossMicros: 2_000 * 1_000_000,
      drawdownType: 'EOD_TRAILING',
      trailingLockAtMicros: 0,
    },
  });
  market = new ScriptedMarket();
  engine = await newEngine();
  await market.quote('NQ', 20_000, OPEN_MARKET_TS);
});

afterEach(async () => {
  await fixture.close();
});

describe('GOLDEN — personal MAX_TRADES/day = 1 (real order path, cross-layer, durable)', () => {
  it('saves, persists, enforces, does not execute the rejected order, and survives reconnect', async () => {
    // 1) Save the control through the Portal's domain service.
    await upsertPersonalControl(fixture.db, {
      accountId: fixture.accountId,
      ownerUserId: fixture.userId,
      actorUserId: fixture.userId,
      controlType: 'MAX_TRADES',
      enabled: true,
      mode: 'FLEXIBLE',
      value: { valueInt: 1 },
    });

    // 2) Reload and confirm via the state probe (persistence).
    let snap = await probeAccountState(fixture.db, fixture.accountId);
    const maxTrades = snap.personalControls.find((c) => c.controlType === 'MAX_TRADES');
    expect(maxTrades?.enabled).toBe(true);
    expect(maxTrades?.valueInt).toBe(1);
    expect(snap.account?.status).toBe('ACTIVE');

    // 3) First opening trade through the real order path — fills.
    await engine.submitOrder({
      accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid(),
      symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET',
    });
    await settle(30);

    snap = await probeAccountState(fixture.db, fixture.accountId);
    expect(snap.openPositions.find((p) => p.symbol === 'NQ')?.qty).toBe(1);
    const ordersAfterFirst = await countOrders();
    const execsAfterFirst = await countExecutions();
    const balanceAfterFirst = snap.account!.balanceMicros;
    expect(ordersAfterFirst).toBe(1);
    expect(execsAfterFirst).toBeGreaterThanOrEqual(1);

    // 4) Second opening order — must be REJECTED with the accurate reason.
    let rejected: OrderRejectedError | null = null;
    try {
      await engine.submitOrder({
        accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid(),
        symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET',
      });
      await settle(30);
    } catch (err) {
      if (err instanceof OrderRejectedError) rejected = err;
      else throw err;
    }
    expect(rejected).not.toBeNull();
    expect(rejected!.reason).toBe('PERSONAL_MAX_TRADES');

    // 5) The rejected order did NOT execute: no new order row, no new execution,
    //    position and balance are financially unchanged.
    expect(await countOrders()).toBe(ordersAfterFirst);
    expect(await countExecutions()).toBe(execsAfterFirst);
    snap = await probeAccountState(fixture.db, fixture.accountId);
    expect(snap.openPositions.find((p) => p.symbol === 'NQ')?.qty).toBe(1);
    expect(snap.account!.balanceMicros).toBe(balanceAfterFirst);

    // 6) An authoritative risk event records the rejection (audit evidence).
    expect(snap.recentRiskEvents.some((e) => e.reason === 'PERSONAL_MAX_TRADES')).toBe(true);

    // 7) RECONNECT: a brand-new engine instance on the same DB (no client memory)
    //    still rejects the second opening order — the restriction is durable
    //    authoritative state.
    const engine2 = await newEngine();
    let rejected2: OrderRejectedError | null = null;
    try {
      await engine2.submitOrder({
        accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid(),
        symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET',
      });
      await settle(30);
    } catch (err) {
      if (err instanceof OrderRejectedError) rejected2 = err;
      else throw err;
    }
    expect(rejected2?.reason).toBe('PERSONAL_MAX_TRADES');

    // 8) A REDUCING (flatten) order is still allowed even at the cap — a trader
    //    can always close, and the cap never strands a position.
    await engine2.submitOrder({
      accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid(),
      symbol: 'NQ', side: 'SELL', qty: 1, type: 'MARKET',
    });
    await settle(30);
    snap = await probeAccountState(fixture.db, fixture.accountId);
    expect(snap.openPositions.find((p) => p.symbol === 'NQ')?.qty ?? 0).toBe(0);
  });
});
