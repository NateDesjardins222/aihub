/**
 * Contract identity survives persistence.
 *
 * A root ("NQ") and a tradable contract ("NQZ26") are different things, and the
 * difference must be legible after a fill is written - otherwise an NQZ26 fill
 * and an NQH27 fill become the same row. These tests prove the resolver is
 * deterministic and that a fill and a closed trade both record the specific
 * contract they happened in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { contractResolver } from '@atlas/instruments';
import { executions, trades } from '../db/schema.js';
import { TradingEngine } from './engine.js';
import { ScriptedMarket, createFixture, settle, OPEN_MARKET_TS, type TestFixture } from './harness.js';

describe('the contract resolver', () => {
  it('resolves a root and an instant to a specific tradable contract', () => {
    const c = contractResolver.resolveTradableContract({ root: 'NQ', timestamp: OPEN_MARKET_TS });
    expect(c.root).toBe('NQ');
    expect(c.code).toMatch(/^NQ[FGHJKMNQUVXZ]\d{2}$/);
    expect(c.contractMonth).toBeGreaterThanOrEqual(1);
    expect(c.contractMonth).toBeLessThanOrEqual(12);
    // Economics come through, so the contract is self-describing.
    expect(c.tickValueMicros).toBeGreaterThan(0);
    expect(c.contractMultiplier).toBeGreaterThan(0);
  });

  it('resolves different front months in different windows', () => {
    // Two instants a full quarter apart land on different NQ front months.
    const jan = contractResolver.contractCode('NQ', Date.UTC(2026, 0, 15));
    const oct = contractResolver.contractCode('NQ', Date.UTC(2026, 9, 15));
    expect(jan).not.toBeNull();
    expect(oct).not.toBeNull();
    expect(jan).not.toBe(oct);
  });

  it('is deterministic', () => {
    expect(contractResolver.contractCode('NQ', OPEN_MARKET_TS)).toBe(
      contractResolver.contractCode('NQ', OPEN_MARKET_TS),
    );
  });

  it('gives back null for an unknown root, never a wrong code', () => {
    expect(contractResolver.contractCode('NOPE', OPEN_MARKET_TS)).toBeNull();
  });

  it('names a continuous series that is not a tradable identity', () => {
    const s = contractResolver.resolveContinuousSeries('NQ');
    expect(s.seriesId).toBe('NQ.c.0');
    expect(s.depth).toBe(0);
  });

  it('maps a provider symbol', () => {
    const p = contractResolver.providerInstrument('yahoo', 'NQ', OPEN_MARKET_TS);
    expect(p.provider).toBe('yahoo');
    expect(p.root).toBe('NQ');
    expect(p.contractCode).toMatch(/^NQ[FGHJKMNQUVXZ]\d{2}$/);
  });
});

describe('contract identity in the persisted record', () => {
  let fixture: TestFixture;
  let market: ScriptedMarket;
  let engine: TradingEngine;

  beforeEach(async () => {
    fixture = await createFixture();
    market = new ScriptedMarket();
    engine = new TradingEngine(fixture.db, market);
    await engine.start();
    await market.quote('NQ', 20_000);
  });

  afterEach(async () => {
    engine?.stop();
    await fixture?.close();
  });

  it('stamps the tradable contract on a fill and on the closed trade', async () => {
    const expected = contractResolver.contractCode('NQ', OPEN_MARKET_TS);
    expect(expected).not.toBeNull();

    // Open and then close, so both an execution and a trade are written.
    await engine.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: `ci-open-${Date.now()}`,
      symbol: 'NQ',
      side: 'BUY',
      qty: 1,
      type: 'MARKET',
    });
    await settle(300);
    await engine.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: `ci-close-${Date.now()}`,
      symbol: 'NQ',
      side: 'SELL',
      qty: 1,
      type: 'MARKET',
    });
    await settle(300);

    const fills = await fixture.db
      .select()
      .from(executions)
      .where(eq(executions.accountId, fixture.accountId));
    expect(fills.length).toBeGreaterThanOrEqual(2);
    for (const fill of fills) {
      expect(fill.contractCode).toBe(expected);
      // The root is still there for convenient querying; the contract is extra.
      expect(fill.symbol).toBe('NQ');
    }

    const closed = await fixture.db
      .select()
      .from(trades)
      .where(and(eq(trades.accountId, fixture.accountId)));
    expect(closed.length).toBeGreaterThanOrEqual(1);
    for (const trade of closed) {
      expect(trade.contractCode).toBe(expected);
    }
  });
});
