/**
 * Provider health + infra posture service (M4-T) + credential redaction (M4-AA).
 * Pure/deterministic; no DB, no network. Rithmic env is set BEFORE the cached
 * env() is first read, so a "configured" Rithmic is exercised without a real
 * connection — and we assert no secret ever reaches the snapshot.
 */
process.env['RITHMIC_ENV'] = 'paper';
process.env['RITHMIC_GATEWAY'] = 'test.gateway.example';
process.env['RITHMIC_SYSTEM'] = 'Rithmic Paper Trading';
process.env['RITHMIC_USER'] = 'atlas-secret-user';
process.env['RITHMIC_PASSWORD'] = 'atlas-super-secret-password';
process.env['RITHMIC_FCM_ID'] = 'FCM-SECRET';
process.env['RITHMIC_IB_ID'] = 'IB-SECRET';

import { describe, expect, it } from 'vitest';
import { buildInfraHealth } from './health.js';
import { ExecutionRegistry } from '../execution/registry.js';
import { RithmicExecutionProvider } from '../execution/providers/rithmic-execution.js';
import type { ExecutionProvider } from '../execution/provider.js';
import type { ExecutionProviderKind } from '@atlas/contracts';
import type { ExternalExecutionAdapter } from '../execution/external-provider.js';

const SECRETS = ['atlas-secret-user', 'atlas-super-secret-password', 'FCM-SECRET', 'IB-SECRET'];

const sim = {
  id: 'atlas-sim',
  capabilities: () => ({ isSimulation: true }),
  status: () => ({ providerId: 'atlas-sim', health: 'HEALTHY', isSimulation: true, detail: 'sim' }),
} as unknown as ExecutionProvider;

describe('buildInfraHealth (M4-T)', () => {
  it('reports SIMULATION-first posture and never leaks a credential', () => {
    const adapters = new Map<ExecutionProviderKind, ExternalExecutionAdapter>([
      ['rithmic', new RithmicExecutionProvider()],
    ]);
    const health = buildInfraHealth({ registry: new ExecutionRegistry(sim, adapters), market: null });

    // Posture: simulation is the default; live is gated off.
    expect(health.posture.defaultExecutionMode).toBe('SIMULATION');
    expect(health.posture.externalLiveEnabled).toBe(false);
    // Rithmic is CONFIGURED here (env set) but the description is redacted.
    expect(health.posture.rithmic.configState).toBe('CONFIGURED');

    // The simulation provider is present and marked as simulation.
    expect(health.providers.some((p) => p.isSimulation && p.role === 'EXECUTION')).toBe(true);
    // Rithmic is present and NOT connected (no dev kit) — never a faked CONNECTED.
    const rithmic = health.providers.find((p) => p.kind === 'rithmic');
    expect(rithmic).toBeDefined();
    expect(rithmic!.health).not.toBe('CONNECTED');

    // No secret appears anywhere in the serialized snapshot.
    const blob = JSON.stringify(health);
    for (const secret of SECRETS) expect(blob).not.toContain(secret);
  });
});
