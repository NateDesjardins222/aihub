/**
 * The −$45,000 shape: a legacy position with no provenance (Terminal Hardening V5).
 *
 * The money-math audit found that the only remaining path to a fabricated large
 * loss was a position stored with BOTH `marketEra` null AND `contractCode` null —
 * pre-provenance rows the era/contract locks didn't retro-apply to. Such a row
 * was "marked as before", i.e. priced against whatever the current root feed
 * serves, regardless of which market/contract it was really opened in. That is
 * exactly how a wrong-era price becomes a phantom −$45,000.
 *
 * `markTicksFor` now treats no-provenance-at-all as UNMARKABLE. This test proves
 * a wild feed price can no longer fabricate a loss on such a row, and that the
 * account reads UNKNOWN (a dash) rather than a number nobody earned.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { positions as positionsTable } from '../db/schema.js';
import { TradingEngine } from './engine.js';
import { ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';

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

beforeEach(async () => {
  fixture = await createFixture({
    environment: CLEAN_ENV,
    startingBalanceMicros: 100_000 * 1_000_000,
    rules: { maxLossMicros: 90_000 * 1_000_000, drawdownType: 'STATIC', flattenOnBreach: false },
  });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
});
afterEach(async () => {
  engine.stop();
  await fixture.close();
});

async function open1Long(price: number): Promise<void> {
  await market.bar('NQ', { open: price, high: price, low: price, close: price });
  await engine.submitOrder({
    accountId: fixture.accountId,
    userId: fixture.userId,
    clientOrderId: `o-${Date.now()}`,
    symbol: 'NQ',
    side: 'BUY',
    qty: 1,
    type: 'MARKET',
  });
  await settle();
}

describe('a no-provenance legacy position cannot fabricate a loss', () => {
  it('reads UNKNOWN, not a wild number, when marked by the current feed', async () => {
    await open1Long(20_000);
    // A normal, provenance-carrying position prices correctly at a nearby mark.
    await market.quote('NQ', 19_990);
    let v = await engine.valuation(fixture.accountId);
    expect(v!.openPnlMicros).toBe(-200_000_000); // -10pt * $20 = -$200

    // Strip the provenance to simulate a legacy pre-era row.
    await fixture.db
      .update(positionsTable)
      .set({ marketEra: null, contractCode: null })
      .where(eq(positionsTable.accountId, fixture.accountId));

    // A wild feed price that, if trusted, would fabricate ≈ -$45,000
    // (2,250 pts * $20). It must NOT be trusted for a no-provenance row.
    await market.quote('NQ', 17_750);
    v = await engine.valuation(fixture.accountId);
    expect(v!.openContracts).toBe(1); // still held
    expect(v!.openPnlMicros).toBeNull(); // UNKNOWN — no phantom -$45k
    expect(v!.equityMicros).toBeNull();
    expect(v!.unmarkable.length).toBeGreaterThanOrEqual(1);
  });

  it('a row that still has its era is unaffected (the guard is specific)', async () => {
    await open1Long(20_000);
    // Null ONLY the contract, keep the era: the era lock still governs it, and a
    // same-era mark still prices — the guard only fires when BOTH are absent.
    await fixture.db
      .update(positionsTable)
      .set({ contractCode: null })
      .where(eq(positionsTable.accountId, fixture.accountId));
    await market.quote('NQ', 19_990);
    const v = await engine.valuation(fixture.accountId);
    expect(v!.openPnlMicros).toBe(-200_000_000);
  });
});
