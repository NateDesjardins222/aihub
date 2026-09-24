/**
 * Scripted market-data provider — TEST DOUBLE (M4-W).
 *
 * A deterministic, fully controllable `MarketDataProvider` for proving the
 * production market-data semantics without any network: connect/disconnect,
 * delayed/out-of-order/duplicate events, sequence gaps, a stale feed, and
 * reconnect. It is a test double, not a production adapter, and it emits only the
 * events a test pushes into it — it never invents a price.
 */
import type {
  ConnectionState,
  ConnectionStatus,
  FeedMode,
  HistoricalBarsRequest,
  NormalizedBar,
  NormalizedDepth,
  NormalizedQuote,
  NormalizedTrade,
} from '@atlas/contracts';
import type { DescribableProvider, ProviderCapabilities, ProviderEvent, ProviderListener } from '../provider.js';

export class ScriptedMarketDataProvider implements DescribableProvider {
  readonly id = 'scripted';
  readonly mode: FeedMode;
  readonly depthLevels = 0;

  private state: ConnectionState = 'DISCONNECTED';
  private readonly subs = new Set<string>();
  private readonly listeners = new Set<ProviderListener>();
  private readonly lastQuote = new Map<string, NormalizedQuote>();
  private readonly trades = new Map<string, NormalizedTrade[]>();
  private lastEventAt: number | null = null;
  private lastMessageAt: number | null = null;
  private reconnectAttempts = 0;

  constructor(opts: { mode?: FeedMode } = {}) {
    this.mode = opts.mode ?? 'REALTIME';
  }

  async connect(): Promise<void> {
    if (this.state === 'DISCONNECTED' && this.reconnectAttempts > 0) {
      // reconnecting
    }
    this.state = 'CONNECTED';
    this.emitStatus();
  }
  async disconnect(): Promise<void> {
    this.state = 'DISCONNECTED';
    this.emitStatus();
  }
  /** Simulate an unexpected drop (distinct from an orderly disconnect). */
  drop(): void {
    this.state = 'RECONNECTING';
    this.reconnectAttempts += 1;
    this.emitStatus();
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
    return [];
  }
  getQuote(symbol: string): NormalizedQuote | null {
    return this.lastQuote.get(symbol) ?? null;
  }
  getTrades(symbol: string): readonly NormalizedTrade[] {
    return this.trades.get(symbol) ?? [];
  }
  getDepth(_symbol: string): NormalizedDepth | null {
    return null;
  }

  getConnectionStatus(): ConnectionStatus {
    return {
      providerId: this.id,
      state: this.state,
      mode: this.mode,
      delaySeconds: 0,
      declaredDelaySeconds: 0,
      lastEventAt: this.lastEventAt,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  era(): string {
    return 'scripted:test';
  }

  on(listener: ProviderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  capabilities(): ProviderCapabilities {
    return {
      providesTrades: true,
      providesQuotes: true,
      providesTopOfBook: true,
      providesDepth: false,
      providesOhlcv: true,
      history: [],
      notes: ['Scripted test double.'],
    };
  }

  // ── test controls ─────────────────────────────────────────────────────────
  /** Push a quote (the caller controls exchangeTs/seq for out-of-order/dup/gap). */
  pushQuote(quote: NormalizedQuote): void {
    this.lastMessageAt = Date.now();
    this.lastEventAt = quote.exchangeTs;
    this.lastQuote.set(quote.symbol, quote);
    this.emit({ kind: 'quote', quote, observedAt: Date.now() });
  }
  pushTrade(trade: NormalizedTrade): void {
    this.lastMessageAt = Date.now();
    this.lastEventAt = trade.exchangeTs;
    const list = this.trades.get(trade.symbol) ?? [];
    list.push(trade);
    this.trades.set(trade.symbol, list);
    this.emit({ kind: 'trade', trade, observedAt: Date.now() });
  }
  pushBar(bar: NormalizedBar): void {
    this.lastMessageAt = Date.now();
    this.lastEventAt = bar.time;
    this.emit({ kind: 'bar', bar, observedAt: Date.now() });
  }

  private emit(event: ProviderEvent): void {
    for (const l of this.listeners) l(event);
  }
  private emitStatus(): void {
    this.emit({ kind: 'status', status: this.getConnectionStatus() });
  }
}
