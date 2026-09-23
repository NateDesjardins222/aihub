/**
 * Execution race torture (Terminal Hardening V5, Phase 1).
 *
 * The money model is proven correct by the oracle; this file attacks the
 * *execution* paths where a race can silently turn a close into a reversal, a
 * flatten into a double, or leave a bracket protecting a position that no longer
 * exists. Every mutation runs under the per-account mutex, so these tests fire
 * the mutations concurrently and out of order and prove the serialization holds:
 *
 *   - flatten is idempotent: spamming it never doubles, never reverses;
 *   - flatten and reverse cancel protection FIRST, so a leg can never fire into
 *     the wrong side;
 *   - a bracket's protective quantity tracks the live position through scale-in
 *     and scale-out, and there is never an orphan protective order after flat;
 *   - risk liquidation and a manual flatten racing each other still land flat,
 *     never short, never doubled.
 *
 * These run against the real PostgreSQL persistence path, because the bugs worth
 * catching live in the transaction boundaries a mock would paper over.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { requireInstrument } from '@atlas/instruments';
import { orders as ordersTable, positions as positionsTable } from '../db/schema.js';
import { TradingEngine } from './engine.js';
import { ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';

const NQ = requireInstrument('NQ');

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

async function setup(overrides?: Parameters<typeof createFixture>[0]): Promise<void> {
  fixture = await createFixture({ environment: CLEAN_ENV, maxContracts: 50, ...overrides });
  market = new ScriptedMarket();
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
    clientOrderId: cid('t'),
    symbol: 'NQ',
    side: 'BUY',
    qty: 1,
    type: 'MARKET',
    ...input,
  });
}

async function position() {
  const [row] = await fixture.db
    .select()
    .from(positionsTable)
    .where(and(eq(positionsTable.accountId, fixture.accountId), eq(positionsTable.symbol, 'NQ')));
  return row;
}

async function orderRows() {
  return fixture.db.select().from(ordersTable).where(eq(ordersTable.accountId, fixture.accountId));
}

/** The protective legs still live in the book (would fire on the next mark). */
async function workingProtection() {
  const rows = await orderRows();
  return rows.filter(
    (r) =>
      (r.bracketRole === 'STOP_LOSS' || r.bracketRole === 'TAKE_PROFIT') &&
      (r.status === 'WORKING' || r.status === 'PARTIALLY_FILLED'),
  );
}

afterEach(async () => {
  engine?.stop();
  await fixture?.close();
});

// ---------------------------------------------------------------------------

describe('flatten is idempotent under concurrency', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
  });

  it('spamming flatten on a long lands flat exactly once — never doubled, never reversed', async () => {
    await submit({ qty: 3, side: 'BUY' });
    await settle();
    expect((await position())!.qty).toBe(3);

    const before = (await engine.valuation(fixture.accountId))!.realizedPnlMicros;

    // Ten flattens fired at once. The mutex serializes them: the first reads
    // qty 3 and closes it; every later one reads qty 0 and is a no-op. A broken
    // serialization would let a second flatten read the stale qty and sell
    // again, flipping the account short.
    await Promise.all(Array.from({ length: 10 }, () => engine.flatten(fixture.accountId, fixture.userId, 'NQ')));
    await settle();

    expect((await position())!.qty, 'flat, not reversed').toBe(0);

    // Exactly one closing trade's worth of realized P&L: at the same price the
    // round trip is zero, and a double-close would show a second (here zero, but
    // the trade COUNT is the real proof).
    const after = (await engine.valuation(fixture.accountId))!.realizedPnlMicros;
    expect(after).toBe(before);

    // No stray SELL beyond the one that closed the position.
    const fills = (await orderRows())
      .filter((r) => r.side === 'SELL')
      .reduce((n, r) => n + r.filledQty, 0);
    expect(fills, 'sold exactly the 3 held').toBe(3);
  });

  it('flatten then immediate re-buy is not swallowed as a duplicate', async () => {
    await submit({ qty: 2, side: 'BUY' });
    await settle();
    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle();
    expect((await position())!.qty).toBe(0);

    // A fresh entry after flat must fill — the flatten's synthetic client id
    // must never collide with a real order and suppress it.
    await submit({ qty: 1, side: 'BUY' });
    await settle();
    expect((await position())!.qty).toBe(1);
  });
});

describe('flatten and reverse cancel protection before acting', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
  });

  it('flatten cancels the bracket and leaves no protective order behind', async () => {
    await submit({ qty: 2, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    await settle(20);
    expect(await workingProtection()).toHaveLength(2);

    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle();

    expect((await position())!.qty).toBe(0);
    // The exit sold exactly 2. A leftover working stop for 2 would, on the next
    // adverse mark, SELL again and open a short in a "flat" account.
    expect(await workingProtection(), 'no orphan protection').toHaveLength(0);

    // Prove it: push a wild adverse mark and settle. A flat account stays flat.
    await market.quote('NQ', 19_900);
    await settle();
    expect((await position())!.qty, 'still flat after a big move').toBe(0);
  });

  it('reverse flips a long to the same-size short and drops the old protection', async () => {
    await submit({ qty: 3, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    await settle(20);

    await engine.reverse(fixture.accountId, fixture.userId, 'NQ');
    await settle();

    const p = await position();
    expect(p!.qty, 'flipped to short 3').toBe(-3);
    expect(p!.side).toBe('SHORT');
    // The long's protective legs (SELL side) must be gone — a SELL stop on a
    // short position protects nothing and could double the short.
    expect(await workingProtection()).toHaveLength(0);
  });

  it('flatten racing reverse still lands at a single definite state, never doubled', async () => {
    await submit({ qty: 2, side: 'BUY' });
    await settle();

    // Both fired together. The mutex picks an order; whichever runs second sees
    // the state the first left. The only illegal outcomes are |qty| > 2 (a
    // double) — reverse can legitimately leave -2, flatten 0.
    await Promise.all([
      engine.flatten(fixture.accountId, fixture.userId, 'NQ'),
      engine.reverse(fixture.accountId, fixture.userId, 'NQ'),
    ]);
    await settle();

    const q = (await position())!.qty;
    expect(Math.abs(q), 'never doubled past the original size').toBeLessThanOrEqual(2);
    expect([0, -2]).toContain(q);
  });
});

describe('scale-in / scale-out keeps protection sized to the live position', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
  });

  it('a sole bracket grows on scale-in and shrinks on scale-out, then clears at flat', async () => {
    // Open 1 with a bracket. It is the only bracketed entry, so its legs may
    // grow to cover contracts added by later unbracketed scale-ins.
    await submit({ qty: 1, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    await settle(20);
    let prot = await workingProtection();
    expect(prot).toHaveLength(2);
    expect(prot.every((p) => p.qty === 1)).toBe(true);

    // Scale in +2 (unbracketed). Protection grows to the whole position of 3.
    await submit({ qty: 2, side: 'BUY' });
    await settle(20);
    expect((await position())!.qty).toBe(3);
    prot = await workingProtection();
    expect(prot).toHaveLength(2);
    expect(prot.every((p) => p.qty === 3), 'stop AND target both cover 3').toBe(true);

    // Scale out -1 by hand. Protection shrinks to 2 — never leaves a stop for 3
    // that would reverse the reduced position.
    await submit({ qty: 1, side: 'SELL' });
    await settle(20);
    expect((await position())!.qty).toBe(2);
    prot = await workingProtection();
    expect(prot.every((p) => p.qty === 2), 'protection tracked the reduction').toBe(true);

    // Scale out the rest by hand. No protective order may remain: a leftover leg
    // is a live order that opens fresh exposure into a flat account.
    await submit({ qty: 2, side: 'SELL' });
    await settle(20);
    expect((await position())!.qty).toBe(0);
    expect(await workingProtection(), 'no orphan after manual flat').toHaveLength(0);
  });

  it('a hand scale-out to flat cannot reverse via a stale stop', async () => {
    await submit({ qty: 2, side: 'BUY', bracket: { stopLossTicks: 40, takeProfitTicks: 80 } });
    await settle(20);

    // Sell the whole position by hand (not via flatten). The bracket must be
    // reconciled to the new flat position, not left able to fire.
    await submit({ qty: 2, side: 'SELL' });
    await settle(20);
    expect((await position())!.qty).toBe(0);
    expect(await workingProtection()).toHaveLength(0);

    // A hard adverse move: a surviving SELL stop would open a short here.
    await market.quote('NQ', 19_800);
    await settle();
    expect((await position())!.qty, 'flat stays flat').toBe(0);
  });
});

describe('modify vs fill: a stale drag cannot corrupt a filled order', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
  });

  it('a modify carrying the pre-fill version is rejected, and the fill stands', async () => {
    // A resting buy limit below the market.
    const limitTicks = Math.round(20_000 * 4) - 40; // 19,990
    const submitted = await submit({ type: 'LIMIT', side: 'BUY', qty: 1, limitTicks });
    const orderId = submitted.orders[0]!.id;
    const staleVersion = submitted.orders[0]!.version;
    expect(submitted.fills).toHaveLength(0);

    // The market trades through it and it fills — its version bumps.
    await market.quote('NQ', 19_985);
    await settle(30);
    expect((await position())!.qty).toBe(1);

    // A drag that began before the fill now lands with the stale version. It
    // must be rejected, not silently applied to a filled order (which could
    // resize a done trade and desync the position from the fills).
    await expect(
      engine.modifyOrder(fixture.accountId, orderId, { qty: 5 }, staleVersion),
    ).rejects.toMatchObject({ reason: 'STALE_ORDER_VERSION' });

    // The fill is untouched: still exactly 1 contract, no phantom resize.
    expect((await position())!.qty).toBe(1);
    const [row] = (await orderRows()).filter((r) => r.id === orderId);
    expect(row!.status).toBe('FILLED');
    expect(row!.qty).toBe(1);
    expect(row!.filledQty).toBe(1);
  });
});

describe('flatten isolates one instrument from another', () => {
  beforeEach(async () => {
    await setup();
    await market.quote('NQ', 20_000);
    await market.quote('ES', 5_000);
  });

  it('flattening NQ leaves an open ES position completely untouched', async () => {
    await submit({ symbol: 'NQ', qty: 2, side: 'BUY' });
    await submit({ symbol: 'ES', qty: 3, side: 'BUY' });
    await settle();

    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle();

    const [nq] = await fixture.db
      .select()
      .from(positionsTable)
      .where(and(eq(positionsTable.accountId, fixture.accountId), eq(positionsTable.symbol, 'NQ')));
    const [es] = await fixture.db
      .select()
      .from(positionsTable)
      .where(and(eq(positionsTable.accountId, fixture.accountId), eq(positionsTable.symbol, 'ES')));

    expect(nq!.qty, 'NQ flat').toBe(0);
    expect(es!.qty, 'ES untouched by the NQ flatten').toBe(3);
    expect(es!.side).toBe('LONG');
  });
});

describe('risk liquidation vs manual flatten', () => {
  it('a manual flatten racing a breach liquidation lands flat, never short or doubled', async () => {
    await setup({
      startingBalanceMicros: 100_000 * 1_000_000,
      rules: { maxLossMicros: 2_000_000_000, drawdownType: 'STATIC', flattenOnBreach: true },
    });
    await market.quote('NQ', 20_000);
    await submit({ qty: 3, side: 'BUY' });
    await settle();

    // A breach-inducing move AND a manual flatten at the same instant. Both want
    // the position closed; the mutex must not let them sell 6.
    await market.quote('NQ', 19_860); // -140pt * $20 * 3 = -$8,400 << -$2,000 floor
    await Promise.all([
      engine.enforceRules(fixture.accountId),
      engine.flatten(fixture.accountId, fixture.userId, 'NQ'),
    ]);
    await settle();

    const p = await position();
    expect(p!.qty, 'flat, never reversed by a double-close').toBe(0);

    const sold = (await orderRows())
      .filter((r) => r.side === 'SELL')
      .reduce((n, r) => n + r.filledQty, 0);
    expect(sold, 'sold exactly the 3 held, not 6').toBe(3);

    const v = await engine.valuation(fixture.accountId);
    expect(['FAILED', 'LOCKED']).toContain(v!.rules.status);
    expect(v!.liquidation, 'locked and flat → DONE').toBe('DONE');
  });
});
