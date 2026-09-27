/**
 * Product Recovery Phase 3 — bracket/OCO safety across reconnect (STEP 6) and
 * account switching (STEP 7). Real Postgres + ScriptedMarket.
 *
 * Reconnect: server bracket/OCO state is authoritative and durable — a fresh
 * read (client reconnect) returns exactly the two protective legs with no
 * duplicate and no missing protection, and after a full engine restart (server
 * reconnect) the surviving bracket still fills its OCO correctly with no orphan.
 *
 * Account switching: operations addressed to account A never touch account B's
 * orders/positions, and flattening A cancels only A's protective legs. Any
 * cross-account mutation would be a P0.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { requireInstrument } from '@atlas/instruments';
import { orders as ordersTable, positions as positionsTable } from '../db/schema.js';
import { TradingEngine } from './engine.js';
import { OPEN_MARKET_TS, ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';

requireInstrument('NQ');
const CLEAN_ENV = {
  fillModel: 'SIMPLE' as const, latencyMs: 0, marketSlippageTicks: 0, stopSlippageTicks: 0,
  requireThroughTradeForLimit: false, feesEnabled: false, useBarRange: true,
};
let seq = 0;
const cid = (): string => `brx-${(seq += 1)}-${Date.now()}`;
let barTs = OPEN_MARKET_TS;
const nextTs = (): number => (barTs += 60_000);

async function legs(db: TestFixture['db'], accountId: string) {
  const rows = await db.select().from(ordersTable).where(eq(ordersTable.accountId, accountId));
  const byRole = (role: string) => rows.filter((r) => (r as Record<string, unknown>)['bracketRole'] === role);
  const slAll = byRole('STOP_LOSS');
  const tpAll = byRole('TAKE_PROFIT');
  return {
    all: rows,
    slAll,
    tpAll,
    sl: slAll[0],
    tp: tpAll[0],
    // Protective = the OCO pair only (STOP_LOSS + TAKE_PROFIT); the bracket also
    // carries an ENTRY leg, which is not a protective order.
    protective: rows.filter((r) => {
      const role = (r as Record<string, unknown>)['bracketRole'];
      return role === 'STOP_LOSS' || role === 'TAKE_PROFIT';
    }),
    workingProtective: rows.filter((r) => {
      const role = (r as Record<string, unknown>)['bracketRole'];
      return (role === 'STOP_LOSS' || role === 'TAKE_PROFIT') && (r as Record<string, unknown>)['status'] === 'WORKING';
    }),
  };
}
async function pos(db: TestFixture['db'], accountId: string) {
  const [r] = await db.select().from(positionsTable).where(and(eq(positionsTable.accountId, accountId), eq(positionsTable.symbol, 'NQ')));
  return r as Record<string, unknown> | undefined;
}

describe('bracket/OCO safety — reconnect (server restart durability)', () => {
  let fixture: TestFixture; let market: ScriptedMarket; let engine: TradingEngine;
  beforeEach(async () => {
    barTs = OPEN_MARKET_TS;
    fixture = await createFixture({ environment: CLEAN_ENV });
    market = new ScriptedMarket();
    engine = new TradingEngine(fixture.db, market);
    await engine.start();
    await market.quote('NQ', 20_000, nextTs());
  });
  afterEach(async () => { engine?.stop(); await fixture?.close(); });

  it('a bracket survives a reconnect with no duplicate/missing legs and its OCO still fires', async () => {
    await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid(), symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    await settle(60);

    // Client reconnect: a fresh read of authoritative state shows exactly one
    // WORKING stop-loss and one WORKING take-profit — no duplicate protective
    // leg, no missing protection.
    let l = await legs(fixture.db, fixture.accountId);
    expect(l.slAll, 'exactly one stop-loss leg').toHaveLength(1);
    expect(l.tpAll, 'exactly one take-profit leg').toHaveLength(1);
    expect(l.protective, 'exactly the OCO pair, no duplicates').toHaveLength(2);
    expect(l.sl!.status).toBe('WORKING');
    expect(l.tp!.status).toBe('WORKING');
    expect((await pos(fixture.db, fixture.accountId))!['qty']).toBe(1);

    // Server reconnect: stop the engine and bring up a fresh one on the same DB.
    engine.stop();
    const engine2 = new TradingEngine(fixture.db, market);
    await engine2.start();
    engine = engine2;

    // Still exactly one WORKING SL + one WORKING TP after restart (durable, not
    // re-created, not duplicated).
    l = await legs(fixture.db, fixture.accountId);
    expect(l.slAll).toHaveLength(1);
    expect(l.tpAll).toHaveLength(1);
    expect(l.workingProtective, 'both protective legs still working after restart').toHaveLength(2);
    expect(l.sl!.status).toBe('WORKING');
    expect(l.tp!.status).toBe('WORKING');

    // A bar reaches the take-profit (20,020) → TP fills, OCO cancels the stop,
    // position flat, no orphan protective order remains.
    await market.bar('NQ', { open: 20_000, high: 20_030, low: 19_999, close: 20_025 }, nextTs());
    await settle(80);
    l = await legs(fixture.db, fixture.accountId);
    expect(l.tp!.status).toBe('FILLED');
    expect(l.sl!.status).toBe('CANCELED');
    expect((await pos(fixture.db, fixture.accountId))!['qty']).toBe(0);
    expect(l.workingProtective, 'no orphan protective order').toHaveLength(0);
  }, 30_000);
});

describe('bracket/OCO safety — account-switch isolation', () => {
  let A: TestFixture; let B: TestFixture; let market: ScriptedMarket; let engine: TradingEngine;
  beforeEach(async () => {
    barTs = OPEN_MARKET_TS;
    A = await createFixture({ environment: CLEAN_ENV });
    B = await createFixture({ environment: CLEAN_ENV });
    market = new ScriptedMarket();
    // One engine on A's DB handle (same atlas_test DB holds both accounts); the
    // server acts on whatever accountId the command names.
    engine = new TradingEngine(A.db, market);
    await engine.start();
    await market.quote('NQ', 20_000, nextTs());
  });
  afterEach(async () => { engine?.stop(); await B?.close(); await A?.close(); });

  it('operating account A never mutates account B, and flatten A cancels only A\'s bracket', async () => {
    // A: long + bracket (two WORKING protective legs).
    await engine.submitOrder({ accountId: A.accountId, userId: A.userId, clientOrderId: cid(), symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    await settle(60);
    // B: an independent long, no bracket.
    await engine.submitOrder({ accountId: B.accountId, userId: B.userId, clientOrderId: cid(), symbol: 'NQ', side: 'BUY', qty: 2, type: 'MARKET' });
    await settle(60);

    const aLegs = await legs(A.db, A.accountId);
    expect(aLegs.slAll, 'A has exactly one stop-loss').toHaveLength(1);
    expect(aLegs.tpAll, 'A has exactly one take-profit').toHaveLength(1);
    expect(aLegs.protective, 'A has exactly the OCO pair').toHaveLength(2);
    // Every A order belongs to A; every B order belongs to B (no contamination).
    for (const r of aLegs.all) expect((r as Record<string, unknown>)['accountId']).toBe(A.accountId);
    const bOrdersBefore = await A.db.select().from(ordersTable).where(eq(ordersTable.accountId, B.accountId));
    for (const r of bOrdersBefore) expect((r as Record<string, unknown>)['accountId']).toBe(B.accountId);
    expect((await pos(A.db, B.accountId))!['qty']).toBe(2);

    // Flatten A. Only A is addressed.
    await engine.flatten(A.accountId, A.userId, 'NQ');
    await settle(60);

    // A is flat and BOTH protective legs are canceled (none left working).
    expect((await pos(A.db, A.accountId))!['qty']).toBe(0);
    const aAfter = await legs(A.db, A.accountId);
    expect(aAfter.workingProtective, 'A bracket fully canceled on flatten').toHaveLength(0);

    // B is completely untouched: same position, same orders.
    expect((await pos(A.db, B.accountId))!['qty']).toBe(2);
    const bOrdersAfter = await A.db.select().from(ordersTable).where(eq(ordersTable.accountId, B.accountId));
    expect(bOrdersAfter.length).toBe(bOrdersBefore.length);
    for (const r of bOrdersAfter) {
      expect((r as Record<string, unknown>)['accountId']).toBe(B.accountId);
      const before = bOrdersBefore.find((x) => (x as Record<string, unknown>)['id'] === (r as Record<string, unknown>)['id']);
      expect((r as Record<string, unknown>)['status']).toBe((before as Record<string, unknown>)['status']);
    }
  }, 30_000);
});
