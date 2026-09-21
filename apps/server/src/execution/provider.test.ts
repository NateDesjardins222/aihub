/**
 * The simulator satisfies the execution-provider contract.
 *
 * If the Atlas engine maps cleanly onto the provider-neutral interface, then a
 * future Rithmic/CQG adapter has a definite shape to meet and the call sites do
 * not change. This proves the mapping against real engine behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TradingEngine } from '../trading/engine.js';
import { ScriptedMarket, createFixture, settle, type TestFixture } from '../trading/harness.js';
import { AtlasSimulationExecutionProvider, type ExecutionProvider } from './provider.js';

describe('AtlasSimulationExecutionProvider', () => {
  let fixture: TestFixture;
  let market: ScriptedMarket;
  let engine: TradingEngine;
  let provider: ExecutionProvider;

  beforeEach(async () => {
    fixture = await createFixture();
    market = new ScriptedMarket();
    engine = new TradingEngine(fixture.db, market);
    await engine.start();
    await market.quote('NQ', 20_000);
    provider = new AtlasSimulationExecutionProvider(engine);
  });

  afterEach(async () => {
    engine?.stop();
    await fixture?.close();
  });

  it('reports itself as a healthy simulation with full capabilities', () => {
    expect(provider.id).toBe('atlas-sim');
    const caps = provider.capabilities();
    expect(caps.isSimulation).toBe(true);
    expect(caps.supportsBrackets).toBe(true);
    expect(caps.supportsReverse).toBe(true);
    const status = provider.status();
    expect(status.health).toBe('HEALTHY');
    expect(status.isSimulation).toBe(true);
  });

  it('submits an order and returns the authoritative post-change view', async () => {
    const change = await provider.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: `exec-${Date.now()}`,
      symbol: 'NQ',
      side: 'BUY',
      qty: 1,
      type: 'MARKET',
    });
    expect(change.accountId).toBe(fixture.accountId);
    await settle(300);

    const state = await provider.getAccountState(fixture.accountId);
    expect(state).not.toBeNull();
    expect(state!.accountId).toBe(fixture.accountId);
    // A position exists after the market order filled.
    expect(state!.openContracts).toBeGreaterThan(0);
  });

  it('flattens through the same seam', async () => {
    await provider.submitOrder({
      accountId: fixture.accountId,
      userId: fixture.userId,
      clientOrderId: `exec-open-${Date.now()}`,
      symbol: 'NQ',
      side: 'BUY',
      qty: 1,
      type: 'MARKET',
    });
    await settle(300);
    await provider.flatten(fixture.accountId, fixture.userId, 'NQ');
    await settle(300);
    const state = await provider.getAccountState(fixture.accountId);
    expect(state!.openContracts).toBe(0);
  });
});
