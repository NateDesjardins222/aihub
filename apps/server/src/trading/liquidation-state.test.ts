/**
 * The liquidation state machine (Terminal Hardening V5, §1-3).
 *
 * The user saw "Trading is locked for the rest of the trading day" while the
 * position stayed OPEN. Root cause: the lock status is persisted independently
 * of whether the flatten actually closed the position, and the UI showed only
 * "locked". The engine now reports an explicit liquidation state so the terminal
 * can never imply zero exposure before it is real:
 *   NOT_REQUIRED · PENDING (locked AND still exposed) · DONE (locked and flat).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TradingEngine, liquidationStateOf } from './engine.js';
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

async function setup(flattenOnBreach: boolean) {
  fixture = await createFixture({
    environment: CLEAN_ENV,
    startingBalanceMicros: 100_000 * 1_000_000,
    // A tight $2,000 static max loss so a modest adverse move breaches.
    rules: { maxLossMicros: 2_000_000_000, drawdownType: 'STATIC', flattenOnBreach },
  });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
}
async function open1Long(price: number) {
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
afterEach(async () => {
  engine?.stop();
  await fixture?.close();
});

describe('liquidationStateOf (pure)', () => {
  it('maps status + policy + exposure to the truthful state', () => {
    expect(liquidationStateOf('ACTIVE', true, 0)).toBe('NOT_REQUIRED');
    expect(liquidationStateOf('ACTIVE', true, 2)).toBe('NOT_REQUIRED');
    expect(liquidationStateOf('FAILED', false, 3)).toBe('NOT_REQUIRED'); // block-only lock
    expect(liquidationStateOf('FAILED', true, 3)).toBe('PENDING'); // locked AND exposed
    expect(liquidationStateOf('LOCKED', true, 1)).toBe('PENDING');
    expect(liquidationStateOf('FAILED', true, 0)).toBe('DONE'); // locked and flat
  });
});

describe('engine reports PENDING while locked-but-open, DONE once flat', () => {
  beforeEach(() => setup(true));

  it('a breach whose flatten cannot fill on a stale feed reads locked + PENDING', async () => {
    await open1Long(20_000);
    // Feed goes stale, then the breaching price arrives: the breach is seen but
    // the liquidation MARKET order cannot fill (order entry is gated on a stale
    // feed). The account is locked AND still exposed.
    market.setStale(true);
    await market.quote('NQ', 19_940); // -60pt * $20 = -$1,200... push further:
    await market.quote('NQ', 19_870); // -130pt * $20 = -$2,600 > $2,000 max loss
    await engine.enforceRules(fixture.accountId);

    const v = await engine.valuation(fixture.accountId);
    expect(['FAILED', 'LOCKED']).toContain(v!.rules.status);
    expect(v!.openContracts, 'still exposed').toBe(1);
    expect(v!.liquidation, 'locked but not flat → PENDING').toBe('PENDING');

    // Feed recovers: the retried liquidation can fill, and it goes flat + DONE.
    market.setStale(false);
    await market.quote('NQ', 19_870);
    await engine.enforceRules(fixture.accountId);
    await settle();
    const after = await engine.valuation(fixture.accountId);
    expect(after!.openContracts, 'flattened once it could').toBe(0);
    expect(after!.liquidation).toBe('DONE');
  });
});

describe('a block-only lock (flattenOnBreach:false) is NOT_REQUIRED, position remains by design', () => {
  beforeEach(() => setup(false));

  it('breaches to locked with the position open and liquidation NOT_REQUIRED', async () => {
    await open1Long(20_000);
    await market.quote('NQ', 19_870); // breach
    await engine.enforceRules(fixture.accountId);
    const v = await engine.valuation(fixture.accountId);
    expect(['FAILED', 'LOCKED']).toContain(v!.rules.status);
    expect(v!.openContracts).toBe(1);
    expect(v!.liquidation).toBe('NOT_REQUIRED');
  });
});
