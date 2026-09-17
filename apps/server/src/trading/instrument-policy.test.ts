/**
 * What an account is permitted to trade, and when.
 *
 * The product says which instruments an account may trade and how many
 * contracts of each; the administrative statuses say whether it may trade at
 * all. Both are enforced by the same gate every order already passes through,
 * against a real database and a real engine - a client cannot reach around
 * either of them because neither is expressed in the client.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accounts, positions as positionsTable } from '../db/schema.js';
import { OrderRejectedError, TradingEngine } from './engine.js';
import {
  OPEN_MARKET_TS,
  ScriptedMarket,
  createFixture,
  settle,
  type TestFixture,
} from './harness.js';

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
  fixture = await createFixture({ environment: CLEAN_ENV, ...overrides });
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
  await market.quote('NQ', 20_000, OPEN_MARKET_TS);
  await market.quote('ES', 5_000, OPEN_MARKET_TS);
  await settle();
}

async function buy(symbol: string, qty: number): Promise<void> {
  seq += 1;
  await engine.submitOrder({
    accountId: fixture.accountId,
    userId: fixture.userId,
    clientOrderId: `policy-${seq}`,
    symbol,
    side: 'BUY',
    qty,
    type: 'MARKET',
  });
}

async function rejection(run: () => Promise<unknown>): Promise<OrderRejectedError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof OrderRejectedError) return err;
    throw err;
  }
  throw new Error('expected the order to be rejected');
}

afterEach(async () => {
  engine.stop();
  await fixture.close();
});

describe('permitted instruments', () => {
  beforeEach(async () => {
    await setup({ instrumentLimits: { allowed: ['ES'], maxContracts: null, perInstrument: {} } });
  });

  it('refuses an instrument the product does not include', async () => {
    const error = await rejection(() => buy('NQ', 1));
    expect(error.reason).toBe('INSTRUMENT_NOT_PERMITTED');
    expect(error.message).toContain('NQ');
  });

  it('allows one that it does', async () => {
    await buy('ES', 1);
    await settle();
    expect(await engine.openExposure(fixture.accountId)).toBe(true);
  });
});

describe('per-instrument sizing', () => {
  beforeEach(async () => {
    // The programme allows fifteen contracts; this product allows two of NQ.
    await setup({
      rules: { maxContracts: 15 },
      instrumentLimits: { allowed: null, maxContracts: null, perInstrument: { NQ: 2 } },
    });
  });

  it('caps the instrument below the account-wide limit', async () => {
    await buy('NQ', 2);
    await settle();
    const error = await rejection(() => buy('NQ', 1));
    expect(error.reason).toBe('MAX_CONTRACTS_EXCEEDED');
    expect(error.message).toContain('NQ');
  });

  it('leaves another instrument on the account-wide limit', async () => {
    await buy('NQ', 2);
    await settle();
    // Three of ES is over the NQ cap but well inside the programme's fifteen,
    // and the per-instrument cap must not leak across instruments.
    await buy('ES', 3);
    await settle();

    const held = await fixture.db
      .select()
      .from(positionsTable)
      .where(eq(positionsTable.accountId, fixture.accountId));
    const es = held.find((row) => row.symbol === 'ES');
    const nq = held.find((row) => row.symbol === 'NQ');
    expect(es?.qty).toBe(3);
    expect(nq?.qty).toBe(2);
  });

  it('never stops a trader closing what they already hold', async () => {
    await buy('NQ', 2);
    await settle();
    seq += 1;
    await engine.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: `policy-close-${seq}`,
      symbol: 'NQ',
      side: 'SELL',
      qty: 2,
      type: 'MARKET',
    });
    await settle();
    expect(await engine.openExposure(fixture.accountId)).toBe(false);
  });
});

describe('administrative statuses', () => {
  it('refuses an account that has not been activated', async () => {
    await setup({ status: 'PENDING' });
    const error = await rejection(() => buy('NQ', 1));
    expect(error.reason).toBe('ACCOUNT_PENDING');
  });

  it('refuses a disabled account', async () => {
    await setup({ status: 'DISABLED' });
    const error = await rejection(() => buy('NQ', 1));
    expect(error.reason).toBe('ACCOUNT_DISABLED');
  });

  it('refuses an archived account', async () => {
    await setup({ status: 'ARCHIVED' });
    const error = await rejection(() => buy('NQ', 1));
    expect(error.reason).toBe('ACCOUNT_ARCHIVED');
  });

  it('still lets the engine flatten what a disabled account was left holding', async () => {
    await setup();
    await buy('NQ', 1);
    await settle();
    // Disabled with a position open, which is exactly what an administrator
    // disabling a live account produces.
    await fixture.db
      .update(accounts)
      .set({ status: 'DISABLED' })
      .where(eq(accounts.id, fixture.accountId));

    // A liquidation is the engine closing exposure, and it is exempt from the
    // status gate - otherwise a disabled account could never be flattened.
    seq += 1;
    await engine.submitOrder({
      accountId: fixture.accountId,
      userId: null,
      clientOrderId: `policy-liquidate-${seq}`,
      symbol: 'NQ',
      side: 'SELL',
      qty: 1,
      type: 'MARKET',
      liquidation: true,
    });
    await settle();
    expect(await engine.openExposure(fixture.accountId)).toBe(false);
  });
});
