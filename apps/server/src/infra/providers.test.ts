/**
 * Provider scaffolds + test doubles + execution registry (M4-D/F/W) and
 * credential redaction (M4-AA slice). Pure/deterministic; no network, no DB.
 *
 * Rithmic env is set at module load, BEFORE anything calls the cached env(), so
 * the redaction assertions exercise a "configured" Rithmic without a real
 * connection ever being made.
 */
process.env['RITHMIC_ENV'] = 'paper';
process.env['RITHMIC_GATEWAY'] = 'test.gateway.example';
process.env['RITHMIC_SYSTEM'] = 'Rithmic Paper Trading';
process.env['RITHMIC_USER'] = 'atlas-secret-user';
process.env['RITHMIC_PASSWORD'] = 'atlas-super-secret-password';
process.env['RITHMIC_FCM_ID'] = 'FCM-SECRET';
process.env['RITHMIC_IB_ID'] = 'IB-SECRET';

import { describe, expect, it } from 'vitest';
import { RithmicMarketDataProvider } from '../marketdata/providers/rithmic.js';
import { ScriptedMarketDataProvider } from '../marketdata/providers/scripted.js';
import { RithmicExecutionProvider } from '../execution/providers/rithmic-execution.js';
import { ScriptedExecutionProvider } from '../execution/providers/scripted-execution.js';
import { ExternalExecutionError } from '../execution/external-provider.js';
import { ExecutionRegistry } from '../execution/registry.js';
import type { ExternalExecutionAdapter } from '../execution/external-provider.js';
import type { ExecutionProviderKind } from '@atlas/contracts';
import { redactedRithmicDescription } from './rithmic-config.js';
import type { ExecutionProvider } from '../execution/provider.js';

const SECRETS = ['atlas-secret-user', 'atlas-super-secret-password', 'FCM-SECRET', 'IB-SECRET'];

function noSecret(s: string): void {
  for (const secret of SECRETS) expect(s).not.toContain(secret);
}

describe('Rithmic market-data scaffold (M4-D)', () => {
  it('is configured here but refuses to connect (no dev kit) — never fakes CONNECTED', async () => {
    const p = new RithmicMarketDataProvider();
    expect(p.configState()).toBe('CONFIGURED');
    await expect(p.connect()).rejects.toThrow();
    const st = p.getConnectionStatus();
    expect(st.state).not.toBe('CONNECTED');
    expect(p.getQuote('NQ')).toBeNull();
    noSecret(st.error ?? '');
  });
});

describe('Rithmic execution scaffold (M4-D)', () => {
  it('refuses to connect and every op throws a structured error — no secret leak', async () => {
    const p = new RithmicExecutionProvider();
    await expect(p.connect()).rejects.toBeInstanceOf(ExternalExecutionError);
    await expect(
      p.submit({
        atlasOrderId: 'a1', clientOrderId: 'c1', providerAccountId: 'pa', symbol: 'NQ',
        contractCode: null, side: 'BUY', qty: 1, type: 'MARKET',
      }),
    ).rejects.toBeInstanceOf(ExternalExecutionError);
    const snap = p.healthSnapshot();
    expect(snap.isSimulation).toBe(false);
    noSecret(snap.detail);
    noSecret(snap.lastError ?? '');
    noSecret(redactedRithmicDescription());
    expect(redactedRithmicDescription()).toContain('credentials=present');
  });
});

describe('Scripted market-data double (M4-W)', () => {
  it('connects, emits pushed quotes, and reports RECONNECTING on a drop', async () => {
    const p = new ScriptedMarketDataProvider();
    const events: string[] = [];
    p.on((e) => events.push(e.kind));
    await p.connect();
    expect(p.getConnectionStatus().state).toBe('CONNECTED');
    p.pushQuote({ symbol: 'NQ', exchangeTs: 1000, bid: 1, bidSize: 1, ask: 2, askSize: 1, last: 1.5, lastSize: 1, seq: 1, synthesizedBook: false });
    expect(p.getQuote('NQ')?.last).toBe(1.5);
    expect(events).toContain('quote');
    p.drop();
    expect(p.getConnectionStatus().state).toBe('RECONNECTING');
  });
});

describe('Scripted execution double (M4-W)', () => {
  it('acks + fills, is idempotent, rejects, and supports lost-ack + reconciliation', async () => {
    const p = new ScriptedExecutionProvider();
    await p.connect();
    const reports: string[] = [];
    p.onReport((r) => reports.push(r.state));

    // fill now
    p.program({ fillNowQty: 2, fillPrice: 20000 });
    const ack = await p.submit({ atlasOrderId: 'a1', clientOrderId: 'c1', providerAccountId: 'pa', symbol: 'NQ', contractCode: 'NQZ26', side: 'BUY', qty: 2, type: 'MARKET' });
    expect(ack.accepted).toBe(true);
    expect(reports).toContain('FILLED');

    // idempotent replay: same clientOrderId → same providerOrderId, no new order
    const ack2 = await p.submit({ atlasOrderId: 'a1', clientOrderId: 'c1', providerAccountId: 'pa', symbol: 'NQ', contractCode: 'NQZ26', side: 'BUY', qty: 2, type: 'MARKET' });
    expect(ack2.providerOrderId).toBe(ack.providerOrderId);

    // reject
    p.program({ reject: true });
    const rej = await p.submit({ atlasOrderId: 'a2', clientOrderId: 'c2', providerAccountId: 'pa', symbol: 'NQ', contractCode: 'NQZ26', side: 'SELL', qty: 1, type: 'MARKET' });
    expect(rej.accepted).toBe(false);
    expect(rej.state).toBe('REJECTED');

    // lost ack: accepted, but NO report — Atlas must reconcile
    const before = reports.length;
    p.program({ lostAck: true });
    const lost = await p.submit({ atlasOrderId: 'a3', clientOrderId: 'c3', providerAccountId: 'pa', symbol: 'NQ', contractCode: 'NQZ26', side: 'BUY', qty: 1, type: 'MARKET' });
    expect(lost.accepted).toBe(true);
    expect(reports.length).toBe(before);
    const working = await p.listWorkingOrders();
    expect(working.some((o) => o.providerOrderId === lost.providerOrderId)).toBe(true);
  });
});

describe('ExecutionRegistry routing + readiness (M4-F)', () => {
  const sim: ExecutionProvider = {
    id: 'atlas-sim',
    capabilities: () => ({ isSimulation: true, supportsMarketOrders: true, supportsLimitOrders: true, supportsStopOrders: true, supportsTrailingStops: true, supportsBrackets: true, supportsModify: true, supportsFlatten: true, supportsReverse: true }),
    status: () => ({ providerId: 'atlas-sim', health: 'HEALTHY', isSimulation: true, detail: 'sim' }),
  } as unknown as ExecutionProvider;

  it('routes SIMULATION as always-ready and reports external readiness honestly', async () => {
    const scripted = new ScriptedExecutionProvider();
    const rithmic = new RithmicExecutionProvider();
    const adapters = new Map<ExecutionProviderKind, ExternalExecutionAdapter>([
      ['scripted', scripted],
      ['rithmic', rithmic],
    ]);
    const reg = new ExecutionRegistry(sim, adapters);

    expect(reg.configuredKind()).toBe('simulation');
    expect(reg.externalReadiness('SIMULATION', 'simulation').ready).toBe(true);

    // Rithmic is configured-but-not-connected here → not ready.
    expect(reg.externalReadiness('EXTERNAL_PAPER', 'rithmic').ready).toBe(false);

    // Scripted disconnected → not ready; connected → ready for paper.
    expect(reg.externalReadiness('EXTERNAL_PAPER', 'scripted').ready).toBe(false);
    await scripted.connect();
    expect(reg.externalReadiness('EXTERNAL_PAPER', 'scripted').ready).toBe(true);

    // EXTERNAL_LIVE is gated off by config even when the provider is connected.
    expect(reg.externalReadiness('EXTERNAL_LIVE', 'scripted').ready).toBe(false);
    expect(reg.externalReadiness('EXTERNAL_LIVE', 'scripted').reason).toMatch(/disabled/i);

    const snaps = reg.healthSnapshots();
    expect(snaps.some((s) => s.isSimulation)).toBe(true);
    for (const s of snaps) noSecret(s.detail);
  });
});
