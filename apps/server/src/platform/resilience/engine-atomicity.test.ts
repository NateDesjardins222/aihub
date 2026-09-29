/**
 * Engineering Resilience Phase 2 — Parts IX/XII/XIII: execution/position atomicity
 * and EOD-roll atomicity (RES-3), proven by injecting a fault inside the real
 * engine transactions.
 *
 * IX: a fault anywhere inside the fill transaction leaves execution and position
 *     consistent — never an execution without a matching position, never a phantom.
 * XII/XIII (RES-3): the end-of-day roll now writes the day statistic AND the
 *     account counters in ONE transaction; a fault rolls BOTH back (no partial
 *     day), and a clean replay is idempotent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accounts, dailyAccountStats, executions } from '../../db/schema.js';
import { TradingEngine } from '../../trading/engine.js';
import { OPEN_MARKET_TS, ScriptedMarket, createFixture, settle, type TestFixture } from '../../trading/harness.js';
import { reconcileAccount } from './reconcile.js';
import { FaultInjector } from './failpoints.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLEAN_ENV = {
  fillModel: 'SIMPLE' as const, latencyMs: 0, marketSlippageTicks: 0, stopSlippageTicks: 0,
  requireThroughTradeForLimit: false, feesEnabled: false, useBarRange: true,
};
let fixture: TestFixture;
let seq = 0;
const cid = (s: string) => `${s}-${(seq += 1)}-${Date.now()}`;

afterEach(async () => {
  const f = fixture;
  fixture = undefined as unknown as TestFixture;
  await f?.close();
});

describe('Part IX — execution and position cannot diverge under a mid-fill crash', () => {
  // Fault at each write index across the fill path; after any crash point the
  // stored position must equal the execution-derived position (both present, or
  // both absent). A rolled-back fill leaves the working order to fill on replay.
  for (const tripAt of [2, 3, 4, 5]) {
    it(`a fault at write #${tripAt} leaves execution/position consistent`, async () => {
      fixture = await createFixture({ environment: CLEAN_ENV, maxContracts: 10 });
      const market = new ScriptedMarket();
      await market.quote('NQ', 20_000, OPEN_MARKET_TS);
      const fx = new FaultInjector().failOnWrite(tripAt);
      const engine = new TradingEngine(fx.wrap(fixture.db), market);
      await engine.start();
      await engine
        .submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid('a'), symbol: 'NQ', side: 'BUY', qty: 2, type: 'MARKET' })
        .catch(() => undefined); // the fault may abort the fill; that is the point
      await settle(5);
      engine.stop();

      // Reconcile against the UNWRAPPED db: no divergence at any crash point.
      const lines = (await reconcileAccount(fixture.db, fixture.accountId)).filter(
        (l) => l.kind === 'POSITION_QTY' || l.kind === 'POSITION_COST_BASIS' || l.kind === 'POSITION_REALIZED' || l.kind === 'ACCOUNT_REALIZED',
      );
      expect(lines).toEqual([]);
    }, 60000);
  }

  it('a clean fill commits execution + position together and reconciles', async () => {
    fixture = await createFixture({ environment: CLEAN_ENV, maxContracts: 10 });
    const market = new ScriptedMarket();
    await market.quote('NQ', 20_000, OPEN_MARKET_TS);
    const engine = new TradingEngine(fixture.db, market);
    await engine.start();
    await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid('b'), symbol: 'NQ', side: 'BUY', qty: 2, type: 'MARKET' });
    await market.quote('NQ', 20_040, OPEN_MARKET_TS);
    await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid('c'), symbol: 'NQ', side: 'SELL', qty: 2, type: 'MARKET' });
    await settle(5);
    engine.stop();
    const execs = await fixture.db.select().from(executions).where(eq(executions.accountId, fixture.accountId));
    expect(execs.length).toBeGreaterThan(0);
    expect(await reconcileAccount(fixture.db, fixture.accountId)).toEqual([]);
  }, 60000);
});

describe('Part XII/XIII (RES-3) — the EOD roll is atomic and idempotent', () => {
  it('a fault during the roll writes neither the day stat nor the advanced counters; a clean replay does both, once', async () => {
    fixture = await createFixture({
      environment: CLEAN_ENV, maxContracts: 5, startingBalanceMicros: $(50_000),
      rules: { profitTargetMicros: $(1_000_000), maxLossMicros: $(2_000), drawdownType: 'EOD_TRAILING', trailingLockAtMicros: 0 },
    });
    const market = new ScriptedMarket();
    await market.quote('NQ', 20_000, OPEN_MARKET_TS);
    const engine = new TradingEngine(fixture.db, market);
    await engine.start();

    // DAY 0: realize +$1,000 (buy 1 @ 20,000, sell 1 @ 20,050).
    await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid('d'), symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' });
    await market.quote('NQ', 20_050, OPEN_MARKET_TS);
    await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid('e'), symbol: 'NQ', side: 'SELL', qty: 1, type: 'MARKET' });
    await settle(5);

    const before = await fixture.db.select().from(accounts).where(eq(accounts.id, fixture.accountId));
    const floorBefore = before[0]!.drawdownFloorMicros;
    const dateBefore = before[0]!.currentTradeDate;
    const statsBefore = (await fixture.db.select().from(dailyAccountStats).where(eq(dailyAccountStats.accountId, fixture.accountId))).length;
    engine.stop();

    // ROLL to DAY 1 under a fault inside the roll transaction (2nd write =
    // persistRuleState, after recordClosedDay). Atomic → BOTH roll back.
    const fx = new FaultInjector().failOnWrite(2);
    const fEngine = new TradingEngine(fx.wrap(fixture.db), market);
    await fEngine.start();
    await market.quote('NQ', 20_050, OPEN_MARKET_TS + DAY_MS);
    await fEngine.enforceRules(fixture.accountId).catch(() => undefined);
    fEngine.stop();

    const mid = await fixture.db.select().from(accounts).where(eq(accounts.id, fixture.accountId));
    const statsMid = (await fixture.db.select().from(dailyAccountStats).where(eq(dailyAccountStats.accountId, fixture.accountId))).length;
    // Neither the day stat nor the counter advance survived — no partial day.
    expect(statsMid).toBe(statsBefore);
    expect(mid[0]!.currentTradeDate).toBe(dateBefore);
    expect(mid[0]!.drawdownFloorMicros).toBe(floorBefore);

    // Clean replay: the roll completes; the floor ratchets and the day is recorded.
    const engine2 = new TradingEngine(fixture.db, market);
    await engine2.start();
    await market.quote('NQ', 20_050, OPEN_MARKET_TS + DAY_MS);
    await engine2.enforceRules(fixture.accountId);
    await settle(5);
    const after = await fixture.db.select().from(accounts).where(eq(accounts.id, fixture.accountId));
    const statsAfter = (await fixture.db.select().from(dailyAccountStats).where(eq(dailyAccountStats.accountId, fixture.accountId))).length;
    expect(after[0]!.drawdownFloorMicros).toBe($(49_000)); // ratcheted at the roll
    expect(statsAfter).toBe(statsBefore + 1);
    const dateAfter = after[0]!.currentTradeDate;

    // Idempotent replay: enforcing again rolls nothing new.
    await engine2.enforceRules(fixture.accountId);
    await settle(5);
    engine2.stop();
    const replay = await fixture.db.select().from(accounts).where(eq(accounts.id, fixture.accountId));
    const statsReplay = (await fixture.db.select().from(dailyAccountStats).where(eq(dailyAccountStats.accountId, fixture.accountId))).length;
    expect(statsReplay).toBe(statsAfter);
    expect(replay[0]!.drawdownFloorMicros).toBe($(49_000));
    expect(replay[0]!.currentTradeDate).toBe(dateAfter);
  }, 60000);
});
