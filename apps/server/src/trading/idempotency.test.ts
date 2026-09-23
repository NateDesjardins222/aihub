/**
 * Duplicate & idempotency attacks (Terminal Hardening V5, §5).
 *
 * A duplicated order or fill must change money EXACTLY ONCE. Re-submitting the
 * same clientOrderId must never create doubled exposure or doubled realized P&L.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

async function submit(clientOrderId: string, side: 'BUY' | 'SELL', qty: number, price: number) {
  await market.bar('NQ', { open: price, high: price, low: price, close: price });
  const change = await engine.submitOrder({
    accountId: fixture.accountId,
    userId: fixture.userId,
    clientOrderId,
    symbol: 'NQ',
    side,
    qty,
    type: 'MARKET',
  });
  await settle();
  return change;
}

describe('duplicate order / fill idempotency', () => {
  it('resubmitting the same clientOrderId does not double exposure or realized', async () => {
    await submit('dup-1', 'BUY', 1, 20_000);
    let v = await engine.valuation(fixture.accountId);
    expect(v!.openContracts).toBe(1);

    // Exact same clientOrderId again (a retry, a double-click, a replayed POST).
    await submit('dup-1', 'BUY', 1, 20_000);
    v = await engine.valuation(fixture.accountId);
    expect(v!.openContracts, 'still one contract').toBe(1);

    // Close it, then replay the close's clientOrderId — realized must move once.
    await market.quote('NQ', 20_010);
    await submit('close-1', 'SELL', 1, 20_010);
    const afterClose = await engine.valuation(fixture.accountId);
    expect(afterClose!.openContracts).toBe(0);
    const realizedOnce = afterClose!.realizedPnlMicros;
    expect(realizedOnce).toBe(200_000_000); // +10pt * $20

    await submit('close-1', 'SELL', 1, 20_010); // replay
    const afterReplay = await engine.valuation(fixture.accountId);
    expect(afterReplay!.openContracts, 'no phantom short from a replayed close').toBe(0);
    expect(afterReplay!.realizedPnlMicros, 'realized applied exactly once').toBe(realizedOnce);
    expect(afterReplay!.balanceMicros).toBe(100_000 * 1_000_000 + realizedOnce);
  });

  it('distinct clientOrderIds are honoured (dedup is on the id, not the shape)', async () => {
    await submit('a', 'BUY', 1, 20_000);
    await submit('b', 'BUY', 1, 20_000);
    const v = await engine.valuation(fixture.accountId);
    expect(v!.openContracts, 'two genuine orders → two contracts').toBe(2);
  });
});
