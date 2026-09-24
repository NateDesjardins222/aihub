/**
 * Rithmic market-data provider — HONEST SCAFFOLD (M4-D).
 *
 * Implements the Atlas `MarketDataProvider` seam so Rithmic could one day be the
 * feed without touching anything downstream. It DOES NOT connect: the real
 * R | Protocol market-data plant integration requires the dev kit / spec,
 * credentials and (for real-time CME) an exchange market-data agreement — none
 * present here. Without config it reports UNCONFIGURED and never fabricates a
 * quote, a bar, or a CONNECTED state.
 */
import type {
  ConnectionStatus,
  HistoricalBarsRequest,
  NormalizedBar,
  NormalizedDepth,
  NormalizedQuote,
  NormalizedTrade,
} from '@atlas/contracts';
import type { DescribableProvider, ProviderCapabilities, ProviderListener } from '../provider.js';
import { redactedRithmicDescription, resolveRithmicConfig } from '../../infra/rithmic-config.js';

export class RithmicMarketDataProvider implements DescribableProvider {
  readonly id = 'rithmic';
  /** Declared relationship to the market. Real-time CME needs an exchange ILA. */
  readonly mode = 'REALTIME' as const;
  readonly depthLevels = 0; // no DOM built; MBP available on the real plant later

  private readonly subs = new Set<string>();
  private reconnectAttempts = 0;
  private lastError: string | null = null;

  configState(): 'CONFIGURED' | 'UNCONFIGURED' {
    return resolveRithmicConfig().state === 'CONFIGURED' ? 'CONFIGURED' : 'UNCONFIGURED';
  }

  async connect(): Promise<void> {
    const cfg = resolveRithmicConfig();
    if (cfg.state === 'UNCONFIGURED') {
      this.lastError = `unconfigured (missing: ${cfg.missing.join(', ')})`;
      throw new Error('Rithmic market data is not configured.');
    }
    // ── Integration seam: R | Protocol market-data plant login + subscription.
    // Requires the dev kit, credentials, and (for real-time CME) an exchange
    // agreement. It refuses honestly rather than pretending to connect.
    this.lastError = 'R | Protocol dev kit not integrated';
    throw new Error('Rithmic market-data wire protocol is not integrated in this build.');
  }

  async disconnect(): Promise<void> {
    this.subs.clear();
  }

  subscribe(symbol: string): void {
    this.subs.add(symbol);
  }
  unsubscribe(symbol: string): void {
    this.subs.delete(symbol);
  }
  subscriptions(): readonly string[] {
    return [...this.subs];
  }

  async getHistoricalBars(_request: HistoricalBarsRequest): Promise<NormalizedBar[]> {
    throw new Error('Rithmic historical bars are not available (provider unconfigured/not integrated).');
  }
  getQuote(_symbol: string): NormalizedQuote | null {
    return null; // never fabricate a quote
  }
  getTrades(_symbol: string): readonly NormalizedTrade[] {
    return [];
  }
  getDepth(_symbol: string): NormalizedDepth | null {
    return null;
  }

  getConnectionStatus(): ConnectionStatus {
    const configured = this.configState() === 'CONFIGURED';
    return {
      providerId: this.id,
      state: configured ? 'ERROR' : 'DISCONNECTED',
      mode: this.mode,
      delaySeconds: 0,
      declaredDelaySeconds: 0,
      lastEventAt: null,
      lastMessageAt: null,
      error: configured ? (this.lastError ?? undefined) : `UNCONFIGURED — ${redactedRithmicDescription()}`,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  era(): string {
    return 'rithmic:unconfigured';
  }

  on(_listener: ProviderListener): () => void {
    return () => undefined; // emits nothing
  }

  capabilities(): ProviderCapabilities {
    return {
      providesTrades: true,
      providesQuotes: true,
      providesTopOfBook: true,
      providesDepth: true,
      providesOhlcv: true,
      history: [
        { timeframe: '1m', maxLookbackDays: 0, supportsRangeQuery: false },
      ],
      notes: [
        'Scaffold only: R | Protocol dev kit not integrated.',
        'Real-time CME market data requires an exchange market-data agreement.',
      ],
    };
  }
}
