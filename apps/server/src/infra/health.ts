/**
 * Provider health + infrastructure posture service (M4-T).
 *
 * ONE read-only, REDACTED view of the production-infrastructure posture for the
 * owner console: which market-data and execution providers exist, their config
 * and connection health, and the server-side posture (default execution mode,
 * the EXTERNAL_LIVE master gate, the market-data redistribution declaration,
 * the Rithmic configuration state). It NEVER exposes a credential, and it is
 * assembled from the running providers and env — never from the browser.
 *
 * Invariants surfaced here (not merely described):
 *  - Default execution mode is SIMULATION; the browser can never change it.
 *  - An unconfigured professional provider reports UNCONFIGURED, not CONNECTED.
 *  - EXTERNAL_LIVE is gated off unless the server explicitly enables it.
 */
import type {
  DataMode,
  ExecutionProviderKind,
  MarketDataProviderKind,
  ProviderConfigState,
  ProviderHealthSnapshot,
  ProviderHealthState,
} from '@atlas/contracts';
import type { ConnectionState, ConnectionStatus, FeedMode } from '@atlas/contracts';
import { env } from '../config/env.js';
import { rithmicConfigState, redactedRithmicDescription } from './rithmic-config.js';
import { rithmicMetrics } from '../rithmic/metrics.js';
import { hostOf } from '../rithmic/plants/connection-manager.js';
import type { ExecutionRegistry } from '../execution/registry.js';
import type { MarketDataService } from '../marketdata/service.js';

/** The server-side infrastructure posture — a compliance/ops statement. */
export interface InfraPosture {
  /** The configured DEFAULT execution provider kind (server-side selection). */
  readonly configuredExecutionProvider: ExecutionProviderKind;
  /** The default execution MODE for every account. Always SIMULATION in M4. */
  readonly defaultExecutionMode: 'SIMULATION';
  /** The EXTERNAL_LIVE master gate. Ships false. */
  readonly externalLiveEnabled: boolean;
  /** The configured market-data provider kind. */
  readonly marketDataProvider: MarketDataProviderKind | string;
  /** Declared redistribution posture (compliance statement, not a capability). */
  readonly marketDataRedistribution: string;
  /** Rithmic configuration state + a REDACTED description (never a credential). */
  readonly rithmic: {
    readonly configState: ProviderConfigState;
    readonly description: string;
    /** M9 wire-integration posture (all redacted; never a secret). */
    readonly enabled: boolean;
    readonly environment: string;
    readonly systemName: string | null;
    readonly endpointHost: string | null;
    readonly marketDataEnabled: boolean;
    readonly executionEnabled: boolean;
    /** Bounded-cardinality provider metrics for observability. */
    readonly metrics: Record<string, number | null>;
  };
}

export interface InfraHealthSnapshot {
  readonly generatedAt: number;
  readonly posture: InfraPosture;
  /** Redacted health of every registered provider (market data + execution). */
  readonly providers: readonly ProviderHealthSnapshot[];
}

/** Map a market-data ConnectionState to the coarse shared ProviderHealthState. */
function healthFromConnectionState(state: ConnectionState): ProviderHealthState {
  switch (state) {
    case 'CONNECTED':
      return 'CONNECTED';
    case 'CONNECTING':
      return 'CONNECTING';
    case 'RECONNECTING':
      return 'DEGRADED';
    case 'ERROR':
      return 'ERROR';
    case 'DISCONNECTED':
    default:
      return 'DISCONNECTED';
  }
}

/** How a running feed relates to the live market, for the data-mode indicator. */
export function dataModeFromFeed(mode: FeedMode, state: ConnectionState): DataMode {
  if (state === 'DISCONNECTED' || state === 'ERROR') return 'DISCONNECTED';
  switch (mode) {
    case 'REALTIME':
      return 'REALTIME';
    case 'DELAYED':
      return 'DELAYED';
    case 'REPLAY':
      return 'REPLAY';
    default:
      return 'DISCONNECTED';
  }
}

/**
 * A redacted health snapshot for the running market-data provider. The provider
 * id and feed mode are safe; there are no credentials to leak here, but we build
 * this from the provider's public status rather than any config.
 */
export function marketDataHealthSnapshot(service: MarketDataService): ProviderHealthSnapshot {
  const status: ConnectionStatus = service.currentProvider.getConnectionStatus();
  const kind = env().MARKET_DATA_PROVIDER;
  const configState: ProviderConfigState = (() => {
    const p = service.currentProvider as Partial<{ configState: () => ProviderConfigState }>;
    return p.configState?.() ?? 'CONFIGURED';
  })();
  return {
    providerId: status.providerId,
    role: 'MARKET_DATA',
    kind,
    configState,
    health: healthFromConnectionState(status.state),
    isSimulation: false,
    detail: `${service.currentProvider.mode} feed; declared delay ${status.declaredDelaySeconds}s`,
    lastConnectAt: null,
    lastDisconnectAt: null,
    lastMessageAt: status.lastMessageAt,
    lastHeartbeatAt: null,
    reconnectCount: status.reconnectAttempts,
    subscriptionCount: 0,
    lastError: status.error ?? null,
  };
}

/**
 * Assemble the full, redacted infrastructure health snapshot. Pure given its
 * inputs: the execution registry and (optionally) the market-data service.
 */
export function buildInfraHealth(deps: {
  readonly registry: ExecutionRegistry;
  readonly market?: MarketDataService | null;
}): InfraHealthSnapshot {
  const e = env();
  const providers: ProviderHealthSnapshot[] = [];
  if (deps.market) providers.push(marketDataHealthSnapshot(deps.market));
  providers.push(...deps.registry.healthSnapshots());

  return {
    generatedAt: Date.now(),
    posture: {
      configuredExecutionProvider: deps.registry.configuredKind(),
      defaultExecutionMode: 'SIMULATION',
      externalLiveEnabled: e.EXTERNAL_LIVE_ENABLED,
      marketDataProvider: e.MARKET_DATA_PROVIDER,
      marketDataRedistribution: e.MARKET_DATA_REDISTRIBUTION,
      rithmic: {
        configState: rithmicConfigState(),
        description: redactedRithmicDescription(),
        enabled: e.RITHMIC_ENABLED === true,
        environment: e.RITHMIC_ENVIRONMENT,
        systemName: e.RITHMIC_SYSTEM_NAME ?? e.RITHMIC_SYSTEM ?? null,
        endpointHost: e.RITHMIC_ENDPOINT ? hostOf(e.RITHMIC_ENDPOINT) : null,
        marketDataEnabled: e.RITHMIC_MARKET_DATA_ENABLED === true,
        executionEnabled: e.RITHMIC_EXECUTION_ENABLED === true,
        metrics: rithmicMetrics.snapshot(),
      },
    },
    providers,
  };
}
