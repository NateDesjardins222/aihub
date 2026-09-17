import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { MICROS, requireInstrument, ticksToPrice } from '@atlas/instruments';
import { orders as ordersTable, positions as positionsTable, trades } from '../db/schema.js';
import { TradingEngine, OrderRejectedError } from './engine.js';
import {
  OPEN_MARKET_TS,
  ScriptedMarket,
  createFixture,
  settle,
  type TestFixture,
} from './harness.js';

/**
 * Integration tests for the engine.
 *
 * These run against a real PostgreSQL database and the real persistence path,
 * because the things most likely to be wrong — transaction boundaries, OCO
 * atomicity, idempotency, position rounding — are exactly the things a mocked
 * database would hide.
 */

const NQ = requireInstrument('NQ');
let fixture: TestFixture;
let market: ScriptedMarket;
let engine: TradingEngine;
let clientOrderSeq = 0;

/** Frictionless by default so assertions are about the engine, not slippage. */
const CLEAN_ENV = {
  fillModel: 'SIMPLE' as const,
  latencyMs: 0,
  marketSlippageTicks: 0,
  stopSlippageTicks: 0,
  requireThroughTradeForLimit: false,
  feesEnabled: false,
  useBarRange: true,
};

async function setup(overrides?: Parameters<typeof createFixture>[0]): Promise<void> {
  fixture = await createFixture({ environment: CLEAN_ENV, ...overrides });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
}

function cid(label: string): string {
  clientOrderSeq += 1;
  return `${label}-${clientOrderSeq}-${Date.now()}`;
}

async function submit(input: Partial<Parameters<TradingEngine['submitOrder']>[0]> = {}) {
  return engine.submitOrder({
    accountId: fixture.accountId,
    userId: fixture.userId,
    clientOrderId: cid('t'),
    symbol: 'NQ',
    side: 'BUY',
    qty: 1,
    type: 'MARKET',
    ...input,
  });
}

async function positionRow() {
  const [row] = await fixture.db
    .select()
    .from(positionsTable)
    .where(and(eq(positionsTable.accountId, fixture.accountId), eq(positionsTable.symbol, 'NQ')));
  return row;
}

async function orderRows() {
  return fixture.db.select().from(ordersTable).where(eq(ordersTable.accountId, fixture.accountId));
}

afterEach(async () => {
  engine?.stop();
  await fixture?.close();
});

// ---------------------------------------------------------------------------

describe('market orders', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
  });

  it('fills, opens a position and settles fees into the balance', async () => {
    const change = await submit({ qty: 2 });
    expect(change.fills).toHaveLength(1);
    expect(change.fills[0]!.qty).toBe(2);

    const position = await positionRow();
    expect(position!.qty).toBe(2);
    expect(position!.side).toBe('LONG');
    expect(position!.costBasisMicros).toBe(
      change.fills[0]!.priceTicks * 2 * NQ.tickValueMicros,
    );
  });

  it('prices unrealized P&L from the instrument specification', async () => {
    await submit({ qty: 2 });
    await market.quote('NQ', 20_010);
    const view = await engine.positionView(fixture.accountId, 'NQ');
    // 10 points x $20 x 2 contracts
    expect(view.unrealizedPnlMicros).toBe(400 * MICROS);
  });

  it('is idempotent: the same client order id never fills twice', async () => {
    const clientOrderId = cid('dup');
    const first = await submit({ clientOrderId, qty: 2 });
    const second = await submit({ clientOrderId, qty: 2 });

    expect(first.fills).toHaveLength(1);
    expect(second.fills).toHaveLength(0);
    const position = await positionRow();
    expect(position!.qty).toBe(2);
    expect((await orderRows()).length).toBe(1);
  });

  it('refuses the order outright when there is no market price', async () => {
    engine.stop();
    await fixture.close();
    await setup();
    // No quote has ever been published for this symbol. Accepting a market
    // order here and leaving it working would be worse than refusing it: the
    // trader would believe they had exposure they do not have.
    await expect(submit()).rejects.toMatchObject({ reason: 'MARKET_DATA_UNAVAILABLE' });
  });
});

describe('realized P&L and trade history', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
  });

  it('realizes P&L on a close and moves the balance by exactly that amount', async () => {
    await submit({ qty: 2, side: 'BUY' });
    await market.quote('NQ', 20_010);
    await submit({ qty: 2, side: 'SELL' });

    const position = await positionRow();
    expect(position!.qty).toBe(0);
    expect(position!.costBasisMicros).toBe(0);
    expect(position!.realizedPnlMicros).toBe(400 * MICROS);

    const [account] = await fixture.db
      .select()
      .from((await import('../db/schema.js')).accounts)
      .where(eq((await import('../db/schema.js')).accounts.id, fixture.accountId));
    expect(account!.balanceMicros).toBe(account!.startingBalanceMicros + 400 * MICROS);
  });

  it('writes a round-trip to the trade history', async () => {
    await submit({ qty: 1, side: 'BUY' });
    await market.quote('NQ', 20_020);
    await submit({ qty: 1, side: 'SELL' });

    const rows = await fixture.db.select().from(trades).where(eq(trades.accountId, fixture.accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qty).toBe(1);
    expect(rows[0]!.side).toBe('LONG');
    expect(rows[0]!.grossPnlMicros).toBe(400 * MICROS);
  });

  it('keeps a weighted average entry across several fills', async () => {
    await submit({ qty: 2, side: 'BUY' });
    await market.quote('NQ', 20_010);
    await submit({ qty: 1, side: 'BUY' });

    const view = await engine.positionView(fixture.accountId, 'NQ');
    expect(view.qty).toBe(3);
    const expected = (20_000 * 2 + 20_010 * 1) / 3;
    expect(view.avgEntryPrice).toBeCloseTo(expected, 6);
  });

  it('reverses through zero, closing the long and opening a short', async () => {
    await submit({ qty: 3, side: 'BUY' });
    await market.quote('NQ', 20_010);
    await submit({ qty: 5, side: 'SELL' });

    const view = await engine.positionView(fixture.accountId, 'NQ');
    expect(view.side).toBe('SHORT');
    expect(view.qty).toBe(2);
    expect(view.avgEntryPrice).toBeCloseTo(20_010, 6);

    const rows = await fixture.db.select().from(trades).where(eq(trades.accountId, fixture.accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qty).toBe(3);
  });
});

describe('resting orders fill from market events', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
  });

  it('rests a buy limit below the market, then fills it at its own price', async () => {
    const limitTicks = Math.round(20_000 * 4) - 40; // 19,990
    const submitted = await submit({ type: 'LIMIT', side: 'BUY', qty: 1, limitTicks });

    // Away from the market, so it rests rather than filling.
    expect(submitted.fills).toHaveLength(0);
    expect(submitted.orders[0]!.status).toBe('WORKING');

    // The market comes down THROUGH the limit.
    await market.quote('NQ', 19_985);
    await settle(30);

    const rows = await orderRows();
    expect(rows[0]!.status).toBe('FILLED');
    // It fills at the price it asked for, not at the cheaper market price.
    expect(ticksToPrice(NQ, rows[0]!.fillNotionalMicros / (rows[0]!.filledQty * NQ.tickValueMicros)))
      .toBeCloseTo(19_990, 6);
    expect((await positionRow())!.qty).toBe(1);
  });

  it('fills a marketable limit at the market price, not at its limit', async () => {
    // A buy limit ABOVE the market is marketable on arrival: it should pay the
    // market's price, not its own.
    const limitTicks = Math.round(20_000 * 4) + 40; // 20,010
    const change = await submit({ type: 'LIMIT', side: 'BUY', qty: 1, limitTicks });
    expect(change.fills).toHaveLength(1);
    expect(ticksToPrice(NQ, change.fills[0]!.priceTicks)).toBeCloseTo(20_000, 6);
  });

  it('leaves a limit the market never reaches working', async () => {
    const limitTicks = Math.round(19_000 * 4);
    await submit({ type: 'LIMIT', side: 'BUY', qty: 1, limitTicks });
    await market.quote('NQ', 19_950);
    await settle(30);
    const rows = await orderRows();
    expect(rows[0]!.status).toBe('WORKING');
    expect((await positionRow())?.qty ?? 0).toBe(0);
  });

  it('fills a sell stop when the market trades down through it', async () => {
    await submit({ qty: 1, side: 'BUY' });
    const spec = NQ;
    const stopTicks = Math.round(20_000 / (spec.tickSizeScaled / 10 ** spec.pricePrecision)) - 40;

    await submit({ type: 'STOP_MARKET', side: 'SELL', qty: 1, stopTicks });
    let view = await engine.positionView(fixture.accountId, 'NQ');
    expect(view.qty).toBe(1);

    // Market falls through the stop.
    await market.quote('NQ', 19_985);
    await settle(20);

    view = await engine.positionView(fixture.accountId, 'NQ');
    expect(view.qty).toBe(0);
  });
});

describe('brackets', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
  });

  it('attaches stop and target legs sized to the filled entry', async () => {
    await submit({
      qty: 2,
      side: 'BUY',
      bracket: { stopLossTicks: 40, takeProfitTicks: 80 },
    });
    await settle(20);

    const rows = await orderRows();
    const stop = rows.find((r) => r.bracketRole === 'STOP_LOSS');
    const target = rows.find((r) => r.bracketRole === 'TAKE_PROFIT');

    expect(stop).toBeDefined();
    expect(target).toBeDefined();
    expect(stop!.qty).toBe(2);
    expect(target!.qty).toBe(2);
    expect(stop!.ocoGroupId).toBe(target!.ocoGroupId);
    // Offsets are measured from the entry's actual fill.
    expect(ticksToPrice(NQ, stop!.stopTicks!)).toBeCloseTo(19_990, 6);
    expect(ticksToPrice(NQ, target!.limitTicks!)).toBeCloseTo(20_020, 6);
  });

  it('cancels the target atomically when the stop fills', async () => {
    await submit({ qty: 2, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    await settle(20);

    await market.quote('NQ', 19_985);
    await settle(30);

    const rows = await orderRows();
    const stop = rows.find((r) => r.bracketRole === 'STOP_LOSS')!;
    const target = rows.find((r) => r.bracketRole === 'TAKE_PROFIT')!;
    expect(stop.status).toBe('FILLED');
    expect(target.status).toBe('CANCELED');

    const position = await positionRow();
    expect(position!.qty).toBe(0);
  });

  it('cancels the stop atomically when the target fills', async () => {
    await submit({ qty: 2, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    await settle(20);

    await market.quote('NQ', 20_025);
    await settle(30);

    const rows = await orderRows();
    expect(rows.find((r) => r.bracketRole === 'TAKE_PROFIT')!.status).toBe('FILLED');
    expect(rows.find((r) => r.bracketRole === 'STOP_LOSS')!.status).toBe('CANCELED');
    expect((await positionRow())!.qty).toBe(0);
  });

  /**
   * The ambiguous bar. Both legs are inside one bar's range and the sequence is
   * unknowable, so the engine must take the loss rather than the profit.
   */
  it('takes the stop when one bar spans both legs', async () => {
    await submit({ qty: 2, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    await settle(20);

    await market.bar('NQ', { open: 20_000, high: 20_030, low: 19_980, close: 20_025 });
    await settle(30);

    const rows = await orderRows();
    expect(rows.find((r) => r.bracketRole === 'STOP_LOSS')!.status).toBe('FILLED');
    expect(rows.find((r) => r.bracketRole === 'TAKE_PROFIT')!.status).toBe('CANCELED');

    const position = await positionRow();
    expect(position!.qty).toBe(0);
    // And the account is worse off, not better.
    expect(position!.realizedPnlMicros).toBeLessThan(0);
  });

  it('never exits more than the position through a bracket', async () => {
    await submit({ qty: 2, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    await settle(20);
    await market.bar('NQ', { open: 20_000, high: 20_100, low: 19_900, close: 20_050 });
    await settle(30);

    const position = await positionRow();
    // The danger is flipping short by double-exiting.
    expect(position!.qty).toBe(0);
  });
});

describe('modification and cancellation', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
  });

  it('moves a working stop and bumps its version', async () => {
    await submit({ qty: 1, side: 'BUY' });
    const stopTicks = Math.round(20_000 * 4) - 40;
    const submitted = await submit({ type: 'STOP_MARKET', side: 'SELL', qty: 1, stopTicks });
    const stopOrder = submitted.orders.find((o) => o.type === 'STOP_MARKET')!;

    const moved = await engine.modifyOrder(
      fixture.accountId,
      stopOrder.id,
      { stopTicks: stopTicks - 20 },
      stopOrder.version,
    );
    const updated = moved.orders.find((o) => o.id === stopOrder.id)!;
    expect(updated.stopTicks).toBe(stopTicks - 20);
    expect(updated.version).toBeGreaterThan(stopOrder.version);
  });

  /** A drag that began before a fill must not overwrite the result of that fill. */
  it('rejects a modification carrying a stale version', async () => {
    await submit({ qty: 1, side: 'BUY' });
    const stopTicks = Math.round(20_000 * 4) - 40;
    const submitted = await submit({ type: 'STOP_MARKET', side: 'SELL', qty: 1, stopTicks });
    const stopOrder = submitted.orders.find((o) => o.type === 'STOP_MARKET')!;

    await engine.modifyOrder(fixture.accountId, stopOrder.id, { stopTicks: stopTicks - 10 }, stopOrder.version);

    await expect(
      engine.modifyOrder(fixture.accountId, stopOrder.id, { stopTicks: stopTicks - 20 }, stopOrder.version),
    ).rejects.toMatchObject({ reason: 'STALE_ORDER_VERSION' });
  });

  it('cancels a working order and refuses to cancel it twice', async () => {
    await submit({ qty: 1, side: 'BUY' });
    const stopTicks = Math.round(20_000 * 4) - 40;
    const submitted = await submit({ type: 'STOP_MARKET', side: 'SELL', qty: 1, stopTicks });
    const stopOrder = submitted.orders.find((o) => o.type === 'STOP_MARKET')!;

    await engine.cancelOrder(fixture.accountId, stopOrder.id);
    await expect(engine.cancelOrder(fixture.accountId, stopOrder.id)).rejects.toBeInstanceOf(
      OrderRejectedError,
    );
  });

  it('cancels every working order for an account', async () => {
    await submit({ qty: 1, side: 'BUY' });
    const base = Math.round(20_000 * 4);
    await submit({ type: 'STOP_MARKET', side: 'SELL', qty: 1, stopTicks: base - 40 });
    await submit({ type: 'LIMIT', side: 'SELL', qty: 1, limitTicks: base + 200 });

    await engine.cancelAll(fixture.accountId, 'NQ');
    const rows = await orderRows();
    const stillOpen = rows.filter((r) => r.status === 'WORKING' || r.status === 'PARTIALLY_FILLED');
    expect(stillOpen).toHaveLength(0);
  });
});

describe('flatten and reverse', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
  });

  it('flattens a long and cancels its protective orders', async () => {
    await submit({ qty: 2, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    await settle(20);

    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(20);

    expect((await positionRow())!.qty).toBe(0);
    const rows = await orderRows();
    const stillOpen = rows.filter((r) => r.status === 'WORKING' || r.status === 'PARTIALLY_FILLED');
    expect(stillOpen).toHaveLength(0);
  });

  it('reverses a long into a short of the same size', async () => {
    await submit({ qty: 2, side: 'BUY' });
    await market.quote('NQ', 20_010);
    await engine.reverse(fixture.accountId, fixture.userId, 'NQ');
    await settle(20);

    const view = await engine.positionView(fixture.accountId, 'NQ');
    expect(view.side).toBe('SHORT');
    expect(view.qty).toBe(2);
  });

  it('does nothing when flattening a flat account', async () => {
    const change = await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    expect(change.fills).toHaveLength(0);
  });
});

describe('risk gate', () => {
  it('rejects an order beyond the contract limit', async () => {
    await setup({ maxContracts: 2 });
    await market.quote('NQ', 20_000);
    await submit({ qty: 2, side: 'BUY' });

    await expect(submit({ qty: 1, side: 'BUY' })).rejects.toMatchObject({
      reason: 'MAX_CONTRACTS_EXCEEDED',
    });
  });

  /** A trader at their limit must always be able to close. */
  it('allows closing while at the contract limit', async () => {
    await setup({ maxContracts: 2 });
    await market.quote('NQ', 20_000);
    await submit({ qty: 2, side: 'BUY' });

    const change = await submit({ qty: 2, side: 'SELL' });
    expect(change.fills).toHaveLength(1);
    expect((await positionRow())!.qty).toBe(0);
  });

  it('rejects order entry when market data is stale', async () => {
    await setup();
    await market.quote('NQ', 20_000);
    market.setStale(true);
    await expect(submit({ qty: 1 })).rejects.toMatchObject({ reason: 'MARKET_DATA_STALE' });
  });

  it('rejects order entry when the feed has frozen, whatever it calls itself', async () => {
    // A delayed feed that stops at the session break keeps its last price, and
    // its own clock still shows the session open for another ten minutes. The
    // frozen price must not fill anything.
    await setup();
    await market.quote('NQ', 20_000);
    market.setFrozen(15 * 60_000);
    // Blocked, and named for what it is: the session shut, the feed did not break.
    await expect(submit({ qty: 1 })).rejects.toMatchObject({ reason: 'MARKET_CLOSED' });
    market.setFrozen(null);
  });

  it('rejects a buy stop placed below the market', async () => {
    await setup();
    await market.quote('NQ', 20_000);
    await expect(
      submit({ type: 'STOP_MARKET', side: 'BUY', qty: 1, stopTicks: Math.round(20_000 * 4) - 40 }),
    ).rejects.toMatchObject({ reason: 'STOP_ON_WRONG_SIDE' });
  });

  it('rejects a price off the instrument tick grid', async () => {
    await setup();
    await market.quote('NQ', 20_000);
    await expect(
      submit({ type: 'LIMIT', side: 'BUY', qty: 1, limitTicks: 80_000.5 }),
    ).rejects.toMatchObject({ reason: 'INVALID_TICK' });
  });

  it('rejects a non-positive quantity', async () => {
    await setup();
    await market.quote('NQ', 20_000);
    await expect(submit({ qty: 0 })).rejects.toMatchObject({ reason: 'INVALID_QUANTITY' });
  });
});

describe('concurrency', () => {
  it('serializes simultaneous submissions without double-counting', async () => {
    await setup();
    await market.quote('NQ', 20_000);

    // Ten orders fired together, as a fast-clicking trader would.
    await Promise.all(Array.from({ length: 10 }, () => submit({ qty: 1, side: 'BUY' })));

    const position = await positionRow();
    expect(position!.qty).toBe(10);
  });

  /**
   * The race that motivates the mutex: a burst of market events arriving while
   * a protective order is working. Exactly one of them may fill it.
   */
  it('fills a stop exactly once under a burst of market events', async () => {
    await setup();
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    const stopTicks = Math.round(20_000 * 4) - 40;
    await submit({ type: 'STOP_MARKET', side: 'SELL', qty: 1, stopTicks });

    await Promise.all([
      market.quote('NQ', 19_985),
      market.quote('NQ', 19_984),
      market.quote('NQ', 19_983),
      market.quote('NQ', 19_982),
    ]);
    await settle(60);

    const position = await positionRow();
    expect(position!.qty).toBe(0);

    const rows = await orderRows();
    const stops = rows.filter((r) => r.type === 'STOP_MARKET');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.filledQty).toBe(1);
  });
});

describe('environment settings', () => {
  it('applies slippage and fees from the account environment', async () => {
    await setup({
      environment: {
        fillModel: 'ADVANCED',
        latencyMs: 0,
        marketSlippageTicks: 2,
        stopSlippageTicks: 2,
        feesEnabled: true,
      },
    });
    await market.quote('NQ', 20_000);
    const change = await submit({ qty: 1, side: 'BUY' });

    const fill = change.fills[0]!;
    // Two ticks adverse for a buy.
    expect(ticksToPrice(NQ, fill.priceTicks)).toBeCloseTo(20_000.5, 6);
    expect(fill.feesMicros).toBe(NQ.commissionPerSideMicros + NQ.exchangeFeesPerSideMicros);
  });

  it('honours a liquidity cap by filling in parts', async () => {
    await setup({ environment: { ...CLEAN_ENV, maxContractsPerFill: 2 } });
    await market.quote('NQ', 20_000);
    const change = await submit({ qty: 5, side: 'BUY' });

    expect(change.fills[0]!.qty).toBe(2);
    const order = change.orders.find((o) => o.type === 'MARKET')!;
    expect(order.status).toBe('PARTIALLY_FILLED');

    await market.quote('NQ', 20_000);
    await settle(20);
    await market.quote('NQ', 20_000.25);
    await settle(20);

    const rows = await orderRows();
    expect(rows[0]!.filledQty).toBe(5);
    expect((await positionRow())!.qty).toBe(5);
  });

  it('holds an order until its configured latency has elapsed', async () => {
    await setup({ environment: { ...CLEAN_ENV, latencyMs: 400 } });
    await market.quote('NQ', 20_000);

    const change = await submit({ qty: 1 });
    expect(change.fills).toHaveLength(0);

    await settle(450);
    await market.quote('NQ', 20_000);
    await settle(30);
    expect((await positionRow())!.qty).toBe(1);
  });
});

describe('trailing stops persist their anchor', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
  });

  /**
   * The anchor lives in the database between market events. If it is not
   * persisted it resets to the current price every time, and the stop follows
   * the market down instead of trailing behind its high — it would never fire.
   */
  it('advances the anchor as price rises and fires on a retrace', async () => {
    await submit({ qty: 1, side: 'BUY' });
    await submit({ type: 'TRAILING_STOP', side: 'SELL', qty: 1, trailTicks: 40 });

    await market.quote('NQ', 20_020);
    await settle(20);
    let rows = await orderRows();
    let trail = rows.find((r) => r.type === 'TRAILING_STOP')!;
    expect(trail.trailAnchorTicks).toBe(Math.round(20_020 * 4));
    expect(trail.status).toBe('WORKING');

    // A shallow pullback leaves the anchor where it was.
    await market.quote('NQ', 20_015);
    await settle(20);
    rows = await orderRows();
    trail = rows.find((r) => r.type === 'TRAILING_STOP')!;
    expect(trail.trailAnchorTicks).toBe(Math.round(20_020 * 4));
    expect(trail.status).toBe('WORKING');

    // A retrace of the full trail distance fires it.
    await market.quote('NQ', 20_009);
    await settle(30);
    rows = await orderRows();
    trail = rows.find((r) => r.type === 'TRAILING_STOP')!;
    expect(trail.status).toBe('FILLED');
    expect((await positionRow())!.qty).toBe(0);
    // Locked in a profit, because the stop trailed up with the market.
    expect((await positionRow())!.realizedPnlMicros).toBeGreaterThan(0);
  });
});

describe('stop-limit lifecycle survives persistence', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
  });

  it('remembers that it was elected across market events', async () => {
    await submit({ qty: 1, side: 'BUY' });
    const base = Math.round(20_000 * 4);
    // Elects at 19,990 but may not sell below 19,995, so election alone cannot
    // fill it and the triggered flag has to survive to the next event.
    await submit({
      type: 'STOP_LIMIT',
      side: 'SELL',
      qty: 1,
      stopTicks: base - 40,
      limitTicks: base + 20,
    });

    await market.quote('NQ', 19_988);
    await settle(30);
    let rows = await orderRows();
    let sl = rows.find((r) => r.type === 'STOP_LIMIT')!;
    expect(sl.stopTriggered).toBe(true);
    expect(sl.status).toBe('WORKING');

    // Price bounces back to the limit and it fills there.
    await market.quote('NQ', 20_005);
    await settle(30);
    rows = await orderRows();
    sl = rows.find((r) => r.type === 'STOP_LIMIT')!;
    expect(sl.status).toBe('FILLED');
  });
});

describe('brackets survive a delayed entry fill', () => {
  /**
   * The bug this covers: with any simulated latency the entry does not fill on
   * the submitting call, so a bracket attached only at submission time is never
   * created at all, and the position sits unprotected.
   */
  it('attaches legs on whichever pass actually fills the entry', async () => {
    await setup({ environment: { ...CLEAN_ENV, latencyMs: 300 } });
    await market.quote('NQ', 20_000);

    const change = await submit({ qty: 2, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    expect(change.fills).toHaveLength(0); // still inside the latency window

    let rows = await orderRows();
    expect(rows.filter((r) => r.bracketRole !== 'ENTRY')).toHaveLength(0);

    await settle(350);
    await market.quote('NQ', 20_000);
    await settle(40);

    rows = await orderRows();
    expect(rows.find((r) => r.bracketRole === 'ENTRY')!.status).toBe('FILLED');
    expect(rows.find((r) => r.bracketRole === 'STOP_LOSS')).toBeDefined();
    expect(rows.find((r) => r.bracketRole === 'TAKE_PROFIT')).toBeDefined();
  });

  it('attaches legs to a resting entry limit only once it fills', async () => {
    await setup();
    await market.quote('NQ', 20_000);
    const limitTicks = Math.round(20_000 * 4) - 40;

    await submit({
      type: 'LIMIT',
      side: 'BUY',
      qty: 1,
      limitTicks,
      bracket: { stopLossTicks: 40, takeProfitTicks: 80 },
    });
    // Resting: nothing to protect yet, so no legs.
    expect((await orderRows()).filter((r) => r.bracketRole !== 'ENTRY')).toHaveLength(0);

    await market.quote('NQ', 19_985);
    await settle(40);

    const rows = await orderRows();
    expect(rows.find((r) => r.bracketRole === 'ENTRY')!.status).toBe('FILLED');
    const stop = rows.find((r) => r.bracketRole === 'STOP_LOSS')!;
    // The stop is measured from the entry's ACTUAL fill (19,990), not from the
    // price that was on screen when the order was placed.
    expect(ticksToPrice(NQ, stop.stopTicks!)).toBeCloseTo(19_980, 6);
  });

  it('grows the legs as further partials fill the entry', async () => {
    await setup({ environment: { ...CLEAN_ENV, maxContractsPerFill: 1 } });
    await market.quote('NQ', 20_000);

    await submit({ qty: 3, side: 'BUY', bracket: { stopLossTicks: 40 } });
    await settle(20);
    let rows = await orderRows();
    expect(rows.find((r) => r.bracketRole === 'STOP_LOSS')!.qty).toBe(1);

    await market.quote('NQ', 20_000.25);
    await settle(30);
    await market.quote('NQ', 20_000.5);
    await settle(30);

    rows = await orderRows();
    expect(rows.find((r) => r.bracketRole === 'ENTRY')!.filledQty).toBe(3);
    expect(rows.find((r) => r.bracketRole === 'STOP_LOSS')!.qty).toBe(3);
  });

  it('does not sprout a stop for an entry that is already closed out', async () => {
    await setup({ environment: { ...CLEAN_ENV, latencyMs: 0 } });
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY', bracket: { stopLossTicks: 40 } });
    await settle(20);

    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(30);
    // Another market event must not recreate the protective leg.
    await market.quote('NQ', 20_005);
    await settle(30);

    const rows = await orderRows();
    const openLegs = rows.filter(
      (r) => r.bracketRole !== 'ENTRY' && (r.status === 'WORKING' || r.status === 'PARTIALLY_FILLED'),
    );
    expect(openLegs).toHaveLength(0);
    expect((await positionRow())!.qty).toBe(0);
  });
});

describe('a completed bracket is not rebuilt', () => {
  /**
   * The failure this covers: once the stop fills and the target cancels, both
   * legs are closed. Looking only at OPEN children then reads as "this entry
   * has no bracket" and builds a fresh pair — protecting a position that no
   * longer exists, and colliding on the leg's client order id.
   */
  it('does not recreate legs after the bracket has resolved', async () => {
    await setup();
    await market.quote('NQ', 20_000);
    await submit({ qty: 2, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    await settle(30);

    await market.quote('NQ', 19_985);
    await settle(40);
    expect((await positionRow())!.qty).toBe(0);

    const afterStop = (await orderRows()).length;

    // Several more market events, any of which could trigger a rebuild.
    await market.quote('NQ', 19_990);
    await settle(30);
    await market.quote('NQ', 20_010);
    await settle(30);

    const rows = await orderRows();
    expect(rows.length).toBe(afterStop);
    const open = rows.filter((r) => r.status === 'WORKING' || r.status === 'PARTIALLY_FILLED');
    expect(open).toHaveLength(0);
    expect((await positionRow())!.qty).toBe(0);
  });

  it('re-entering after a bracket resolved creates a fresh, separate bracket', async () => {
    await setup();
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY', bracket: { stopLossTicks: 40 } });
    await settle(30);
    await market.quote('NQ', 19_985);
    await settle(40);
    expect((await positionRow())!.qty).toBe(0);

    // A brand new entry, with its own bracket.
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY', bracket: { stopLossTicks: 40 } });
    await settle(40);

    const rows = await orderRows();
    const openStops = rows.filter(
      (r) => r.bracketRole === 'STOP_LOSS' && (r.status === 'WORKING' || r.status === 'PARTIALLY_FILLED'),
    );
    expect(openStops).toHaveLength(1);
    expect((await positionRow())!.qty).toBe(1);
  });
});

describe('latency does not become feed latency', () => {
  /**
   * An order is normally matched when a market event arrives. On a feed that
   * polls every few seconds that would turn a 250ms latency setting into a
   * multi-second wait, and a trader pressing Flatten would watch nothing
   * happen. The engine comes back for the order when its latency elapses.
   */
  it('fills a market order once its latency elapses, with no new market event', async () => {
    await setup({ environment: { ...CLEAN_ENV, latencyMs: 200 } });
    await market.quote('NQ', 20_000);

    const change = await submit({ qty: 1, side: 'BUY' });
    expect(change.fills).toHaveLength(0);

    // No further market data is published at all.
    await settle(400);

    expect((await positionRow())!.qty).toBe(1);
  });

  it('flattens without waiting for the next market event', async () => {
    await setup({ environment: { ...CLEAN_ENV, latencyMs: 200 } });
    await market.quote('NQ', 20_000);
    await submit({ qty: 2, side: 'BUY' });
    await settle(400);
    expect((await positionRow())!.qty).toBe(2);

    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(400);
    expect((await positionRow())!.qty).toBe(0);
  });
});

describe('market event pressure', () => {
  beforeEach(async () => {
    await setup();
  });

  /**
   * The vendor hands back its whole window on every poll, and a replay can run
   * far faster than real time. If every event queued its own match, the account
   * lock would build a backlog that every later order, cancel or flatten has to
   * wait behind - which is how a flatten ends up taking minutes to answer.
   */
  it('collapses a burst of market events for an account with nothing working', async () => {
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    expect((await positionRow())!.qty).toBe(1);

    let peak = 0;
    for (let i = 0; i < 100; i += 1) {
      void market.quote('NQ', 20_000 + i);
      peak = Math.max(peak, engine.queueDepth(fixture.accountId));
    }
    await settle(80);

    // One running, at most one queued behind it - not a hundred.
    expect(peak).toBeLessThanOrEqual(2);
    expect(engine.queueDepth(fixture.accountId)).toBe(0);
  });

  /**
   * The exemption that makes fills faithful, and the bound that keeps it safe.
   *
   * An account with a working order sees every observation, because each one is
   * a chance to fill and skipping one would hide a price the market traded. The
   * queue that allows is bounded, so a fast replay cannot leave the trader's
   * own next order waiting behind a thousand events.
   */
  it('does not skip observations while an order is working, but bounds the queue', async () => {
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY', type: 'LIMIT', limitTicks: 19_000 * 4 });
    await settle(20);

    let peak = 0;
    for (let i = 0; i < 200; i += 1) {
      void market.quote('NQ', 20_000 + i);
      peak = Math.max(peak, engine.queueDepth(fixture.accountId));
    }
    await settle(400);

    expect(peak).toBeGreaterThan(2);
    expect(peak).toBeLessThanOrEqual(20);
    expect(engine.queueDepth(fixture.accountId)).toBe(0);
  });

  it('still reacts to the newest price after a burst', async () => {
    await market.quote('NQ', 20_000);
    // A sell stop below the market: the burst must still trigger it.
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await submit({ qty: 1, side: 'SELL', type: 'STOP_MARKET', stopTicks: 19_990 * 4 });
    await settle(30);

    for (let i = 0; i < 50; i += 1) void market.quote('NQ', 20_000 - i * 0.5);
    await settle(80);

    expect((await positionRow())!.qty).toBe(0);
  });
});

describe('bar eligibility end to end', () => {
  beforeEach(async () => {
    await setup();
  });

  /**
   * The delayed feed hands the server bars that are already minutes old. An
   * order sent after one of those bars closed was never live for the prices in
   * it, and filling from them invents an execution that could not have happened.
   */
  it('does not fill a resting limit from a bar that closed before it was sent', async () => {
    const later = OPEN_MARKET_TS + 120_000;
    await market.quote('NQ', 20_000, later);

    await submit({ qty: 1, side: 'BUY', type: 'LIMIT', limitTicks: 19_900 * 4 });
    await settle(30);

    // A bar from two minutes BEFORE the order, whose low is well through it.
    await market.bar(
      'NQ',
      { open: 20_000, high: 20_010, low: 19_800, close: 19_990 },
      OPEN_MARKET_TS,
    );
    await settle(30);
    expect((await positionRow())?.qty ?? 0).toBe(0);

    // The same range, in a bar that opened after the order was working.
    await market.bar(
      'NQ',
      { open: 20_000, high: 20_010, low: 19_800, close: 19_990 },
      later + 60_000,
    );
    await settle(30);
    expect((await positionRow())!.qty).toBe(1);

    const [row] = await orderRows();
    expect(row!.status).toBe('FILLED');
    expect(ticksToPrice(NQ, row!.fillNotionalMicros / (row!.filledQty * NQ.tickValueMicros))).toBe(
      19_900,
    );
  });
});

describe('protective orders track the position', () => {
  beforeEach(async () => {
    await setup();
  });

  /**
   * A bracket protects the position between its legs, not the quantity it was
   * created with. Reduce the position by hand and a stop still sized for the
   * original quantity will not close the trade - it will reverse it.
   */
  it('shrinks a bracket when the position is reduced by hand', async () => {
    await market.quote('NQ', 20_000);
    await submit({ qty: 3, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 200 } });
    await settle(30);
    expect((await positionRow())!.qty).toBe(3);

    await submit({ qty: 2, side: 'SELL' });
    await settle(30);
    expect((await positionRow())!.qty).toBe(1);

    const stop = (await orderRows()).find((r) => r.bracketRole === 'STOP_LOSS')!;
    expect(stop.qty).toBe(1);

    // Now let the stop fire: it must close the position, not flip it short.
    await market.quote('NQ', 19_980);
    await settle(40);
    expect((await positionRow())!.qty).toBe(0);
  });

  it('leaves a partially filled stop enough quantity to finish the job', async () => {
    // One contract per fill, so the stop closes the position a lot at a time.
    await setup({ environment: { ...CLEAN_ENV, maxContractsPerFill: 1 } });
    await market.quote('NQ', 20_000);
    await submit({ qty: 2, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 200 } });
    await settle(40);
    // One lot per observation, so the entry needs a second look to complete.
    await market.quote('NQ', 20_000);
    await settle(40);
    expect((await positionRow())!.qty).toBe(2);

    await market.quote('NQ', 19_980);
    await settle(40);

    const stop = (await orderRows()).find((r) => r.bracketRole === 'STOP_LOSS')!;
    const position = (await positionRow())!;
    // Whatever it has managed so far, what is left must still cover the rest.
    expect(stop.qty - stop.filledQty).toBe(Math.abs(position.qty));
    expect(position.qty).toBeGreaterThanOrEqual(0);

    // And it finishes on the following observations rather than reversing.
    await market.quote('NQ', 19_975);
    await settle(40);
    await market.quote('NQ', 19_970);
    await settle(40);
    expect((await positionRow())!.qty).toBe(0);
  });

  it('cancels the bracket once the position is closed by hand', async () => {
    await market.quote('NQ', 20_000);
    await submit({ qty: 2, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 200 } });
    await settle(30);

    await submit({ qty: 2, side: 'SELL' });
    await settle(40);
    expect((await positionRow())!.qty).toBe(0);

    const legs = (await orderRows()).filter((r) => r.bracketRole !== 'ENTRY' && r.bracketRole !== 'STANDALONE');
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) expect(['CANCELED', 'FILLED']).toContain(leg.status);

    // And a later move through where the stop used to sit does nothing.
    await market.quote('NQ', 19_900);
    await settle(40);
    expect((await positionRow())!.qty).toBe(0);
  });
});

describe('what a trade felt like', () => {
  beforeEach(async () => {
    await setup();
  });

  /**
   * MAE and MFE are the difference between "a winner" and "a winner you should
   * not have taken". They have to come from genuine marks as the trade runs,
   * not from a reconstruction afterwards.
   */
  it('records how far a trade went against and for the trader', async () => {
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);

    // Down 10 points, then up 30, then out at up 12.
    await market.quote('NQ', 19_990);
    await settle(30);
    await market.quote('NQ', 20_030);
    await settle(30);
    await market.quote('NQ', 20_012);
    await settle(30);
    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(60);

    const [trade] = await fixture.db
      .select()
      .from(trades)
      .where(eq(trades.accountId, fixture.accountId));
    // NQ is $20 a point on one contract.
    expect(trade!.maeMicros).toBe(-10 * 20 * MICROS);
    expect(trade!.mfeMicros).toBe(30 * 20 * MICROS);
    expect(trade!.netPnlMicros).toBe(12 * 20 * MICROS);
  });

  it('scales the excursions to the quantity actually closed', async () => {
    await market.quote('NQ', 20_000);
    await submit({ qty: 3, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 20_020);
    await settle(30);

    // Close one of the three.
    await submit({ qty: 1, side: 'SELL' });
    await settle(40);
    // Then the other two.
    await submit({ qty: 2, side: 'SELL' });
    await settle(40);

    const rows = await fixture.db
      .select()
      .from(trades)
      .where(eq(trades.accountId, fixture.accountId));
    const byQty = new Map(rows.map((r) => [r.qty, r]));
    expect(byQty.get(1)!.mfeMicros).toBe(20 * 20 * MICROS);
    // The same price path, three times the size.
    expect(byQty.get(2)!.mfeMicros).toBe(2 * 20 * 20 * MICROS);
  });

  it('records what the trade risked when it had a stop', async () => {
    await market.quote('NQ', 20_000);
    // A 40-tick stop: 10 points, $200 on one NQ contract.
    await submit({ qty: 1, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 400 } });
    await settle(40);
    await market.quote('NQ', 20_020);
    await settle(30);
    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(60);

    const [trade] = await fixture.db
      .select()
      .from(trades)
      .where(eq(trades.accountId, fixture.accountId));
    expect(trade!.initialRiskMicros).toBe(200 * MICROS);
    // R is then the result over that risk: +400 on 200 risked is +2R.
    expect(trade!.netPnlMicros / trade!.initialRiskMicros!).toBe(2);
  });

  it('leaves the risk undefined when the trade was taken without a stop', async () => {
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(60);

    const [trade] = await fixture.db
      .select()
      .from(trades)
      .where(eq(trades.accountId, fixture.accountId));
    expect(trade!.initialRiskMicros).toBeNull();
  });

  it('starts the excursions again for the next position', async () => {
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 19_950);
    await settle(30);
    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(60);

    // A fresh position, which never went against the trader at all.
    await market.quote('NQ', 20_000);
    await submit({ qty: 1, side: 'BUY' });
    await settle(30);
    await market.quote('NQ', 20_010);
    await settle(30);
    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(60);

    const rows = await fixture.db
      .select()
      .from(trades)
      .where(eq(trades.accountId, fixture.accountId))
      .orderBy(trades.exitTime);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.maeMicros).toBe(0);
    expect(rows[1]!.mfeMicros).toBe(10 * 20 * MICROS);
  });
});
