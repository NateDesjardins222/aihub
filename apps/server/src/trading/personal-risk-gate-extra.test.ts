/**
 * Product Recovery Phase 2 — personal-risk behavioral gaps closed on the REAL
 * order path (engine.submitOrder + upsertPersonalControl), raising the four
 * controls that Phase-1/2 mapping found were proven ONLY by the pure evaluator
 * (PROFIT_LOCK, DAILY_DRAWDOWN, TRADING_WINDOW, SESSION_RESTRICTION), and the
 * firm-vs-personal composition (personal can only TIGHTEN, never loosen the firm
 * cap) — to L3. Real Postgres + ScriptedMarket. The pure evaluator is never
 * called directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireInstrument } from '@atlas/instruments';
import { TradingEngine, OrderRejectedError } from './engine.js';
import { OPEN_MARKET_TS, ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';
import { upsertPersonalControl } from '../platform/personal-risk.js';
import type { PersonalControlType, PersonalControlValue } from '@atlas/contracts';

requireInstrument('NQ');
const CLEAN_ENV = {
  fillModel: 'SIMPLE' as const, latencyMs: 0, marketSlippageTicks: 0, stopSlippageTicks: 0,
  requireThroughTradeForLimit: false, feesEnabled: false, useBarRange: true,
};

let fixture: TestFixture; let market: ScriptedMarket; let engine: TradingEngine; let seq = 0;
const cid = (): string => `prge-${(seq += 1)}-${Date.now()}`;

async function setup(maxContracts = 50): Promise<void> {
  fixture = await createFixture({ environment: CLEAN_ENV, maxContracts });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
  await market.quote('NQ', 20_000, OPEN_MARKET_TS);
}
async function control(controlType: PersonalControlType, value: PersonalControlValue): Promise<void> {
  await upsertPersonalControl(fixture.db, {
    accountId: fixture.accountId, ownerUserId: fixture.userId, actorUserId: fixture.userId,
    controlType, enabled: true, mode: 'FLEXIBLE', value,
  });
}
async function order(side: 'BUY' | 'SELL', qty: number): Promise<void> {
  await engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid(), symbol: 'NQ', side, qty, type: 'MARKET' });
  await settle(30);
}
async function expectReject(side: 'BUY' | 'SELL', qty: number): Promise<string> {
  try { await order(side, qty); throw new Error('expected rejection but the order was accepted'); }
  catch (err) { if (err instanceof OrderRejectedError) return err.reason; throw err; }
}
afterEach(async () => { await fixture.close(); });

describe('personal risk gate — extra controls on the real order path (STEP 4/6)', () => {
  beforeEach(() => setup());

  it('E01 PROFIT_LOCK blocks new exposure once the daily profit threshold is reached', async () => {
    await control('PROFIT_LOCK', { valueMicros: 100 * 1_000_000 }); // $100
    await order('BUY', 1);
    await market.quote('NQ', 20_100, OPEN_MARKET_TS + 60_000); // NQ $20/pt ×100 = +$2000 realized on close
    await order('SELL', 1); // realizes a profit well above $100
    expect(await expectReject('BUY', 1)).toBe('PERSONAL_PROFIT_LOCK');
  });

  it('E02 DAILY_DRAWDOWN blocks new exposure once intraday equity falls past the limit', async () => {
    await control('DAILY_DRAWDOWN', { valueMicros: 100 * 1_000_000 }); // $100
    await order('BUY', 1);                                   // open long at 20,000
    await market.quote('NQ', 20_050, OPEN_MARKET_TS + 60_000); // equity high-water rises
    await market.quote('NQ', 19_950, OPEN_MARKET_TS + 120_000); // equity falls > $100 below the high
    expect(await expectReject('BUY', 1)).toBe('PERSONAL_DAILY_DRAWDOWN');
  });

  it('E03 TRADING_WINDOW blocks an order outside the configured window', async () => {
    // OPEN_MARKET_TS is 10:00 America/Chicago; a 09:00–09:30 window excludes it.
    await control('TRADING_WINDOW', { windowStart: '09:00', windowEnd: '09:30' });
    expect(await expectReject('BUY', 1)).toBe('PERSONAL_TRADING_WINDOW');
  });

  it('E04 SESSION_RESTRICTION blocks an order outside the allowed session state', async () => {
    // The market is OPEN at OPEN_MARKET_TS; restricting to PRE_OPEN blocks it.
    await control('SESSION_RESTRICTION', { sessions: ['PRE_OPEN'] });
    expect(await expectReject('BUY', 1)).toBe('PERSONAL_SESSION_RESTRICTION');
  });
});

describe('firm vs personal risk composition on the real order path (STEP 6)', () => {
  it('E05 a LOOSER personal max cannot exceed the firm contract cap (personal never loosens)', async () => {
    await setup(5); // firm cap = 5 contracts
    await control('MAX_POSITION', { valueInt: 10 }); // personal wants 10 — looser than firm
    // Attempting 6 must be rejected by the FIRM cap, proving the looser personal
    // value did not permit it. Effective max = min(firm 5, personal 10) = 5.
    const reason = await expectReject('BUY', 6);
    expect(reason).toBe('MAX_CONTRACTS_EXCEEDED');
    // And 5 (the firm cap) is allowed.
    await order('BUY', 5);
  });

  it('E06 a STRICTER personal max is enforced below the firm cap', async () => {
    await setup(5); // firm cap = 5
    await control('MAX_POSITION', { valueInt: 2 }); // personal tighter than firm
    await order('BUY', 2); // at the personal cap
    expect(await expectReject('BUY', 1)).toBe('PERSONAL_MAX_POSITION'); // personal binds first
  });
});
