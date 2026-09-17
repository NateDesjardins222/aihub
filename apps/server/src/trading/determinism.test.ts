import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accounts, trades as tradesTable } from '../db/schema.js';
import { TradingEngine } from './engine.js';
import { ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';

/**
 * Replaying the same session twice must produce the same result.
 *
 * This is the property that makes practice worth anything: if the same data,
 * the same settings and the same actions can produce different trades, a
 * trader cannot tell whether a change in outcome came from a change in their
 * behaviour or from the simulator.
 *
 * The one thing that could break it is simulated latency, which used to be
 * measured on the SERVER's clock: at 10x a 250ms delay covered a tenth of the
 * market it covers at 1x, and at any speed it depended on how busy the machine
 * happened to be. In a replay it is now measured on the market's own clock.
 */

const D = 1_000_000;

let fixture: TestFixture;
let engine: TradingEngine;

interface Action {
  /** Apply this action after this many market events have been emitted. */
  readonly afterEvents: number;
  readonly run: (engine: TradingEngine, fixture: TestFixture) => Promise<unknown>;
}

/** One deterministic price path. No randomness: the same script every time. */
const PATH: number[] = [];
for (let i = 0; i < 60; i += 1) {
  // A shape with a pullback and a run, so stops and targets are both in play.
  PATH.push(20_000 + Math.round(Math.sin(i / 4) * 30) + i * 0.5);
}

async function runSession(actions: readonly Action[], latencyMs: number) {
  fixture = await createFixture({
    environment: {
      fillModel: 'ADVANCED',
      latencyMs,
      marketSlippageTicks: 1,
      stopSlippageTicks: 1,
      requireThroughTradeForLimit: true,
      feesEnabled: true,
      useBarRange: true,
    },
    startingBalanceMicros: 100_000 * D,
  });
  const market = new ScriptedMarket();
  // The market clock is the replay's clock, which is what makes this repeatable.
  market.setReplay(true);
  engine = new TradingEngine(fixture.db, market);
  await engine.start();

  const base = Date.UTC(2026, 8, 15, 15, 0, 0);
  for (let i = 0; i < PATH.length; i += 1) {
    await market.quote('NQ', PATH[i]!, base + i * 60_000);
    for (const action of actions.filter((a) => a.afterEvents === i)) {
      await action.run(engine, fixture).catch(() => undefined);
    }
    await settle(5);
  }
  await settle(60);

  const rows = await fixture.db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.accountId, fixture.accountId))
    .orderBy(tradesTable.exitTime);
  const [account] = await fixture.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, fixture.accountId));

  const result = {
    balance: account!.balanceMicros,
    // Sorted by CONTENT, not by row order: two trades that closed on the same
    // observation have the same timestamp, and which of them the database hands
    // back first is not part of what determinism means here.
    trades: rows
      .map((row) => ({
        side: row.side,
        qty: row.qty,
        entry: row.entryTicksScaled,
        exit: row.exitTicksScaled,
        gross: row.grossPnlMicros,
        net: row.netPnlMicros,
        mae: row.maeMicros,
        mfe: row.mfeMicros,
        exitAt: row.exitTime.getTime(),
      }))
      .sort(
        (a, b) =>
          a.exitAt - b.exitAt ||
          a.entry - b.entry ||
          a.exit - b.exit ||
          a.qty - b.qty ||
          a.side.localeCompare(b.side),
      ),
  };

  engine.stop();
  await fixture.close();
  return result;
}

const SCRIPT: Action[] = [
  {
    afterEvents: 3,
    run: (e, f) =>
      e.submitOrder({
        accountId: f.accountId,
        userId: f.userId,
        clientOrderId: 'det-entry',
        symbol: 'NQ',
        side: 'BUY',
        qty: 2,
        type: 'MARKET',
        bracket: { stopLossTicks: 60, takeProfitTicks: 120 },
      }),
  },
  {
    afterEvents: 14,
    run: (e, f) =>
      e.submitOrder({
        accountId: f.accountId,
        userId: f.userId,
        clientOrderId: 'det-limit',
        symbol: 'NQ',
        side: 'SELL',
        qty: 1,
        type: 'LIMIT',
        limitTicks: Math.round(20_040 * 4),
      }),
  },
  { afterEvents: 30, run: (e, f) => e.flatten(f.accountId, f.userId, 'NQ') },
  {
    afterEvents: 36,
    run: (e, f) =>
      e.submitOrder({
        accountId: f.accountId,
        userId: f.userId,
        clientOrderId: 'det-short',
        symbol: 'NQ',
        side: 'SELL',
        qty: 1,
        type: 'MARKET',
        bracket: { stopLossTicks: 40, takeProfitTicks: 80 },
      }),
  },
  { afterEvents: 52, run: (e, f) => e.flatten(f.accountId, f.userId, 'NQ') },
];

describe('replay determinism', () => {
  it('produces identical trades from identical data, settings and actions', async () => {
    const first = await runSession(SCRIPT, 250);
    const second = await runSession(SCRIPT, 250);
    expect(second).toEqual(first);
    expect(first.trades.length).toBeGreaterThan(1);
  }, 60_000);

  it('produces the same result three times running', async () => {
    const runs = [await runSession(SCRIPT, 500), await runSession(SCRIPT, 500), await runSession(SCRIPT, 500)];
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  }, 90_000);

  it('makes latency mean the same thing whatever the machine is doing', async () => {
    // A latency of one minute of MARKET time delays the entry by exactly one
    // observation, every time, because the clock it is measured on is the
    // recording's rather than the server's.
    const entryThenExit = [SCRIPT[0]!, SCRIPT[2]!];
    const instant = await runSession(entryThenExit, 0);
    const delayed = await runSession(entryThenExit, 60_000);
    expect(instant.trades.length).toBeGreaterThan(0);
    expect(delayed.trades).not.toEqual(instant.trades);

    const again = await runSession(entryThenExit, 60_000);
    expect(again).toEqual(delayed);
  }, 90_000);
});
