/**
 * Market-data freshness measurement (Milestone 9).
 *
 * A websocket being open is NOT the same as fresh data. This tracks, per symbol
 * and overall, the provider event time, the receive time, the observed age, the
 * message rate and the decode/drop counters, so the UI can truthfully show
 * CONNECTED / STALE / RECONNECTING / DISCONNECTED rather than assuming "connected
 * = live". If the Test feed itself is entitlement-limited or delayed, that shows.
 */
export type FeedStatusLabel = 'CONNECTED' | 'STALE' | 'RECONNECTING' | 'DISCONNECTED';

export interface FreshnessSnapshot {
  readonly symbol: string;
  readonly lastProviderTs: number | null;
  readonly lastReceiveTs: number | null;
  readonly observedAgeMs: number | null;
  readonly messagesPerSec: number;
  readonly staleThresholdMs: number;
  readonly stale: boolean;
}

export class FreshnessTracker {
  private lastProviderTs: number | null = null;
  private lastReceiveTs: number | null = null;
  private readonly recentReceives: number[] = []; // wall-clock ms, last ~5s
  private decodeErrors = 0;
  private dropped = 0;
  private reconnects = 0;

  constructor(
    readonly symbol: string,
    private readonly staleThresholdMs = 5_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  observe(providerTsMs: number | null): void {
    const t = this.now();
    if (providerTsMs !== null) this.lastProviderTs = providerTsMs;
    this.lastReceiveTs = t;
    this.recentReceives.push(t);
    const cutoff = t - 5_000;
    while (this.recentReceives.length > 0 && this.recentReceives[0]! < cutoff) this.recentReceives.shift();
  }

  noteDecodeError(): void { this.decodeErrors += 1; }
  noteDropped(): void { this.dropped += 1; }
  noteReconnect(): void { this.reconnects += 1; }

  get counters(): { decodeErrors: number; dropped: number; reconnects: number } {
    return { decodeErrors: this.decodeErrors, dropped: this.dropped, reconnects: this.reconnects };
  }

  observedAgeMs(): number | null {
    if (this.lastReceiveTs === null) return null;
    return this.now() - this.lastReceiveTs;
  }

  messagesPerSec(): number {
    const t = this.now();
    const cutoff = t - 5_000;
    const n = this.recentReceives.filter((r) => r >= cutoff).length;
    return n / 5;
  }

  isStale(): boolean {
    const age = this.observedAgeMs();
    return age === null || age > this.staleThresholdMs;
  }

  snapshot(): FreshnessSnapshot {
    return {
      symbol: this.symbol,
      lastProviderTs: this.lastProviderTs,
      lastReceiveTs: this.lastReceiveTs,
      observedAgeMs: this.observedAgeMs(),
      messagesPerSec: this.messagesPerSec(),
      staleThresholdMs: this.staleThresholdMs,
      stale: this.isStale(),
    };
  }

  /**
   * The truthful status label. `connected` reflects the transport; a connected
   * transport with stale data is STALE, not CONNECTED — the whole point.
   */
  statusLabel(connected: boolean, reconnecting: boolean): FeedStatusLabel {
    if (reconnecting) return 'RECONNECTING';
    if (!connected) return 'DISCONNECTED';
    if (this.lastReceiveTs === null || this.isStale()) return 'STALE';
    return 'CONNECTED';
  }
}
