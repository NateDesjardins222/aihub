/**
 * Product Recovery Phase 3 — EOD_TRAILING drawdown through the REAL engine day
 * rollover (STEP 2). Core-50K canonical: start 50,000 / maxLoss 2,000 /
 * trailingLockAt 0 → initial floor 48,000, lock level 50,000.
 *
 * The day boundary is driven deterministically by stamping quotes on successive
 * CME business dates and calling the engine's real mark path (`enforceRules`),
 * which runs `applyRules` → `rollTradingDay` → `persistRuleState`. No wall-clock
 * sleeps, no fixed timeouts, no weakening of the production clock.
 *
 * Semantics proven here (read from packages/core/src/rules/rules.ts):
 *  - EOD floor moves ONLY at the roll: floor' = max(prevFloor, min(closeBal −
 *    maxLoss, startBal + trailingLockAt)); intraday unrealized never ratchets it.
 *  - floor never moves backward; never exceeds the lock level.
 *  - a trailing-drawdown breach fires when equity <= floor (remaining <= 0).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { requireInstrument } from '@atlas/instruments';
import { TradingEngine } from './engine.js';
import { OPEN_MARKET_TS, ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';
import { accounts, orders } from '../db/schema.js';

requireInstrument('NQ');
const $ = (d: number): number => d * 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLEAN_ENV = {
  fillModel: 'SIMPLE' as const, latencyMs: 0, marketSlippageTicks: 0, stopSlippageTicks: 0,
  requireThroughTradeForLimit: false, feesEnabled: false, useBarRange: true,
};

let fixture: TestFixture; let market: ScriptedMarket; let engine: TradingEngine; let seq = 0;
const cid = (): string => `eod-${(seq += 1)}-${Date.now()}`;

const TERMINAL_ORDER = new Set(['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED']);
/**
 * Wait for a submitted order to reach a terminal state by OBSERVING the
 * authoritative orders row, not by sleeping a fixed number of milliseconds. The
 * fill transaction persists the position and balance before it stamps the
 * terminal status, so once the status is terminal the balance/floor this test
 * asserts on are already durable. This is deterministic under full-suite load —
 * a fixed `settle(20)` was not, which is why this file flaked only under
 * canonical contention while passing in isolation.
 */
async function waitOrderTerminal(clientOrderId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const [row] = await fixture.db
      .select({ status: orders.status })
      .from(orders)
      .where(and(eq(orders.accountId, fixture.accountId), eq(orders.clientOrderId, clientOrderId)));
    if (row && TERMINAL_ORDER.has(row.status)) return;
    if (Date.now() > deadline) throw new Error(`order ${clientOrderId} not terminal (last=${row?.status ?? 'missing'})`);
    await settle(2);
  }
}
async function buy(qty: number): Promise<void> {
  const id = cid();
  await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: id, symbol: 'NQ', side: 'BUY', qty, type: 'MARKET' });
  await waitOrderTerminal(id);
}
async function sell(qty: number): Promise<void> {
  const id = cid();
  await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: id, symbol: 'NQ', side: 'SELL', qty, type: 'MARKET' });
  await waitOrderTerminal(id);
}
async function acct(): Promise<{ balanceMicros: number; drawdownFloorMicros: number; status: string; currentTradeDate: string | null }> {
  const [r] = await fixture.db.select().from(accounts).where(eq(accounts.id, fixture.accountId));
  const x = r as Record<string, unknown>;
  return { balanceMicros: Number(x['balanceMicros']), drawdownFloorMicros: Number(x['drawdownFloorMicros']), status: String(x['status']), currentTradeDate: x['currentTradeDate'] == null ? null : String(x['currentTradeDate']) };
}
/** Roll to a business date by quoting on it, then running the real mark path. */
async function rollTo(price: number, tsOffsetDays: number): Promise<void> {
  await market.quote('NQ', price, OPEN_MARKET_TS + tsOffsetDays * DAY_MS);
  await engine.enforceRules(fixture.accountId);
  await settle(10);
}

beforeEach(async () => {
  fixture = await createFixture({
    environment: CLEAN_ENV, maxContracts: 5, startingBalanceMicros: $(50_000),
    // A large profit target keeps the account ACTIVE across the multi-day floor
    // ladder so this test isolates the EOD drawdown mechanic; the $3,000 Core-50K
    // pass transition is proven separately (consistency/eval tests).
    rules: { profitTargetMicros: $(1_000_000), maxLossMicros: $(2_000), drawdownType: 'EOD_TRAILING', trailingLockAtMicros: 0 },
  });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
  await market.quote('NQ', 20_000, OPEN_MARKET_TS);
});
afterEach(async () => { await fixture.close(); });

describe('EOD trailing drawdown — real engine day rollover (Core 50K)', () => {
  it('ratchets only at the roll, never backward, locks at 50k, persists, and breaches at the floor', async () => {
    // Initial floor.
    expect((await acct()).drawdownFloorMicros).toBe($(48_000));

    // DAY 1 — intraday unrealized profit must NOT ratchet the floor (frozen intraday).
    await buy(1);                                   // long @ 20,000
    await market.quote('NQ', 20_050, OPEN_MARKET_TS); // +$1,000 unrealized → equity 51,000
    await engine.enforceRules(fixture.accountId);   // same day: no roll
    expect((await acct()).drawdownFloorMicros).toBe($(48_000)); // intraday no ratchet
    await sell(1);                                  // realize +$1,000 → balance 51,000
    let a = await acct();
    expect(a.balanceMicros).toBe($(51_000));
    expect(a.drawdownFloorMicros).toBe($(48_000));  // still not ratcheted before the roll

    // ROLL to DAY 2 — the EOD roll trails the day's equity high-water (51,000 here,
    // == the close since the intraday peak did not exceed it): floor = min(51,000 −
    // 2,000, lock 50,000) = 49,000.
    await rollTo(20_050, 1);
    expect((await acct()).drawdownFloorMicros).toBe($(49_000));

    // DAY 2 — realize +$2,000 → close 53,000.
    await buy(1); await market.quote('NQ', 20_150, OPEN_MARKET_TS + DAY_MS); await sell(1);
    expect((await acct()).balanceMicros).toBe($(53_000));

    // ROLL to DAY 3 — floor = max(49,000, min(53,000-2,000, 50,000)) = 50,000 (LOCKED).
    await rollTo(20_150, 2);
    expect((await acct()).drawdownFloorMicros).toBe($(50_000));

    // DAY 3 — realize a LOSS of $1,000 → close 52,000.
    await buy(1); await market.quote('NQ', 20_100, OPEN_MARKET_TS + 2 * DAY_MS); await sell(1);
    expect((await acct()).balanceMicros).toBe($(52_000));

    // ROLL to DAY 4 — floor never moves backward: max(50,000, min(50,000,50,000)) = 50,000.
    await rollTo(20_100, 3);
    expect((await acct()).drawdownFloorMicros).toBe($(50_000));

    // DAY 4 — realize +$3,000 → close 55,000.
    await buy(1); await market.quote('NQ', 20_250, OPEN_MARKET_TS + 3 * DAY_MS); await sell(1);
    expect((await acct()).balanceMicros).toBe($(55_000));

    // ROLL to DAY 5 (Mon, +6 to skip the weekend) — floor never exceeds the lock: still 50,000.
    await rollTo(20_250, 6);
    a = await acct();
    expect(a.drawdownFloorMicros).toBe($(50_000));
    expect(a.status).toBe('ACTIVE');

    // RESTART: a brand-new engine on the same DB reads the persisted floor.
    const engine2 = new TradingEngine(fixture.db, market);
    await engine2.start();
    expect((await acct()).drawdownFloorMicros).toBe($(50_000));

    // BREACH boundary around the authoritative floor (50,000), balance 55,000.
    engine = engine2;
    await market.quote('NQ', 20_250, OPEN_MARKET_TS + 6 * DAY_MS);
    await buy(1);                                   // long 1 @ 20,250
    // Equity well ABOVE the floor → account stays valid.
    await market.quote('NQ', 20_200, OPEN_MARKET_TS + 6 * DAY_MS); // equity 55,000-1,000 = 54,000
    await engine.enforceRules(fixture.accountId);
    expect((await acct()).status).toBe('ACTIVE');
    // Equity exactly AT the floor (50,000) → breach (remaining <= 0).
    await market.quote('NQ', 20_000, OPEN_MARKET_TS + 6 * DAY_MS); // openPnl -5,000 → equity 50,000
    await engine.enforceRules(fixture.accountId);
    await settle(20);
    expect((await acct()).status).toBe('FAILED');
  });
});
