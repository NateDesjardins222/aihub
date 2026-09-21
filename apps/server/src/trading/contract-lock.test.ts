/**
 * The open-position contract lock (Professional Market Data V2, Phase 17).
 *
 * A futures position belongs to the specific contract it was opened in. When the
 * root's front month rolls, the root-keyed live feed becomes a DIFFERENT
 * contract; an open position must never be silently re-marked by it. Here the
 * position's stored contract_code and the engine's marking guard are proven,
 * and — critically — the owner projection is proven to agree with the engine to
 * the micro-dollar in BOTH the marked and the locked-unknown cases, so the
 * 338f832 owner==trader invariant survives contract identity.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { contractResolver } from '@atlas/instruments';
import { positions } from '../db/schema.js';
import { TradingEngine } from './engine.js';
import { ScriptedMarket, createFixture, settle, OPEN_MARKET_TS, type TestFixture } from './harness.js';
import { projectAccount, readAccountProjection } from '../platform/projection.js';

describe('the open-position contract lock', () => {
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

  async function openTwoLots(): Promise<void> {
    await engine.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: `lock-${Date.now()}`,
      symbol: 'NQ',
      side: 'BUY',
      qty: 2,
      type: 'MARKET',
    });
    await settle(300);
  }

  it('stamps the actual contract the position opened in', async () => {
    await openTwoLots();
    const [row] = await fixture.db.select().from(positions).where(eq(positions.accountId, fixture.accountId));
    // The scripted market's quotes carry OPEN_MARKET_TS, so the fill resolves
    // to the front month at that instant.
    expect(row!.contractCode).toBe(contractResolver.contractCode('NQ', OPEN_MARKET_TS));
    expect(row!.contractCode).not.toBeNull();
  });

  it('marks a position on its own contract, and owner agrees with trader', async () => {
    await openTwoLots();
    await market.quote('NQ', 20_050);
    await projectAccount(fixture.db, fixture.accountId);

    const fromEngine = await engine.valuation(fixture.accountId);
    const fromProjection = await readAccountProjection(fixture.db, market, fixture.accountId);
    expect(fromEngine!.openPnlMicros).not.toBeNull();
    expect(fromProjection!.unrealizedPnlMicros).toBe(fromEngine!.openPnlMicros);
    expect(fromProjection!.equityMicros).toBe(fromEngine!.equityMicros);
  });

  it('locks to its contract after a roll: unknown, never the new mark, never silently closed', async () => {
    await openTwoLots();
    // Simulate the front month having rolled past this position: its stored
    // contract is now different from what the root feed currently represents.
    await fixture.db
      .update(positions)
      .set({ contractCode: 'NQH99' })
      .where(eq(positions.accountId, fixture.accountId));
    await market.quote('NQ', 20_050);
    await projectAccount(fixture.db, fixture.accountId);

    const fromEngine = await engine.valuation(fixture.accountId);
    // The position is still held (never silently rolled or closed)...
    expect(fromEngine!.openContracts).toBe(2);
    // ...but it reads UNKNOWN rather than being marked by the new contract.
    expect(fromEngine!.openPnlMicros).toBeNull();
    expect(fromEngine!.equityMicros).toBeNull();

    const fromProjection = await readAccountProjection(fixture.db, market, fixture.accountId);
    // Owner agrees: unknown stays unknown on both sides, never a fabricated zero.
    expect(fromProjection!.openContracts).toBe(2);
    expect(fromProjection!.unrealizedPnlMicros).toBeNull();
    expect(fromProjection!.equityMicros).toBeNull();
  });
});
