import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { requireInstrument } from '@atlas/instruments';
import { orders as ordersTable, positions as positionsTable, trades } from '../db/schema.js';
import { TradingEngine } from './engine.js';
import { OPEN_MARKET_TS, ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';

/**
 * The protective legs, end to end.
 *
 * A stop that is drawn on the chart but never fills is worse than no stop at
 * all, so these tests follow the WHOLE chain rather than the visual: entry fill
 * -> bracket creation -> working children -> a genuine observation that reaches
 * the price -> a fill at a defensible price -> the OCO sibling canceled ->
 * position flat -> a closed trade recorded.
 *
 * Every case runs twice: once against a live delayed feed and once in replay,
 * because those two use DIFFERENT clocks for latency eligibility and a bug in
 * one is invisible from the other.
 */

const NQ = requireInstrument('NQ');
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

async function setup(replay: boolean): Promise<void> {
  fixture = await createFixture({ environment: CLEAN_ENV });
  market = new ScriptedMarket();
  market.setReplay(replay);
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
    clientOrderId: cid('br'),
    symbol: 'NQ',
    side: 'BUY',
    qty: 1,
    type: 'MARKET',
    ...input,
  });
}

async function orderRows() {
  return fixture.db.select().from(ordersTable).where(eq(ordersTable.accountId, fixture.accountId));
}

async function positionRow() {
  const [row] = await fixture.db
    .select()
    .from(positionsTable)
    .where(and(eq(positionsTable.accountId, fixture.accountId), eq(positionsTable.symbol, 'NQ')));
  return row;
}

async function tradeRows() {
  return fixture.db.select().from(trades).where(eq(trades.accountId, fixture.accountId));
}

async function leg(role: 'STOP_LOSS' | 'TAKE_PROFIT') {
  return (await orderRows()).find((r) => r.bracketRole === role);
}

afterEach(async () => {
  engine?.stop();
  await fixture?.close();
});

/** One minute of market time per scripted bar, like the live fine series. */
let barTs = OPEN_MARKET_TS;
function nextTs(): number {
  barTs += 60_000;
  return barTs;
}

for (const replay of [false, true]) {
  const mode = replay ? 'replay' : 'live';

  describe(`bracket execution (${mode})`, () => {
    beforeEach(async () => {
      barTs = OPEN_MARKET_TS;
      await setup(replay);
      await market.quote('NQ', 20_000, nextTs());
    });

    it('fills the stop loss on a long when a genuine bar reaches it', async () => {
      await submit({ qty: 1, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
      await settle();

      const stop = await leg('STOP_LOSS');
      expect(stop, 'a bracket must create a stop').toBeDefined();
      expect(stop!.status).toBe('WORKING');
      // 20 000 - 40 ticks x 0.25 = 19 990
      expect(stop!.stopTicks! / 4).toBeCloseTo(19_990, 6);

      // A bar whose LOW trades through the stop. Nothing before it comes close,
      // so the fill can only come from this observation.
      await market.bar('NQ', { open: 20_000, high: 20_001, low: 19_985, close: 19_995 }, nextTs());
      await settle(60);

      expect((await leg('STOP_LOSS'))!.status, 'the stop must fill').toBe('FILLED');
      expect((await leg('TAKE_PROFIT'))!.status, 'OCO must cancel the target').toBe('CANCELED');
      expect((await positionRow())!.qty).toBe(0);
      expect(await tradeRows()).toHaveLength(1);
    }, 30_000);

    it('fills the take profit on a long when a genuine bar reaches it', async () => {
      await submit({ qty: 1, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
      await settle();

      // 20 000 + 80 ticks x 0.25 = 20 020
      await market.bar('NQ', { open: 20_000, high: 20_030, low: 19_999, close: 20_025 }, nextTs());
      await settle(60);

      expect((await leg('TAKE_PROFIT'))!.status).toBe('FILLED');
      expect((await leg('STOP_LOSS'))!.status).toBe('CANCELED');
      expect((await positionRow())!.qty).toBe(0);
    }, 30_000);

    it('fills the stop loss on a short when a genuine bar reaches it', async () => {
      await submit({ qty: 1, side: 'SELL', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
      await settle();

      const stop = await leg('STOP_LOSS');
      expect(stop!.stopTicks! / 4).toBeCloseTo(20_010, 6);

      await market.bar('NQ', { open: 20_000, high: 20_015, low: 19_999, close: 20_012 }, nextTs());
      await settle(60);

      expect((await leg('STOP_LOSS'))!.status).toBe('FILLED');
      expect((await leg('TAKE_PROFIT'))!.status).toBe('CANCELED');
      expect((await positionRow())!.qty).toBe(0);
    }, 30_000);

    it('fills the take profit on a short when a genuine bar reaches it', async () => {
      await submit({ qty: 1, side: 'SELL', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
      await settle();

      await market.bar('NQ', { open: 20_000, high: 20_001, low: 19_975, close: 19_978 }, nextTs());
      await settle(60);

      expect((await leg('TAKE_PROFIT'))!.status).toBe('FILLED');
      expect((await leg('STOP_LOSS'))!.status).toBe('CANCELED');
      expect((await positionRow())!.qty).toBe(0);
    }, 30_000);

    it('fills a stop that the trader dragged to a new price', async () => {
      await submit({ qty: 1, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
      await settle();

      const before = (await leg('STOP_LOSS'))!;
      // Drag the stop up to 19 996, well inside the original 19 990.
      await engine.modifyOrder(fixture.accountId, before.id, { stopTicks: 19_996 * 4 });
      await settle();
      expect((await leg('STOP_LOSS'))!.stopTicks! / 4).toBeCloseTo(19_996, 6);

      // A bar that reaches the NEW stop but not the old one.
      await market.bar('NQ', { open: 20_000, high: 20_002, low: 19_994, close: 19_998 }, nextTs());
      await settle(60);

      expect((await leg('STOP_LOSS'))!.status).toBe('FILLED');
      expect((await positionRow())!.qty).toBe(0);
    }, 30_000);

    it('protects each partial as it fills and then closes the whole position', async () => {
      await submit({
        qty: 3,
        side: 'BUY',
        type: 'LIMIT',
        limitTicks: 20_000 * 4,
        bracket: { stopLossTicks: 40, takeProfitTicks: 80 },
      });
      await settle();

      // Liquidity capped so each observation fills one contract.
      await market.bar('NQ', { open: 20_000, high: 20_002, low: 19_998, close: 20_000 }, nextTs());
      await settle(60);
      const partial = (await positionRow())!.qty;
      expect(partial).toBeGreaterThan(0);
      const stopAfterPartial = await leg('STOP_LOSS');
      expect(stopAfterPartial, 'a partial fill must still be protected').toBeDefined();
      expect(stopAfterPartial!.qty).toBe(partial);

      await market.bar('NQ', { open: 19_998, high: 20_000, low: 19_980, close: 19_985 }, nextTs());
      await settle(60);

      expect((await leg('STOP_LOSS'))!.status).toBe('FILLED');
      expect((await positionRow())!.qty).toBe(0);
    }, 30_000);
  });
}
