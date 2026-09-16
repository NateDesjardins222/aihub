import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { requireInstrument } from '@atlas/instruments';
import {
  accounts,
  executions as executionsTable,
  orders as ordersTable,
  positions as positionsTable,
} from '../db/schema.js';
import { TradingEngine, OrderRejectedError } from './engine.js';
import { ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';

/**
 * Adversarial scenarios.
 *
 * Each of these is a way a real trader breaks a simulator: dragging an order
 * while the market moves under it, hammering modify, reducing a position by
 * hand while its bracket is still sized for the original, or breaching a rule
 * in the middle of a partial fill. They are integration tests against a real
 * database because every one of them is about ordering and persistence.
 */

const NQ = requireInstrument('NQ');
const D = 1_000_000;

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

async function setup(options: Parameters<typeof createFixture>[0] = {}): Promise<void> {
  fixture = await createFixture({ environment: CLEAN_ENV, ...options });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
}

function cid(label: string): string {
  seq += 1;
  return `${label}-${seq}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function submit(input: Partial<Parameters<TradingEngine['submitOrder']>[0]> = {}) {
  return engine.submitOrder({
    accountId: fixture.accountId,
    userId: fixture.userId,
    clientOrderId: cid('a'),
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

async function positionQty(): Promise<number> {
  const [row] = await fixture.db
    .select()
    .from(positionsTable)
    .where(eq(positionsTable.accountId, fixture.accountId));
  return row?.qty ?? 0;
}

async function executionCount(): Promise<number> {
  const rows = await fixture.db
    .select()
    .from(executionsTable)
    .where(eq(executionsTable.accountId, fixture.accountId));
  return rows.length;
}

afterEach(async () => {
  engine.stop();
  await fixture.close();
});

// ------------------------------------------------- dragging and modifying ---

describe('dragging an order while the market moves', () => {
  beforeEach(async () => {
    await setup();
  });

  it('survives a modify landing between two market events', async () => {
    await market.quote('NQ', 20_000);
    const submitted = await submit({
      qty: 1,
      side: 'BUY',
      type: 'LIMIT',
      limitTicks: 19_900 * 4,
    });
    const orderId = submitted.orders[0]!.id;
    await settle(20);

    // A burst of marks and a drag interleaved, exactly as a drag on a live
    // chart produces: the price under the order changes while it is moving.
    const moves: Array<Promise<unknown>> = [];
    for (let i = 0; i < 12; i += 1) {
      moves.push(market.quote('NQ', 20_000 - i));
      moves.push(
        engine
          .modifyOrder(fixture.accountId, orderId, { limitTicks: (19_900 + i) * 4 })
          .catch(() => undefined),
      );
    }
    await Promise.all(moves);
    await settle(60);

    const [order] = await orderRows();
    // Whatever order they landed in, the order is consistent: one order, one
    // price, and no accidental fill from a price the market never reached.
    expect((await orderRows()).length).toBe(1);
    expect(order!.status === 'WORKING' || order!.status === 'FILLED').toBe(true);
    if (order!.status === 'FILLED') {
      expect(order!.filledQty).toBe(1);
      expect(await executionCount()).toBe(1);
    }
  });

  it('refuses a drag that carries a stale version', async () => {
    await market.quote('NQ', 20_000);
    const submitted = await submit({ qty: 2, side: 'BUY', type: 'LIMIT', limitTicks: 19_900 * 4 });
    const orderId = submitted.orders[0]!.id;
    await settle(20);

    await engine.modifyOrder(fixture.accountId, orderId, { limitTicks: 19_910 * 4 });

    // The drag started before that modify: its version is now behind.
    await expect(
      engine.modifyOrder(fixture.accountId, orderId, { limitTicks: 19_950 * 4 }, 0),
    ).rejects.toBeInstanceOf(OrderRejectedError);

    const [order] = await orderRows();
    expect(order!.limitTicks).toBe(19_910 * 4);
  });

  it('holds up under a hundred rapid modifications', async () => {
    await market.quote('NQ', 20_000);
    const submitted = await submit({ qty: 1, side: 'BUY', type: 'LIMIT', limitTicks: 19_800 * 4 });
    const orderId = submitted.orders[0]!.id;
    await settle(20);

    for (let i = 1; i <= 100; i += 1) {
      await engine.modifyOrder(fixture.accountId, orderId, { limitTicks: (19_800 + i) * 4 });
    }
    await settle(40);

    const [order] = await orderRows();
    expect(order!.limitTicks).toBe(19_900 * 4);
    expect(order!.version).toBeGreaterThanOrEqual(100);
    expect(order!.status).toBe('WORKING');
    expect(await executionCount()).toBe(0);
  });

  it('cannot be dragged onto a price that fills it twice', async () => {
    await market.quote('NQ', 20_000);
    const submitted = await submit({ qty: 1, side: 'BUY', type: 'LIMIT', limitTicks: 19_900 * 4 });
    const orderId = submitted.orders[0]!.id;
    await settle(20);

    // Drag it through the market: it becomes marketable and fills once.
    await engine.modifyOrder(fixture.accountId, orderId, { limitTicks: 20_050 * 4 });
    await settle(40);
    // Then keep dragging the now-filled order.
    for (let i = 0; i < 5; i += 1) {
      await engine
        .modifyOrder(fixture.accountId, orderId, { limitTicks: (20_060 + i) * 4 })
        .catch(() => undefined);
    }
    await settle(40);

    expect(await positionQty()).toBe(1);
    expect(await executionCount()).toBe(1);
  });
});

// ------------------------------------------------------- churn and racing ---

describe('churn', () => {
  beforeEach(async () => {
    await setup();
  });

  it('leaves nothing working after a submit-and-cancel storm', async () => {
    await market.quote('NQ', 20_000);

    for (let i = 0; i < 25; i += 1) {
      const change = await submit({
        qty: 1,
        side: 'BUY',
        type: 'LIMIT',
        limitTicks: (19_000 + i) * 4,
      });
      const id = change.orders.find((o) => o.status === 'WORKING')?.id;
      if (id) await engine.cancelOrder(fixture.accountId, id);
    }
    await settle(60);

    const rows = await orderRows();
    expect(rows.filter((r) => r.status === 'WORKING')).toHaveLength(0);
    expect(rows).toHaveLength(25);
    expect(await positionQty()).toBe(0);
  });

  it('never double-fills when market events and an order arrive together', async () => {
    await market.quote('NQ', 20_000);

    const work: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i += 1) work.push(market.quote('NQ', 20_000 + i * 0.25));
    work.push(submit({ qty: 3, side: 'BUY' }));
    for (let i = 0; i < 10; i += 1) work.push(market.quote('NQ', 20_002 - i * 0.25));
    await Promise.all(work);
    await settle(80);

    expect(await positionQty()).toBe(3);
    expect(await executionCount()).toBe(1);
  });

  it('keeps a bracket consistent while the entry fills in pieces', async () => {
    await setup({ environment: { ...CLEAN_ENV, maxContractsPerFill: 1 } });
    await market.quote('NQ', 20_000);
    await submit({ qty: 3, side: 'BUY', bracket: { stopLossTicks: 80, takeProfitTicks: 200 } });

    // Each mark fills one more lot; the bracket has to grow with it and never
    // exceed what is actually open.
    for (let i = 0; i < 4; i += 1) {
      await market.quote('NQ', 20_000);
      await settle(40);
      const qty = await positionQty();
      const rows = await orderRows();
      const legs = rows.filter(
        (r) =>
          (r.bracketRole === 'STOP_LOSS' || r.bracketRole === 'TAKE_PROFIT') &&
          (r.status === 'WORKING' || r.status === 'PARTIALLY_FILLED'),
      );
      for (const leg of legs) expect(leg.qty).toBeLessThanOrEqual(Math.max(1, qty));
    }

    expect(await positionQty()).toBe(3);
    const legs = (await orderRows()).filter(
      (r) => r.bracketRole === 'STOP_LOSS' || r.bracketRole === 'TAKE_PROFIT',
    );
    expect(legs.every((l) => l.qty === 3)).toBe(true);
  });
});

// ------------------------------------------------ rules under adverse play ---

describe('rules under adverse play', () => {
  it('a drawdown breach during a partial entry closes exactly what filled', async () => {
    await setup({
      environment: { ...CLEAN_ENV, maxContractsPerFill: 1 },
      startingBalanceMicros: 50_000 * D,
      rules: { maxLossMicros: 900 * D, drawdownType: 'STATIC' },
    });
    await market.quote('NQ', 20_000);
    await submit({ qty: 5, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 20_000);
    await settle(30);
    const filled = await positionQty();
    expect(filled).toBeGreaterThan(0);

    // Now break the account while the entry still has quantity left to fill.
    await market.quote('NQ', 19_950);
    await settle(80);

    const [account] = await fixture.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, fixture.accountId));
    expect(account!.status).toBe('FAILED');

    // The entry is canceled at once: nothing more may fill into a failed
    // account. The position itself closes at the rate the liquidity cap allows,
    // one lot per market event, which is the same constraint any other order
    // faces - a breach does not get a magic exit.
    const entry = (await orderRows()).find((r) => r.bracketRole === 'STANDALONE' && r.qty === 5);
    expect(entry!.status === 'CANCELED' || entry!.status === 'PARTIALLY_FILLED').toBe(true);
    // It may have filled one more lot on the very observation that broke the
    // account: that fill was evaluated against an account which was still
    // active, and pretending otherwise would be rewriting history.
    expect(entry!.filledQty).toBeGreaterThanOrEqual(filled);
    expect(entry!.filledQty).toBeLessThan(5);

    for (let i = 0; i < 6; i += 1) {
      await market.quote('NQ', 19_950);
      await settle(40);
    }
    expect(await positionQty()).toBe(0);
    const working = (await orderRows()).filter(
      (r) => r.status === 'WORKING' || r.status === 'PARTIALLY_FILLED',
    );
    expect(working).toHaveLength(0);
  });

  it('refuses every order type once the account is locked', async () => {
    await setup({
      startingBalanceMicros: 50_000 * D,
      rules: { maxLossMicros: 10_000 * D, dailyLossLimitMicros: 400 * D },
    });
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 19_975);
    await settle(80);

    for (const type of ['MARKET', 'LIMIT', 'STOP_MARKET'] as const) {
      await expect(
        submit({
          qty: 1,
          type,
          limitTicks: type === 'LIMIT' ? 19_000 * 4 : undefined,
          stopTicks: type === 'STOP_MARKET' ? 21_000 * 4 : undefined,
        }),
      ).rejects.toMatchObject({ reason: 'ACCOUNT_LOCKED' });
    }
  });

  it('a reduction by hand resizes the bracket before the stop can reverse it', async () => {
    await setup({ startingBalanceMicros: 50_000 * D, rules: { maxLossMicros: 20_000 * D } });
    await market.quote('NQ', 20_000);
    await submit({ qty: 4, side: 'BUY', bracket: { stopLossTicks: 100, takeProfitTicks: 400 } });
    await settle(40);

    // Sell three by hand. The stop was sized for four.
    await submit({ qty: 3, side: 'SELL' });
    await settle(60);
    expect(await positionQty()).toBe(1);

    // Now run the stop. If the bracket had not resized, this would flip the
    // account short three.
    await market.quote('NQ', 19_970);
    await settle(80);

    expect(await positionQty()).toBe(0);
  });
});
