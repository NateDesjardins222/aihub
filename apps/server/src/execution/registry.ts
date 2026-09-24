/**
 * Execution provider registry + routing (M4-F).
 *
 * ONE place decides which execution provider serves an account, by execution
 * MODE — server-side, never from the browser. The default and the only reachable
 * mode in this milestone is SIMULATION → the Atlas engine. EXTERNAL_* routes to
 * an external adapter and is only reachable when that adapter is configured AND
 * connected AND the master EXTERNAL_LIVE gate permits it (for live).
 *
 * Copy trading is unaffected: it operates on Atlas account ids and asks the
 * registry for each account's provider; the provider behind an account may differ
 * in future without a separate copy-trading execution path.
 */
import type {
  ExecutionMode,
  ExecutionProviderKind,
  ProviderHealthSnapshot,
} from '@atlas/contracts';
import { env } from '../config/env.js';
import type { ExecutionProvider } from './provider.js';
import type { ExternalExecutionAdapter } from './external-provider.js';

export class ExecutionUnavailableError extends Error {
  constructor(
    readonly reason: string,
    readonly mode: ExecutionMode,
  ) {
    super(reason);
    this.name = 'ExecutionUnavailableError';
  }
}

export class ExecutionRegistry {
  constructor(
    private readonly simulation: ExecutionProvider,
    private readonly external: ReadonlyMap<ExecutionProviderKind, ExternalExecutionAdapter> = new Map(),
  ) {}

  /** The configured default execution provider kind (server-side selection). */
  configuredKind(): ExecutionProviderKind {
    return env().EXECUTION_PROVIDER;
  }

  /** The engine-shaped provider for an account's SIMULATION path. Always available. */
  simulationProvider(): ExecutionProvider {
    return this.simulation;
  }

  /**
   * Whether an external order could be sent under a mode right now. This is a
   * provider-availability check ONLY — the full authorization (ownership,
   * lifecycle, mapping, risk, freshness, session, idempotency) is the external
   * execution safety gate's job. SIMULATION is always available.
   */
  externalReadiness(mode: ExecutionMode, kind: ExecutionProviderKind): {
    ready: boolean;
    reason: string;
  } {
    if (mode === 'SIMULATION') return { ready: true, reason: 'simulation' };
    const adapter = this.external.get(kind);
    if (!adapter) return { ready: false, reason: `no ${kind} execution adapter registered` };
    if (adapter.configState() === 'UNCONFIGURED') {
      return { ready: false, reason: `${kind} execution provider is UNCONFIGURED` };
    }
    if (adapter.health() !== 'CONNECTED') {
      return { ready: false, reason: `${kind} execution provider is ${adapter.health()}` };
    }
    if (mode === 'EXTERNAL_LIVE' && !env().EXTERNAL_LIVE_ENABLED) {
      return { ready: false, reason: 'EXTERNAL_LIVE is disabled by server configuration' };
    }
    return { ready: true, reason: 'ready' };
  }

  /** The external adapter for a kind, or null. */
  externalAdapter(kind: ExecutionProviderKind): ExternalExecutionAdapter | null {
    return this.external.get(kind) ?? null;
  }

  /** Redacted health of every registered execution provider, for owner/ops. */
  healthSnapshots(): ProviderHealthSnapshot[] {
    const simStatus = this.simulation.status();
    const sim: ProviderHealthSnapshot = {
      providerId: this.simulation.id,
      role: 'EXECUTION',
      kind: 'simulation',
      configState: 'CONFIGURED',
      health: simStatus.health === 'HEALTHY' ? 'CONNECTED' : simStatus.health === 'DEGRADED' ? 'DEGRADED' : 'DISCONNECTED',
      isSimulation: true,
      detail: simStatus.detail,
      lastConnectAt: null,
      lastDisconnectAt: null,
      lastMessageAt: null,
      lastHeartbeatAt: null,
      reconnectCount: 0,
      subscriptionCount: 0,
      lastError: null,
    };
    return [sim, ...[...this.external.values()].map((a) => a.healthSnapshot())];
  }
}
