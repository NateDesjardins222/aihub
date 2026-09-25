/**
 * Rithmic connection manager (Milestone 9).
 *
 * Owns the distinct plant connections (TICKER / ORDER / HISTORY / PNL /
 * REPOSITORY) for one authenticated Rithmic environment, plus discovery. It never
 * conflates plants and never exposes a credential in any snapshot. Reconnect,
 * heartbeat and subscription-restore live in each plant; this coordinates them and
 * presents a single redacted health view for owner/ops surfaces.
 */
import { rithmicCodec, type RithmicCodec } from '../protocol/codec.js';
import { RithmicPlant, type PlantKind, type PlantState, type PlantMetrics } from './plant.js';
import { RithmicSystemDiscoveryService } from './discovery.js';
import type { TransportFactory } from '../transport/transport.js';
import type { BackoffPolicy } from '../../infra/connection-lifecycle.js';

export interface ConnectionManagerConfig {
  readonly endpoint: string;
  readonly systemName: string;
  readonly login: { user: string; password: string; appName: string; appVersion: string };
  /** Which plants to bring up. Discovery is always used first. */
  readonly plants: readonly Exclude<PlantKind, 'DISCOVERY'>[];
  readonly transportFactory: TransportFactory;
  readonly codec?: RithmicCodec;
  readonly backoff?: BackoffPolicy;
  readonly now?: () => number;
  readonly scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
  };
  /** Per-plant post-auth hook (restore subscriptions, reconcile). */
  readonly onPlantAuthenticated?: (kind: PlantKind, plant: RithmicPlant) => void | Promise<void>;
}

export interface PlantHealth {
  readonly kind: PlantKind;
  readonly state: PlantState;
  readonly healthy: boolean;
  readonly metrics: Readonly<PlantMetrics>;
}

export interface ConnectionHealth {
  readonly environment: string;
  readonly systemName: string;
  /** Endpoint HOST only — never the full URL with any query. */
  readonly endpointHost: string;
  readonly discoveredSystems: readonly string[];
  readonly plants: readonly PlantHealth[];
}

export class RithmicConnectionManager {
  private readonly codec: RithmicCodec;
  private readonly discovery: RithmicSystemDiscoveryService;
  private readonly plants = new Map<PlantKind, RithmicPlant>();
  private discoveredSystems: readonly string[] = [];
  private started = false;

  constructor(private readonly config: ConnectionManagerConfig, private readonly environment = 'TEST') {
    this.codec = config.codec ?? rithmicCodec();
    this.discovery = new RithmicSystemDiscoveryService({
      url: config.endpoint,
      transportFactory: config.transportFactory,
      codec: this.codec,
      ...(config.now ? { now: config.now } : {}),
      ...(config.scheduler ? { scheduler: config.scheduler } : {}),
    });
  }

  /** Discover systems, verify the configured one exists, then bring up each plant. */
  async start(): Promise<void> {
    if (this.started) return;
    const result = await this.discovery.verifySystem(this.config.systemName);
    this.discoveredSystems = result.systems;
    for (const kind of this.config.plants) {
      const plant = new RithmicPlant({
        kind,
        url: this.config.endpoint,
        login: {
          user: this.config.login.user,
          password: this.config.login.password,
          systemName: this.config.systemName,
          appName: this.config.login.appName,
          appVersion: this.config.login.appVersion,
        },
        transportFactory: this.config.transportFactory,
        codec: this.codec,
        ...(this.config.backoff ? { backoff: this.config.backoff } : {}),
        ...(this.config.now ? { now: this.config.now } : {}),
        ...(this.config.scheduler ? { scheduler: this.config.scheduler } : {}),
        onAuthenticated: (p) => this.config.onPlantAuthenticated?.(kind, p),
      });
      this.plants.set(kind, plant);
    }
    await Promise.all([...this.plants.values()].map((p) => p.start()));
    this.started = true;
  }

  plant(kind: PlantKind): RithmicPlant | undefined {
    return this.plants.get(kind);
  }

  /** True only when every configured plant is authenticated AND live. */
  allHealthy(): boolean {
    if (this.plants.size === 0) return false;
    return [...this.plants.values()].every((p) => p.isHealthy());
  }

  health(): ConnectionHealth {
    return {
      environment: this.environment,
      systemName: this.config.systemName,
      endpointHost: hostOf(this.config.endpoint),
      discoveredSystems: this.discoveredSystems,
      plants: [...this.plants.entries()].map(([kind, p]) => ({
        kind,
        state: p.getState(),
        healthy: p.isHealthy(),
        metrics: p.getMetrics(),
      })),
    };
  }

  stop(): void {
    for (const p of this.plants.values()) p.stop();
    this.plants.clear();
    this.started = false;
  }
}

/** Extract just the host:port from a ws URL, dropping scheme, credentials and path. */
export function hostOf(url: string): string {
  // Manual parse so an explicit default port (:443) is preserved for display.
  const noScheme = url.replace(/^wss?:\/\//i, '');
  const noCreds = noScheme.includes('@') ? noScheme.slice(noScheme.indexOf('@') + 1) : noScheme;
  return noCreds.split(/[/?#]/)[0] ?? url;
}
