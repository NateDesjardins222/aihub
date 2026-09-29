/**
 * Engineering Resilience Phase 2 — Parts X/XI: independent position + P&L
 * reconstruction across all 8 launch instruments, used as an integrity oracle.
 *
 * Drives REAL fills through the engine's genuine persistence path (real Postgres),
 * then recomputes each position and realized P&L a second, independent way from the
 * stored `executions` and asserts EXACT agreement with the stored `positions` /
 * `accounts` rows — no floating-point tolerance. Then it deliberately corrupts a
 * stored position and proves the oracle catches the divergence.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { requireInstrument } from '@atlas/instruments';
import { positions as positionsTable } from '../../db/schema.js';
import { TradingEngine } from '../../trading/engine.js';
import { ScriptedMarket, createFixture, type TestFixture } from '../../trading/harness.js';
import { reconcileAccount, reconstructPositionFromExecutions } from './reconcile.js';

const ALL = ['NQ', 'MNQ', 'ES', 'MES', 'GC', 'MGC', 'CL', 'MCL'] as const;

const CLEAN_ENV = {
  fillModel: 'SIMPLE' as const, latencyMs: 0, marketSlippageTicks: 0, stopSlippageTicks: 0,
  requireThroughTradeForLimit: false, feesEnabled: false, useBarRange: true,
};
const FEE_ENV = { ...CLEAN_ENV, feesEnabled: true };

let fixture: TestFixture;
let engine: TradingEngine;
let market: ScriptedMarket;
let seq = 0;
const cid = (s: string) => `${s}-${(seq += 1)}-${Date.now()}`;

async function setup(env = CLEAN_ENV): Promise<void> {
  fixture = await createFixture({
    environment: env, maxContracts: 100,
    instrumentLimits: { allowed: null, maxContracts: 100, perInstrument: {} },
  });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
}

/** A round, on-grid price near a plausible level for each instrument. */
function basePrice(symbol: string): number {
  switch (symbol) {
    case 'NQ': case 'MNQ': return 20_000;
    case 'ES': case 'MES': return 5_000;
    case 'GC': case 'MGC': return 2_000;
    case 'CL': case 'MCL': return 70;
    default: return 100;
  }
}

async function marketOrder(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number): Promise<void> {
  await market.quote(symbol, price);
  await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid('r'), symbol, side, qty, type: 'MARKET' });
}

afterEach(async () => {
  engine?.stop();
  const f = fixture;
  fixture = undefined as unknown as TestFixture;
  engine = undefined as unknown as TradingEngine;
  await f?.close();
});

describe('Part X/XI — position + P&L reconstruct exactly from executions (all 8 instruments)', () => {
  it('open → add → partial-reduce → close reconciles to zero discrepancies on every instrument', async () => {
    await setup();
    for (const symbol of ALL) {
      const spec = requireInstrument(symbol);
      const tick = spec.tickSizeScaled / 10 ** spec.pricePrecision;
      const p0 = basePrice(symbol);
      // open 2, add 2 (avg entry fractional across fills), reduce 1, close 3.
      await marketOrder(symbol, 'BUY', 2, p0);
      await marketOrder(symbol, 'BUY', 2, p0 + 4 * tick);
      await marketOrder(symbol, 'SELL', 1, p0 + 10 * tick);
      await marketOrder(symbol, 'SELL', 3, p0 + 6 * tick);
    }
    const lines = await reconcileAccount(fixture.db, fixture.accountId);
    expect(lines).toEqual([]);
  }, 60000);

  it('reversal through zero reconciles exactly', async () => {
    await setup();
    const symbol = 'NQ';
    const spec = requireInstrument(symbol);
    const tick = spec.tickSizeScaled / 10 ** spec.pricePrecision;
    const p0 = basePrice(symbol);
    await marketOrder(symbol, 'BUY', 2, p0);          // long 2
    await marketOrder(symbol, 'SELL', 5, p0 + 8 * tick); // close 2 + open short 3
    await marketOrder(symbol, 'BUY', 3, p0 + 2 * tick);  // close short 3 → flat
    const lines = await reconcileAccount(fixture.db, fixture.accountId);
    expect(lines).toEqual([]);
  }, 60000);

  it('fees are reconciled into the balance identity', async () => {
    await setup(FEE_ENV);
    const symbol = 'ES';
    const spec = requireInstrument(symbol);
    const tick = spec.tickSizeScaled / 10 ** spec.pricePrecision;
    const p0 = basePrice(symbol);
    await marketOrder(symbol, 'BUY', 2, p0);
    await marketOrder(symbol, 'SELL', 2, p0 + 4 * tick);
    const lines = await reconcileAccount(fixture.db, fixture.accountId);
    expect(lines).toEqual([]);
  }, 60000);

  it('is a real oracle: a corrupted stored realized P&L is detected', async () => {
    await setup();
    const symbol = 'GC';
    const spec = requireInstrument(symbol);
    const tick = spec.tickSizeScaled / 10 ** spec.pricePrecision;
    const p0 = basePrice(symbol);
    await marketOrder(symbol, 'BUY', 1, p0);
    await marketOrder(symbol, 'SELL', 1, p0 + 20 * tick);
    // Corrupt the stored position's realized P&L.
    await fixture.db.update(positionsTable).set({ realizedPnlMicros: 999_999_999 })
      .where(and(eq(positionsTable.accountId, fixture.accountId), eq(positionsTable.symbol, symbol)));
    const lines = await reconcileAccount(fixture.db, fixture.accountId);
    const realized = lines.find((l) => l.kind === 'POSITION_REALIZED');
    expect(realized).toBeDefined();
    expect(realized!.actual).toBe(999_999_999);
  }, 60000);

  it('is a real oracle: a corrupted account-level realized P&L is detected', async () => {
    await setup();
    const symbol = 'CL';
    const spec = requireInstrument(symbol);
    const tick = spec.tickSizeScaled / 10 ** spec.pricePrecision;
    const p0 = basePrice(symbol);
    await marketOrder(symbol, 'BUY', 1, p0);
    await marketOrder(symbol, 'SELL', 1, p0 + 5 * tick);
    const { accounts } = await import('../../db/schema.js');
    await fixture.db.update(accounts).set({ realizedPnlMicros: 123_456_789 }).where(eq(accounts.id, fixture.accountId));
    const lines = await reconcileAccount(fixture.db, fixture.accountId);
    expect(lines.some((l) => l.kind === 'ACCOUNT_REALIZED')).toBe(true);
    // Corrupting the account's realized also breaks the balance identity.
    expect(lines.some((l) => l.kind === 'BALANCE_IDENTITY')).toBe(true);
  }, 60000);

  it('pure reducer: a flat round-trip nets exactly the tick delta × value', () => {
    // 1 NQ, +10 ticks, $5/tick → +$50 = 50_000_000 micros, fees 0.
    const nq = reconstructPositionFromExecutions('NQ', [
      { symbol: 'NQ', side: 'BUY', qty: 1, priceTicks: 80_000, feesMicros: 0, seq: 1 },
      { symbol: 'NQ', side: 'SELL', qty: 1, priceTicks: 80_010, feesMicros: 0, seq: 2 },
    ]);
    expect(nq.qty).toBe(0);
    expect(nq.realizedPnlMicros).toBe(50_000_000);
  });
});
