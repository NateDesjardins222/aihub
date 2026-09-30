/**
 * Engineering Resilience Phase 3 — trading soak (Parts XXIV/XXV/XXVI).
 *
 * Long seeded execution sequences across all 8 instruments (open/add/reduce/close/
 * reverse/reopen), continuously reconciled against the execution-derived oracle;
 * plus a multi-day EOD-trailing drawdown soak and a time soak across day/month/DST
 * boundaries. Deterministic (seeded); no wall-clock sleeps.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { requireInstrument } from '@atlas/instruments';
import { accounts, dailyAccountStats } from '../../db/schema.js';
import { TradingEngine } from '../../trading/engine.js';
import { OPEN_MARKET_TS, ScriptedMarket, createFixture, settle, type TestFixture } from '../../trading/harness.js';
import { reconcileAccount } from './reconcile.js';
import { Prng } from './model/prng.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
const DAY_MS = 24 * 60 * 60 * 1000;
const ALL = ['NQ', 'MNQ', 'ES', 'MES', 'GC', 'MGC', 'CL', 'MCL'] as const;
const CLEAN_ENV = {
  fillModel: 'SIMPLE' as const, latencyMs: 0, marketSlippageTicks: 0, stopSlippageTicks: 0,
  requireThroughTradeForLimit: false, feesEnabled: false, useBarRange: true,
};
let fixture: TestFixture;
let seqNo = 0;
const cid = (s: string) => `${s}-${(seqNo += 1)}`;

function base(sym: string): number {
  switch (sym) { case 'NQ': case 'MNQ': return 20_000; case 'ES': case 'MES': return 5_000; case 'GC': case 'MGC': return 2_000; default: return 70; }
}

afterEach(async () => { const f = fixture; fixture = undefined as unknown as TestFixture; await f?.close(); });

describe('Part XXIV — position soak: stored position reconciles to executions across all 8 instruments', () => {
  it('a long seeded fill sequence stays exactly reconciled throughout and at the end', async () => {
    fixture = await createFixture({ environment: CLEAN_ENV, maxContracts: 100, instrumentLimits: { allowed: null, maxContracts: 100, perInstrument: {} } });
    const market = new ScriptedMarket();
    const engine = new TradingEngine(fixture.db, market);
    await engine.start();
    for (const s of ALL) await market.quote(s, base(s), OPEN_MARKET_TS);

    const rng = new Prng(90210);
    const FILLS = 240; // 8 instruments × ~30 fills
    let reconChecks = 0;
    for (let i = 0; i < FILLS; i += 1) {
      const sym = ALL[rng.int(0, ALL.length - 1)]!;
      const spec = requireInstrument(sym);
      const tick = spec.tickSizeScaled / 10 ** spec.pricePrecision;
      const price = base(sym) + rng.int(-40, 40) * tick;
      await market.quote(sym, price, OPEN_MARKET_TS);
      const side = rng.bool() ? 'BUY' : 'SELL';
      const qty = rng.int(1, 4);
      await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid('t'), symbol: sym, side, qty, type: 'MARKET' }).catch(() => undefined);
      if (i % 20 === 19) {
        reconChecks += 1;
        const lines = (await reconcileAccount(fixture.db, fixture.accountId)).filter((l) => l.kind.startsWith('POSITION') || l.kind === 'ACCOUNT_REALIZED' || l.kind === 'ACCOUNT_FEES');
        expect(lines).toEqual([]);
      }
    }
    await settle(5);
    engine.stop();
    // eslint-disable-next-line no-console
    console.log(`[soak position] fills=${FILLS} reconChecks=${reconChecks}`);
    expect(await reconcileAccount(fixture.db, fixture.accountId)).toEqual([]);
  }, 120000);
});

describe('Part XXV/XXVI — drawdown + time soak: floor monotonic, one EOD per day, across many days', () => {
  it('rolls many days with mixed P&L over month and DST boundaries; floor never regresses', async () => {
    fixture = await createFixture({
      environment: CLEAN_ENV, maxContracts: 5, startingBalanceMicros: $(50_000),
      rules: { profitTargetMicros: $(1_000_000), maxLossMicros: $(2_000), drawdownType: 'EOD_TRAILING', trailingLockAtMicros: 0 },
    });
    const market = new ScriptedMarket();
    const engine = new TradingEngine(fixture.db, market);
    await engine.start();
    await market.quote('NQ', 20_000, OPEN_MARKET_TS);

    const rng = new Prng(1789);
    const NQ = requireInstrument('NQ');
    const tick = NQ.tickSizeScaled / 10 ** NQ.pricePrecision;
    let prevFloor = -Infinity;
    let day = 0;
    const DAYS = 40; // spans > 1 month incl. weekends/DST via exchange timestamps
    let px = 20_000;
    for (let d = 0; d < DAYS; d += 1) {
      const ts = OPEN_MARKET_TS + d * DAY_MS;
      // Intraday: a couple of round trips producing a seeded net P&L.
      await market.quote('NQ', px, ts);
      await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid('b'), symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET' }).catch(() => undefined);
      const move = rng.int(-30, 40) * tick; // slight positive drift
      px = Math.max(19_000, px + move);
      await market.quote('NQ', px, ts);
      await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid('s'), symbol: 'NQ', side: 'SELL', qty: 1, type: 'MARKET' }).catch(() => undefined);
      // Roll to the next day.
      await market.quote('NQ', px, OPEN_MARKET_TS + (d + 1) * DAY_MS);
      await engine.enforceRules(fixture.accountId);
      await settle(2);
      const [acct] = await fixture.db.select().from(accounts).where(eq(accounts.id, fixture.accountId));
      if (!acct) break;
      // Floor monotonic (never regresses).
      expect(acct.drawdownFloorMicros).toBeGreaterThanOrEqual(prevFloor);
      prevFloor = acct.drawdownFloorMicros;
      // Floor never exceeds the lock (starting balance) for a trailing-to-lock config.
      expect(acct.drawdownFloorMicros).toBeLessThanOrEqual($(50_000));
      if (acct.status === 'FAILED') { day = d; break; }
      day = d;
    }
    engine.stop();
    // Exactly one daily_account_stats row per finalized day (no double EOD).
    const stats = await fixture.db.select().from(dailyAccountStats).where(eq(dailyAccountStats.accountId, fixture.accountId));
    const dates = stats.map((s) => s.tradeDate);
    expect(new Set(dates).size).toBe(dates.length); // no duplicate day
    // eslint-disable-next-line no-console
    console.log(`[soak drawdown] daysRolled=${day + 1} finalizedDays=${stats.length} finalFloor=${prevFloor / M}`);
    expect(await reconcileAccount(fixture.db, fixture.accountId)).toEqual([]);
  }, 120000);
});
