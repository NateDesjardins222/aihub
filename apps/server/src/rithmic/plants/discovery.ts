/**
 * Rithmic system discovery (Milestone 9).
 *
 * Implements the official discovery handshake: open a websocket, send
 * RequestRithmicSystemInfo, parse the returned system names, verify the
 * configured system (e.g. "Rithmic Test") is present, then close. Results are
 * cached for a bounded duration. Never silently falls back to another Rithmic
 * environment; a missing system is reported honestly.
 */
import { rithmicCodec, type RithmicCodec } from '../protocol/codec.js';
import { RithmicPlant } from './plant.js';
import type { TransportFactory } from '../transport/transport.js';

export interface DiscoveryResult {
  readonly systems: readonly string[];
  readonly discoveredAt: number;
}

export type DiscoveryErrorCode = 'ENDPOINT_UNAVAILABLE' | 'MALFORMED_RESPONSE' | 'TIMEOUT' | 'SYSTEM_ABSENT';

export class RithmicDiscoveryError extends Error {
  constructor(readonly code: DiscoveryErrorCode, message: string) {
    super(message);
    this.name = 'RithmicDiscoveryError';
  }
}

export interface DiscoveryOptions {
  readonly url: string;
  readonly transportFactory: TransportFactory;
  readonly codec?: RithmicCodec;
  readonly cacheMs?: number;
  readonly now?: () => number;
  readonly scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
  };
}

export class RithmicSystemDiscoveryService {
  private readonly codec: RithmicCodec;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private cached: DiscoveryResult | null = null;

  constructor(private readonly opts: DiscoveryOptions) {
    this.codec = opts.codec ?? rithmicCodec();
    this.cacheMs = opts.cacheMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Discover available Rithmic systems (cached briefly). */
  async discover(force = false): Promise<DiscoveryResult> {
    if (!force && this.cached && this.now() - this.cached.discoveredAt < this.cacheMs) {
      return this.cached;
    }
    const plant = new RithmicPlant({
      kind: 'DISCOVERY',
      url: this.opts.url,
      transportFactory: this.opts.transportFactory,
      codec: this.codec,
      now: this.now,
      ...(this.opts.scheduler ? { scheduler: this.opts.scheduler } : {}),
    });
    try {
      await plant.start();
      if (plant.getState() !== 'AUTHENTICATED') {
        throw new RithmicDiscoveryError('ENDPOINT_UNAVAILABLE', `discovery endpoint not reachable (${plant.getState()})`);
      }
      const resp = await plant
        .request('RequestRithmicSystemInfo', { user_msg: [`disc-${this.now()}`] }, 'ResponseRithmicSystemInfo', 15_000)
        .catch((e) => { throw new RithmicDiscoveryError('TIMEOUT', `system info: ${(e as Error).message}`); });
      const raw = resp.message?.['system_name'];
      const systems = Array.isArray(raw) ? raw.map((s) => String(s)).filter((s) => s.length > 0) : [];
      if (systems.length === 0) throw new RithmicDiscoveryError('MALFORMED_RESPONSE', 'no system names returned');
      this.cached = { systems, discoveredAt: this.now() };
      return this.cached;
    } finally {
      plant.stop();
    }
  }

  /** Verify the configured system exists before a login is attempted. */
  async verifySystem(systemName: string, force = false): Promise<DiscoveryResult> {
    const result = await this.discover(force);
    if (!result.systems.includes(systemName)) {
      throw new RithmicDiscoveryError('SYSTEM_ABSENT', `configured system "${systemName}" not in [${result.systems.join(', ')}]`);
    }
    return result;
  }
}
