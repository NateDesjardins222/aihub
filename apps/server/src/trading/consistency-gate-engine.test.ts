/**
 * Product Recovery Phase 3 — Core >50% consistency pass-gate through the REAL
 * engine (STEP 3). Core canonical: evaluation consistency = 50%, formula
 * BEST_DAY_OVER_TOTAL, min trading/winning days = 0, so the ONLY gate beyond the
 * profit target is the best-day-over-total ratio (verified against the canonical
 * source: packages/contracts/src/product-catalog.ts → CORE.evalConsistencyPct 50,
 * wired to consistencyThreshold 0.5 in product-model.ts).
 *
 * Intended boundary (packages/core/src/rules/rules.ts `consistencyStatus`):
 *   passing ⇔ bestDay / totalNet <= threshold (+1e-9).  The best single day may
 *   EQUAL 50% of total profit but not EXCEED it. A ratio > 50% does NOT fail the
 *   account — it holds it at GOAL_REACHED (profit target met, consistency unmet),
 *   and later profit made on OTHER days restores eligibility to PASSED.
 *
 * The best day is the best CLOSED day, so consistency only bites once a day has
 * rolled. Days are rolled deterministically by stamping quotes on successive CME
 * business dates and running the engine's real mark path (`enforceRules`). No
 * wall-clock sleeps.
 *
 * Boundaries proven here, all through the real engine:
 *   >50% (0.833) → GOAL_REACHED (delayed, never FAILED)
 *   =50% (0.500) → PASSED         (boundary is inclusive)
 *   <50% (0.417) → PASSED         (stays eligible)
 * Reaching PASSED is idempotent (re-marking does not regress or duplicate it);
 * the eval→funded exactly-once transition is proven separately (Phase 2, L4).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { requireInstrument } from '@atlas/instruments';
import { TradingEngine } from './engine.js';
import { OPEN_MARKET_TS, ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';
import { accounts } from '../db/schema.js';

requireInstrument('NQ');
const $ = (d: number): number => d * 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLEAN_ENV = {
  fillModel: 'SIMPLE' as const, latencyMs: 0, marketSlippageTicks: 0, stopSlippageTicks: 0,
  requireThroughTradeForLimit: false, feesEnabled: false, useBarRange: true,
};

let fixture: TestFixture; let market: ScriptedMarket; let engine: TradingEngine; let seq = 0;
const cid = (): string => `cons-${(seq += 1)}-${Date.now()}`;

async function buy(qty: number): Promise<void> {
  await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid(), symbol: 'NQ', side: 'BUY', qty, type: 'MARKET' });
  await settle(20);
}
async function sell(qty: number): Promise<void> {
  await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid(), symbol: 'NQ', side: 'SELL', qty, type: 'MARKET' });
  await settle(20);
}
interface Snap {
  balanceMicros: number; startingBalanceMicros: number; bestDayProfitMicros: number;
  ruleStatus: string; status: string; tradingDaysCount: number;
}
async function acct(): Promise<Snap> {
  const [r] = await fixture.db.select().from(accounts).where(eq(accounts.id, fixture.accountId));
  const x = r as Record<string, unknown>;
  return {
    balanceMicros: Number(x['balanceMicros']),
    startingBalanceMicros: Number(x['startingBalanceMicros']),
    bestDayProfitMicros: Number(x['bestDayProfitMicros']),
    ruleStatus: String(x['ruleStatus']),
    status: String(x['status']),
    tradingDaysCount: Number(x['tradingDaysCount']),
  };
}
/** The consistency ratio the way the engine computes it: bestClosedDay / totalNet. */
function ratio(a: Snap): number | null {
  const total = a.balanceMicros - a.startingBalanceMicros;
  if (total <= 0) return null;
  return a.bestDayProfitMicros / total;
}
/** A full intraday round trip that realizes `points`*$20 on one business date. */
async function dayTrade(points: number, offsetDays: number): Promise<void> {
  await market.quote('NQ', 20_000, OPEN_MARKET_TS + offsetDays * DAY_MS);
  await buy(1);
  await market.quote('NQ', 20_000 + points, OPEN_MARKET_TS + offsetDays * DAY_MS);
  await sell(1);
}
/** Advance to a new business date (position flat), closing the prior day. */
async function roll(offsetDays: number): Promise<void> {
  await market.quote('NQ', 20_000, OPEN_MARKET_TS + offsetDays * DAY_MS);
  await engine.enforceRules(fixture.accountId);
  await settle(10);
}

beforeEach(async () => {
  fixture = await createFixture({
    environment: CLEAN_ENV, maxContracts: 5, startingBalanceMicros: $(50_000),
    // Core-50K canonical terms: $3,000 target, $2,000 EOD trailing drawdown,
    // 50% evaluation consistency, no min trading/winning days.
    rules: {
      profitTargetMicros: $(3_000), maxLossMicros: $(2_000), drawdownType: 'EOD_TRAILING',
      trailingLockAtMicros: 0, consistencyThreshold: 0.5,
    },
  });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
  await market.quote('NQ', 20_000, OPEN_MARKET_TS);
});
afterEach(async () => { await fixture.close(); });

describe('Core 50% consistency pass-gate — real engine day rollover', () => {
  it('holds at GOAL_REACHED above 50%, passes at exactly 50%, stays passed below', async () => {
    // DAY 1 (offset 0): +$2,500. Below the $3,000 target → still ACTIVE. The best
    // day is not recorded until the day CLOSES, so consistency cannot bite yet.
    await dayTrade(125, 0); // +125 pts * $20 = +$2,500
    let a = await acct();
    expect(a.balanceMicros).toBe($(52_500));
    expect(a.ruleStatus).toBe('ACTIVE');
    expect(a.bestDayProfitMicros).toBe(0); // day 1 not yet closed

    // ROLL → closes day 1. Best closed day = $2,500.
    await roll(1);
    a = await acct();
    expect(a.bestDayProfitMicros).toBe($(2_500));
    expect(a.tradingDaysCount).toBe(1);
    expect(a.ruleStatus).toBe('ACTIVE'); // target still not met

    // DAY 2 (offset 1): +$500 → total profit hits the $3,000 target. But the best
    // closed day is $2,500, so ratio = 2,500/3,000 ≈ 0.833 > 0.50. Profit target
    // MET yet consistency UNMET → GOAL_REACHED, NOT PASSED and NOT FAILED.
    await dayTrade(25, 1); // +$500
    a = await acct();
    expect(a.balanceMicros).toBe($(53_000));
    expect(ratio(a)!).toBeGreaterThan(0.5);
    expect(ratio(a)!).toBeCloseTo(0.8333, 3);
    expect(a.ruleStatus).toBe('GOAL_REACHED'); // >50% DELAYS the pass
    expect(a.status).not.toBe('FAILED');       // consistency never fails the account

    // ROLL → closes day 2 (best day unchanged: max($2,500,$500) = $2,500).
    await roll(2);
    a = await acct();
    expect(a.bestDayProfitMicros).toBe($(2_500));
    expect(a.ruleStatus).toBe('GOAL_REACHED'); // still delayed after the roll

    // DAY 3 (offset 2): +$2,000 made on a DIFFERENT day → total profit $5,000,
    // best day still $2,500 → ratio = 2,500/5,000 = 0.50 EXACTLY. Boundary is
    // inclusive: the best day may EQUAL 50% → consistency now MET → PASSED.
    await dayTrade(100, 2); // +$2,000
    a = await acct();
    expect(a.balanceMicros).toBe($(55_000));
    expect(ratio(a)!).toBe(0.5);
    expect(a.ruleStatus).toBe('PASSED'); // later profit RESTORES eligibility

    // Still exactly on the boundary; re-marking must not regress or duplicate the
    // pass (idempotent). The eval→funded transition itself is proven L4 elsewhere.
    // (A PASSED account has completed its programme and accepts no new orders, so
    // the strictly-below-50% case is proven on a separate account below.)
    await engine.enforceRules(fixture.accountId);
    await settle(10);
    expect((await acct()).ruleStatus).toBe('PASSED');
  });

  it('a well-distributed account (ratio well below 50%) passes cleanly', async () => {
    // Three even $1,000 days: best closed day $1,000, total $3,000 at the target,
    // ratio = 1,000/3,000 ≈ 0.333 < 0.50. Consistency is satisfied the moment the
    // target is met → straight to PASSED, never held at GOAL_REACHED.
    await dayTrade(50, 0); // +$1,000
    await roll(1);
    expect((await acct()).ruleStatus).toBe('ACTIVE');

    await dayTrade(50, 1); // +$1,000 (total $2,000, below target)
    await roll(2);
    expect((await acct()).ruleStatus).toBe('ACTIVE');

    await dayTrade(50, 2); // +$1,000 → total $3,000 = target
    const a = await acct();
    expect(a.balanceMicros).toBe($(53_000));
    expect(a.bestDayProfitMicros).toBe($(1_000));
    expect(ratio(a)!).toBeCloseTo(0.3333, 3);
    expect(ratio(a)!).toBeLessThan(0.5);
    expect(a.ruleStatus).toBe('PASSED'); // ratio < 50% → eligible immediately
  });
});
