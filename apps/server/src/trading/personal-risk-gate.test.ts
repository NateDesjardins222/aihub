/**
 * Personal risk gate on the REAL order path (M5-F) — engine integration.
 * Real Postgres + ScriptedMarket. Proves the gate blocks exposure-increasing
 * orders, never blocks reductions/flatten, maintains per-day counters on fills,
 * and reacts to real closed losing trades (consecutive-loss + cooldown + loss).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireInstrument } from '@atlas/instruments';
import { TradingEngine, OrderRejectedError } from './engine.js';
import { OPEN_MARKET_TS, ACCOUNT_TRADING_DATE, ScriptedMarket, createFixture, settle, type TestFixture } from './harness.js';
import { upsertPersonalControl } from '../platform/personal-risk.js';
import { getDayState } from './personal-risk-store.js';
import type { PersonalControlType, PersonalControlValue, PersonalControlMode } from '@atlas/contracts';

requireInstrument('NQ');
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

async function setup(): Promise<void> {
  fixture = await createFixture({ environment: CLEAN_ENV, maxContracts: 50 });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
  await market.quote('NQ', 20_000, OPEN_MARKET_TS);
}

afterEach(async () => {
  await fixture.close();
});

function cid(): string {
  seq += 1;
  return `prg-${seq}-${Date.now()}`;
}

async function control(
  controlType: PersonalControlType,
  value: PersonalControlValue,
  opts: { enabled?: boolean; mode?: PersonalControlMode } = {},
): Promise<void> {
  await upsertPersonalControl(fixture.db, {
    accountId: fixture.accountId,
    ownerUserId: fixture.userId,
    actorUserId: fixture.userId,
    controlType,
    enabled: opts.enabled ?? true,
    mode: opts.mode ?? 'FLEXIBLE',
    value,
  });
}

async function order(side: 'BUY' | 'SELL', qty: number): Promise<void> {
  await engine.submitOrder({
    accountId: fixture.accountId,
    userId: fixture.userId,
    clientOrderId: cid(),
    symbol: 'NQ',
    side,
    qty,
    type: 'MARKET',
  });
  await settle(30);
}

async function expectReject(side: 'BUY' | 'SELL', qty: number): Promise<string> {
  try {
    await order(side, qty);
    throw new Error('expected rejection but the order was accepted');
  } catch (err) {
    if (err instanceof OrderRejectedError) return err.reason;
    throw err;
  }
}

describe('personal risk gate on the order path (M5-F)', () => {
  beforeEach(setup);

  it('G01 no personal controls → trading is unaffected (regression)', async () => {
    await order('BUY', 2);
    const day = await getDayState(fixture.db, fixture.accountId, ACCOUNT_TRADING_DATE);
    // No enabled controls → the gate short-circuits, but fills still record
    // the day-state counters (they are maintained unconditionally).
    expect(day?.openingTradeCount ?? 0).toBe(1);
    expect(day?.contractsOpened ?? 0).toBe(2);
  });

  it('G02 max trades blocks a second opening order but never a flatten', async () => {
    await control('MAX_TRADES', { valueInt: 1 });
    await order('BUY', 1); // opens, counts as trade 1/1
    expect(await expectReject('BUY', 1)).toBe('PERSONAL_MAX_TRADES');
    // Flatten (reduce) is always allowed, even at the cap.
    await order('SELL', 1);
    const day = await getDayState(fixture.db, fixture.accountId, ACCOUNT_TRADING_DATE);
    expect(day?.openingTradeCount).toBe(1);
  });

  it('G03 max position blocks the increasing portion but allows reducing', async () => {
    await control('MAX_POSITION', { valueInt: 2 });
    await order('BUY', 2); // at the max
    expect(await expectReject('BUY', 1)).toBe('PERSONAL_MAX_POSITION');
    await order('SELL', 1); // reduce → allowed
  });

  it('G04 daily contract limit counts filled opening quantity', async () => {
    await control('DAILY_CONTRACT_LIMIT', { valueInt: 3 });
    await order('BUY', 2); // 2/3
    expect(await expectReject('BUY', 2)).toBe('PERSONAL_DAILY_CONTRACT_LIMIT'); // 2+2>3
    await order('BUY', 1); // exactly 3/3 allowed
    const day = await getDayState(fixture.db, fixture.accountId, ACCOUNT_TRADING_DATE);
    expect(day?.contractsOpened).toBe(3);
  });

  it('G05 a reversal counts as one new trade for the opened side', async () => {
    await control('MAX_TRADES', { valueInt: 5 });
    await order('BUY', 2); // trade 1: long 2
    await order('SELL', 5); // closes 2, opens short 3 → one new trade
    const day = await getDayState(fixture.db, fixture.accountId, ACCOUNT_TRADING_DATE);
    expect(day?.openingTradeCount).toBe(2);
    expect(day?.contractsOpened).toBe(5); // 2 long + 3 short opened
  });

  it('G06 a real losing trade trips the consecutive-loss lock and cooldown', async () => {
    await control('CONSECUTIVE_LOSS_LOCK', { valueInt: 1 });
    await control('COOLDOWN', { valueInt: 30 });
    // Open long, price falls, flatten → realized loss.
    await order('BUY', 1);
    await market.quote('NQ', 19_900, OPEN_MARKET_TS + 60_000);
    await order('SELL', 1); // closes at a loss
    const day = await getDayState(fixture.db, fixture.accountId, ACCOUNT_TRADING_DATE);
    expect(day?.consecutiveLosses).toBe(1);
    expect(day?.lastLossClosedAtMs).not.toBeNull();
    // A new opening order is now blocked (consecutive-loss OR cooldown — both apply).
    const reason = await expectReject('BUY', 1);
    expect(['PERSONAL_CONSECUTIVE_LOSS_LOCK', 'PERSONAL_COOLDOWN']).toContain(reason);
  });

  it('G07 a personal daily loss limit blocks new exposure once breached', async () => {
    await control('DAILY_LOSS_LIMIT', { valueMicros: 100 * 1_000_000 }); // $100
    await order('BUY', 1);
    await market.quote('NQ', 19_900, OPEN_MARKET_TS + 60_000);
    await order('SELL', 1); // realizes a loss far larger than $100
    expect(await expectReject('BUY', 1)).toBe('PERSONAL_DAILY_LOSS_LIMIT');
  });

  it('G08 a disabled control does not block (typing a value ≠ enabling)', async () => {
    await control('MAX_TRADES', { valueInt: 1 }, { enabled: false });
    await order('BUY', 1);
    await order('BUY', 1); // still allowed — control is OFF
    const day = await getDayState(fixture.db, fixture.accountId, ACCOUNT_TRADING_DATE);
    expect(day?.openingTradeCount).toBe(2);
  });

  it('G09 the gate never blocks the engine flattening a breach (liquidation)', async () => {
    await control('MAX_TRADES', { valueInt: 1 });
    await order('BUY', 1);
    // A liquidation flatten bypasses the personal gate (as it bypasses firm status).
    await engine.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(30);
    // No throw = allowed.
  });

  it('G10 counters persist across a fresh engine instance (restart)', async () => {
    await control('MAX_TRADES', { valueInt: 2 });
    await order('BUY', 1);
    // New engine over the same DB — the day-state is durable, not in-memory.
    const engine2 = new TradingEngine(fixture.db, market);
    await engine2.start();
    const day = await getDayState(fixture.db, fixture.accountId, ACCOUNT_TRADING_DATE);
    expect(day?.openingTradeCount).toBe(1);
  });
});
