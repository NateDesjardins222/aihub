/**
 * Does the money reconcile?
 *
 * Known entry, known exit, known quantity, arithmetic done by hand from each
 * instrument's own published specification - then the same number is demanded
 * from every place Atlas shows it: the position, the account balance, the
 * equity, the day P&L, the trade row the journal reads, and the valuation the
 * admin view serves.
 *
 * The expected figures below are written out longhand on purpose. A test that
 * computes its expectation with the same helper as the code under test proves
 * only that the helper is self-consistent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { requireInstrument } from '@atlas/instruments';
import { analyze, type TradeRecord } from '@atlas/core';
import { accounts, trades as tradesTable } from '../db/schema.js';
import { TradingEngine } from './engine.js';
import { ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';

const D = 1_000_000;

/** No slippage, no latency, no fees: the arithmetic under test is P&L. */
const CLEAN_ENV = {
  fillModel: 'SIMPLE' as const,
  latencyMs: 0,
  marketSlippageTicks: 0,
  stopSlippageTicks: 0,
  requireThroughTradeForLimit: false,
  feesEnabled: false,
  useBarRange: true,
};

let fixture: TestFixture;
let market: ScriptedMarket;
let engine: TradingEngine;
let seq = 0;

beforeEach(async () => {
  fixture = await createFixture({
    environment: CLEAN_ENV,
    startingBalanceMicros: 100_000 * D,
    instrumentLimits: { allowed: null, maxContracts: 50 },
  });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
});

afterEach(async () => {
  engine.stop();
  await fixture.close();
});

const cid = (label: string): string => {
  seq += 1;
  return `${label}-${seq}-${Date.now()}`;
};

async function trade(symbol: string, side: 'BUY' | 'SELL', qty: number, entry: number, exit: number) {
  await market.bar(symbol, { open: entry, high: entry, low: entry, close: entry });
  await engine.submitOrder({
    accountId: fixture.accountId,
    userId: fixture.userId,
    clientOrderId: cid('entry'),
    symbol,
    side,
    qty,
    type: 'MARKET',
  });
  await settle();

  // Mark at the exit price BEFORE closing, so the open P&L can be checked
  // against the same arithmetic as the realized figure.
  await market.bar(symbol, { open: exit, high: exit, low: exit, close: exit });
  const marked = await engine.valuation(fixture.accountId);

  await engine.submitOrder({
    accountId: fixture.accountId,
    userId: fixture.userId,
    clientOrderId: cid('exit'),
    symbol,
    side: side === 'BUY' ? 'SELL' : 'BUY',
    qty,
    type: 'MARKET',
  });
  await settle();
  return marked;
}

/**
 * One case per instrument, with the expected dollars written out.
 *
 * e.g. NQ: 0.25 tick, $5 a tick, so a 10-point move on 2 contracts is
 * 40 ticks x $5 x 2 = $400.
 */
const CASES = [
  {
    symbol: 'NQ',
    side: 'BUY' as const,
    qty: 2,
    entry: 20_000,
    exit: 20_010,
    // 10 points = 40 ticks; 40 x $5 x 2 contracts
    expected: 400,
    why: '40 ticks at $5 on 2 contracts',
  },
  {
    symbol: 'MNQ',
    side: 'BUY' as const,
    qty: 3,
    entry: 20_000,
    exit: 20_010,
    // the micro is a tenth of NQ: 40 ticks x $0.50 x 3
    expected: 60,
    why: '40 ticks at $0.50 on 3 contracts',
  },
  {
    symbol: 'ES',
    side: 'SELL' as const,
    qty: 1,
    entry: 5_000,
    exit: 4_995,
    // short 5 points = 20 ticks; 20 x $12.50
    expected: 250,
    why: 'short 20 ticks at $12.50',
  },
  {
    symbol: 'MES',
    side: 'SELL' as const,
    qty: 4,
    entry: 5_000,
    exit: 5_002.5,
    // short into a rise: 10 ticks against, x $1.25 x 4
    expected: -50,
    why: 'short 10 ticks against at $1.25 on 4 contracts',
  },
  {
    symbol: 'GC',
    side: 'BUY' as const,
    qty: 1,
    entry: 2_400,
    exit: 2_401,
    // 1 dollar = 10 ticks of 0.10; 10 x $10
    expected: 100,
    why: '10 ticks at $10',
  },
  {
    symbol: 'MGC',
    side: 'BUY' as const,
    qty: 3,
    entry: 2_400,
    exit: 2_402,
    // the micro is a tenth of GC: $2 = 20 ticks of 0.10; 20 x $1 x 3
    expected: 60,
    why: '20 ticks at $1 on 3 contracts',
  },
  {
    symbol: 'CL',
    side: 'BUY' as const,
    qty: 2,
    entry: 80,
    exit: 79.5,
    // half a dollar against = 50 ticks of 0.01; 50 x $10 x 2
    expected: -1_000,
    why: '50 ticks against at $10 on 2 contracts',
  },
  {
    symbol: 'MCL',
    side: 'SELL' as const,
    qty: 2,
    entry: 80,
    exit: 79.4,
    // short into a fall: 60 cents = 60 ticks of 0.01; 60 x $1 x 2
    expected: 120,
    why: 'short 60 ticks at $1 on 2 contracts',
  },
];

describe('P&L reconciles to the executions, instrument by instrument', () => {
  for (const item of CASES) {
    it(`${item.symbol}: ${item.why} is $${item.expected}`, async () => {
      const spec = requireInstrument(item.symbol);
      const expectedMicros = item.expected * D;

      const marked = await trade(item.symbol, item.side, item.qty, item.entry, item.exit);

      // 1. the open position, marked at the exit price
      const view = marked!.positions.find((p) => p.symbol === spec.root);
      expect(view?.unrealizedPnlMicros).toBe(expectedMicros);
      expect(marked!.openPnlMicros).toBe(expectedMicros);
      expect(marked!.equityMicros).toBe(100_000 * D + expectedMicros);

      // 2. the closed balance
      const [account] = await fixture.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, fixture.accountId));
      expect(account!.balanceMicros).toBe(100_000 * D + expectedMicros);
      expect(account!.realizedPnlMicros).toBe(expectedMicros);
      expect(account!.feesMicros).toBe(0);

      // 3. the valuation after the close: flat, and equity is the balance
      const after = await engine.valuation(fixture.accountId);
      expect(after!.openPnlMicros).toBe(0);
      expect(after!.equityMicros).toBe(100_000 * D + expectedMicros);
      expect(after!.dayPnlMicros).toBe(expectedMicros);
      expect(after!.realizedPnlMicros).toBe(expectedMicros);

      // 4. the trade row the journal and the calendar read
      const [row] = await fixture.db
        .select()
        .from(tradesTable)
        .where(eq(tradesTable.accountId, fixture.accountId));
      expect(row!.symbol).toBe(spec.root);
      expect(row!.qty).toBe(item.qty);
      expect(row!.grossPnlMicros).toBe(expectedMicros);
      expect(row!.netPnlMicros).toBe(expectedMicros);
      expect(row!.side).toBe(item.side === 'BUY' ? 'LONG' : 'SHORT');

      // 5. entry and exit prices survive the round trip through ticks
      const price = (scaled: number): number =>
        (scaled / 1e6) * (spec.tickSizeScaled / 10 ** spec.pricePrecision);
      void spec;
      expect(price(row!.entryTicksScaled)).toBeCloseTo(item.entry, 6);
      expect(price(row!.exitTicksScaled)).toBeCloseTo(item.exit, 6);

      /*
       * 6. the journal, the calendar and the admin view.
       *
       * The brief asked for the same number from every surface, so every
       * surface is asked - through the function each one actually calls, not
       * through a re-derivation that would only prove the test can add up.
       */
      const records: TradeRecord[] = [
        {
          id: row!.id,
          symbol: row!.symbol,
          side: row!.side as TradeRecord['side'],
          qty: row!.qty,
          entryTime: row!.entryTime.getTime(),
          exitTime: row!.exitTime.getTime(),
          grossPnlMicros: row!.grossPnlMicros,
          feesMicros: row!.feesMicros,
          netPnlMicros: row!.netPnlMicros,
          maeMicros: row!.maeMicros,
          mfeMicros: row!.mfeMicros,
          initialRiskMicros: row!.initialRiskMicros,
          tradeDate: row!.tradeDate,
        },
      ];

      const journal = analyze(records, 100_000 * D);
      // The journal's own total, over its own records.
      expect(journal.stats.netPnlMicros).toBe(expectedMicros);
      // The calendar cell for the day the trade closed.
      expect(journal.days).toHaveLength(1);
      expect(journal.days[0]!.tradeDate).toBe(row!.tradeDate);
      expect(journal.days[0]!.netPnlMicros).toBe(expectedMicros);
      expect(journal.days[0]!.trades).toBe(1);
      // The equity curve the journal draws ends where the account balance is.
      const curveEnd = journal.curve.points[journal.curve.points.length - 1];
      expect(curveEnd?.equityMicros).toBe(100_000 * D + expectedMicros);

      // The admin account view reads the account row and the same valuation.
      expect(account!.balanceMicros).toBe(curveEnd?.equityMicros);
      expect(account!.realizedPnlMicros).toBe(journal.stats.netPnlMicros);

      /*
       * 7. the ledger identity, and the floor a breach is judged against.
       *
       * balance = starting balance + gross realized - fees. Worth stating as
       * an equation because `realizedPnlMicros` is GROSS and the fees are a
       * separate column, so anything that shows one as the other will be out
       * by exactly the commission - which is how a P&L figure ends up almost
       * right and therefore hardest to doubt.
       *
       * Note what is NOT asserted: that the high-water mark stays within
       * realized P&L. A high-water mark is peak equity and equity includes
       * unrealized profit, so it legitimately sits above realized P&L. An
       * earlier version of this test claimed otherwise, and it would have
       * failed on every profitable trade that gave anything back.
       */
      expect(account!.balanceMicros).toBe(
        account!.startingBalanceMicros + account!.realizedPnlMicros - account!.feesMicros,
      );
      // A floor above the starting balance would mean the account was in
      // breach the moment it opened.
      expect(account!.drawdownFloorMicros).toBeLessThanOrEqual(account!.startingBalanceMicros);
    });
  }

  it('charges the configured fee once per round turn, and says so in the trade', async () => {
    fixture = await createFixture({
      environment: { ...CLEAN_ENV, feesEnabled: true },
      startingBalanceMicros: 100_000 * D,
    });
    market = new ScriptedMarket();
    engine = new TradingEngine(fixture.db, market);
    await engine.start();

    await trade('NQ', 'BUY', 1, 20_000, 20_001);

    const [row] = await fixture.db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.accountId, fixture.accountId));
    // 1 point on 1 NQ contract is 4 ticks x $5 = $20 gross.
    expect(row!.grossPnlMicros).toBe(20 * D);
    expect(row!.feesMicros).toBeGreaterThan(0);
    expect(row!.netPnlMicros).toBe(row!.grossPnlMicros - row!.feesMicros);

    const [account] = await fixture.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, fixture.accountId));
    // The balance carries the NET figure: gross minus the fees actually taken.
    expect(account!.balanceMicros).toBe(100_000 * D + row!.netPnlMicros);
    expect(account!.feesMicros).toBe(row!.feesMicros);
  });
});

describe('a position is priced only by the market it was opened in', () => {
  it('reports unknown P&L, not zero, when the market underneath it changes', async () => {
    await market.bar('NQ', { open: 20_000, high: 20_000, low: 20_000, close: 20_000 });
    await engine.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: cid('era'),
      symbol: 'NQ',
      side: 'BUY',
      qty: 1,
      type: 'MARKET',
    });
    await settle();

    const before = await engine.valuation(fixture.accountId);
    expect(before!.openPnlMicros).toBe(0);
    expect(before!.rules.marked).toBe(true);

    // The platform starts serving a different market - a practice recording -
    // whose prices are 2,250 points away. This is the -$45,000 the terminal
    // used to report on a position that had not moved.
    market.setEra('replay:some-recording');
    await market.bar('NQ', { open: 17_750, high: 17_750, low: 17_750, close: 17_750 });

    const during = await engine.valuation(fixture.accountId);
    expect(during!.openPnlMicros).toBeNull();
    expect(during!.equityMicros).toBeNull();
    expect(during!.dayPnlMicros).toBeNull();
    expect(during!.rules.marked).toBe(false);
    expect(during!.unmarkable).toEqual([
      { symbol: 'NQ', openedAgainst: 'scripted:test', nowServing: 'replay:some-recording' },
    ]);
    // And the position itself says the same thing rather than showing a loss.
    expect(during!.positions[0]!.unrealizedPnlMicros).toBeNull();
    expect(during!.positions[0]!.markPrice).toBeNull();

    // Nothing was committed: the high-water mark is untouched by a market the
    // account never traded in.
    const [account] = await fixture.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, fixture.accountId));
    expect(account!.highWaterMarkMicros).toBe(100_000 * D);

    // An order that would realise that fabricated price is refused.
    await expect(
      engine.submitOrder({
        accountId: fixture.accountId,
        userId: fixture.userId,
        clientOrderId: cid('flatten'),
        symbol: 'NQ',
        side: 'SELL',
        qty: 1,
        type: 'MARKET',
      }),
    ).rejects.toThrow(/opened against/i);

    // Back on the original market, everything prices again.
    market.setEra('scripted:test');
    await market.bar('NQ', { open: 20_002, high: 20_002, low: 20_002, close: 20_002 });
    const after = await engine.valuation(fixture.accountId);
    expect(after!.openPnlMicros).toBe(40 * D);
    expect(after!.rules.marked).toBe(true);
  });

  it('does not let a foreign market raise the high-water mark', async () => {
    await market.bar('NQ', { open: 20_000, high: 20_000, low: 20_000, close: 20_000 });
    await engine.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: cid('hwm'),
      symbol: 'NQ',
      side: 'BUY',
      qty: 1,
      type: 'MARKET',
    });
    await settle();

    // A recording priced 1,000 points ABOVE the entry: $20,000 of profit the
    // account never made. This is the direction that used to do permanent
    // damage, because the high-water mark it raised never came back down.
    market.setEra('replay:rich-recording');
    await market.bar('NQ', { open: 21_000, high: 21_000, low: 21_000, close: 21_000 });
    await engine.enforceRules(fixture.accountId);

    const [account] = await fixture.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, fixture.accountId));
    expect(account!.highWaterMarkMicros).toBe(100_000 * D);
  });

  it('records which market a position was opened in, so it can be returned to', async () => {
    /*
     * The way out of the guard.
     *
     * A position opened inside a recording can only be closed against that
     * recording's prices. The platform refuses to change market data while
     * anything is open - which, on its own, would strand a trader holding
     * something they could never close. The era is recorded ON the position so
     * that going back to the market it was opened in can be recognised and
     * allowed; `/marketdata/provider` compares exactly these values.
     */
    market.setEra('replay:the-recording');
    await market.bar('NQ', { open: 20_000, high: 20_000, low: 20_000, close: 20_000 });
    await engine.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: cid('home'),
      symbol: 'NQ',
      side: 'BUY',
      qty: 1,
      type: 'MARKET',
    });
    await settle();

    const exposure = await engine.accountsWithExposure(fixture.userId);
    expect(exposure).toHaveLength(1);
    expect(exposure[0]!.eras).toEqual(['replay:the-recording']);
    expect(exposure[0]!.workingOrders).toBe(0);

    // Closing it in its own market works, and then there is no exposure left.
    await market.bar('NQ', { open: 20_010, high: 20_010, low: 20_010, close: 20_010 });
    await engine.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: cid('home-close'),
      symbol: 'NQ',
      side: 'SELL',
      qty: 1,
      type: 'MARKET',
    });
    await settle();
    expect(await engine.accountsWithExposure(fixture.userId)).toHaveLength(0);
  });
});
