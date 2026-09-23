/**
 * The independent money oracle (Terminal Hardening V5, P0).
 *
 * This test does NOT import or reuse Atlas's P&L functions (`unrealizedPnlMicros`,
 * `ticksToMicros`, the position reducer). It re-derives expected account money
 * from first principles — published CME point values, the fills, and the mark —
 * in its own integer-micro arithmetic, and compares Atlas against it after every
 * operation. If Atlas ever multiplied by the wrong contract size, confused a
 * micro for its mini, doubled a quantity, corrupted a scale-in cost basis, or
 * mishandled a reverse, the oracle disagrees and the test fails.
 *
 * Point values are the REAL contract economics (dollars per full index/price
 * point), written here independently of Atlas's registry:
 *   NQ $20   MNQ $2    ES $50   MES $5
 *   GC $100  MGC $10   CL $1000 MCL $100
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TradingEngine } from './engine.js';
import { ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';

const M = 1_000_000; // micros per dollar
/** Dollars per one full point, times M → micros per point. Independent of Atlas. */
const POINT_VALUE_MICROS: Record<string, number> = {
  NQ: 20 * M,
  MNQ: 2 * M,
  ES: 50 * M,
  MES: 5 * M,
  GC: 100 * M,
  MGC: 10 * M,
  CL: 1000 * M,
  MCL: 100 * M,
};
const BASE: Record<string, number> = {
  NQ: 20000,
  MNQ: 20000,
  ES: 5000,
  MES: 5000,
  GC: 2000,
  MGC: 2000,
  CL: 75,
  MCL: 75,
};

const CLEAN_ENV = {
  fillModel: 'SIMPLE' as const,
  latencyMs: 0,
  marketSlippageTicks: 0,
  stopSlippageTicks: 0,
  requireThroughTradeForLimit: false,
  feesEnabled: false,
  useBarRange: true,
};

// --- the oracle: its own bookkeeping, no Atlas math ------------------------
class Oracle {
  qty = 0; // signed
  private avg = 0; // points, weighted
  realizedMicros = 0;
  constructor(private readonly pv: number) {}
  fill(side: 'BUY' | 'SELL', q: number, price: number): void {
    const signed = side === 'BUY' ? q : -q;
    if (this.qty === 0 || Math.sign(this.qty) === Math.sign(signed)) {
      const abs = Math.abs(this.qty) + q;
      this.avg = (Math.abs(this.qty) * this.avg + q * price) / abs;
      this.qty += signed;
      return;
    }
    // Opposite side: close, then possibly flip.
    const closeQty = Math.min(q, Math.abs(this.qty));
    const perPoint = this.qty > 0 ? price - this.avg : this.avg - price;
    this.realizedMicros += Math.round(closeQty * perPoint * this.pv);
    const remaining = q - closeQty;
    this.qty += signed;
    if (this.qty === 0) this.avg = 0;
    else if (remaining > 0) this.avg = price; // flipped: new basis is the fill
  }
  unrealizedMicros(mark: number): number {
    if (this.qty === 0) return 0;
    const perPoint = this.qty > 0 ? mark - this.avg : this.avg - mark;
    return Math.round(Math.abs(this.qty) * perPoint * this.pv);
  }
}

let fixture: TestFixture;
let market: ScriptedMarket;
let engine: TradingEngine;
let seq = 0;
const STARTING = 100_000 * M;

beforeEach(async () => {
  fixture = await createFixture({
    environment: CLEAN_ENV,
    startingBalanceMicros: STARTING,
    maxContracts: 100,
    // Permissive rules: this test is about arithmetic, not risk breaches.
    rules: { maxLossMicros: 90_000 * M, drawdownType: 'STATIC', flattenOnBreach: false },
  });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
});
afterEach(async () => {
  engine.stop();
  await fixture.close();
});

async function fill(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number): Promise<void> {
  await market.bar(symbol, { open: price, high: price, low: price, close: price });
  await engine.submitOrder({
    accountId: fixture.accountId,
    userId: fixture.userId,
    clientOrderId: `o-${(seq += 1)}-${Date.now()}`,
    symbol,
    side,
    qty,
    type: 'MARKET',
  });
  await settle();
}

/** Compare Atlas's valuation against the oracle at a given mark. */
async function agree(symbol: string, oracle: Oracle, mark: number, label: string): Promise<void> {
  await market.quote(symbol, mark);
  const v = await engine.valuation(fixture.accountId);
  const expectedOpen = oracle.unrealizedMicros(mark);
  const expectedBalance = STARTING + oracle.realizedMicros;
  expect(v!.openContracts, `${label}: openContracts`).toBe(Math.abs(oracle.qty));
  expect(v!.openPnlMicros, `${label}: openPnl`).toBe(expectedOpen);
  expect(v!.realizedPnlMicros, `${label}: realized`).toBe(oracle.realizedMicros);
  expect(v!.balanceMicros, `${label}: balance`).toBe(expectedBalance);
  expect(v!.equityMicros, `${label}: equity`).toBe(expectedBalance + expectedOpen);
}

describe('independent money oracle — per instrument, long & short, 1/2/5 contracts', () => {
  for (const symbol of Object.keys(POINT_VALUE_MICROS)) {
    const pv = POINT_VALUE_MICROS[symbol]!;
    const base = BASE[symbol]!;
    it(`${symbol}: long/short exact dollars`, async () => {
      for (const qty of [1, 2, 5]) {
        for (const side of ['BUY', 'SELL'] as const) {
          const o = new Oracle(pv);
          await fill(symbol, side, qty, base);
          o.fill(side, qty, base);
          // +10 points and -10 points from entry.
          await agree(symbol, o, base + 10, `${symbol} ${side} ${qty} +10pt`);
          await agree(symbol, o, base - 10, `${symbol} ${side} ${qty} -10pt`);
          // Flatten for the next iteration.
          await fill(symbol, side === 'BUY' ? 'SELL' : 'BUY', qty, base);
          o.fill(side === 'BUY' ? 'SELL' : 'BUY', qty, base);
        }
      }
    });
  }
});

describe('independent money oracle — lifecycle (scale-in, partial, reverse)', () => {
  for (const symbol of ['NQ', 'CL'] as const) {
    it(`${symbol}: full lifecycle agrees at every step`, async () => {
      const pv = POINT_VALUE_MICROS[symbol]!;
      const base = BASE[symbol]!;
      const o = new Oracle(pv);
      // Scale in to a clean weighted average.
      await fill(symbol, 'BUY', 1, base);
      o.fill('BUY', 1, base);
      await agree(symbol, o, base + 4, `${symbol} open`);
      await fill(symbol, 'BUY', 1, base + 10);
      o.fill('BUY', 1, base + 10); // avg = base+5, clean
      await agree(symbol, o, base + 12, `${symbol} scaled in`);
      await fill(symbol, 'BUY', 2, base + 5); // avg stays base+5
      o.fill('BUY', 2, base + 5);
      await agree(symbol, o, base + 20, `${symbol} scaled in again`);
      // Partial close 1.
      await fill(symbol, 'SELL', 1, base + 15);
      o.fill('SELL', 1, base + 15);
      await agree(symbol, o, base + 8, `${symbol} partial close`);
      // Reverse through zero: sell 5 (hold 3 long) → 2 short.
      await fill(symbol, 'SELL', 5, base + 2);
      o.fill('SELL', 5, base + 2);
      await agree(symbol, o, base - 3, `${symbol} reversed to short`);
      // Flatten.
      await fill(symbol, 'BUY', 2, base - 1);
      o.fill('BUY', 2, base - 1);
      expect(o.qty).toBe(0);
      await agree(symbol, o, base, `${symbol} flat`);
    });
  }
});

describe('mini/micro cannot receive each other economics', () => {
  it('MNQ P&L is exactly 1/10 of NQ for the same move (never mini economics)', async () => {
    const nq = new Oracle(POINT_VALUE_MICROS.NQ!);
    await fill('NQ', 'BUY', 1, BASE.NQ!);
    nq.fill('BUY', 1, BASE.NQ!);
    await agree('NQ', nq, BASE.NQ! + 10, 'NQ long +10');
    const vNq = (await engine.valuation(fixture.accountId))!.openPnlMicros!;
    await fill('NQ', 'SELL', 1, BASE.NQ!); // flatten NQ
    nq.fill('SELL', 1, BASE.NQ!);

    const mnq = new Oracle(POINT_VALUE_MICROS.MNQ!);
    await fill('MNQ', 'BUY', 1, BASE.MNQ!);
    mnq.fill('BUY', 1, BASE.MNQ!);
    await agree('MNQ', mnq, BASE.MNQ! + 10, 'MNQ long +10');
    // Need NQ flat/priced so account equity is defined; MNQ is what we read.
    const vMnq = mnq.unrealizedMicros(BASE.MNQ! + 10);
    expect(vNq).toBe(200 * M); // NQ 10pt = $200
    expect(vMnq).toBe(20 * M); // MNQ 10pt = $20, exactly 1/10 — different economics
    expect(vNq).toBe(vMnq * 10);
  });
});
