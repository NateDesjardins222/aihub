/**
 * Rithmic market-data provider (Milestone 9).
 *
 * Implements the Atlas `MarketDataProvider` seam. When Rithmic is enabled AND
 * market data is enabled AND credentials are configured, it drives the real
 * R | Protocol TICKER + HISTORY plants through the connection manager and
 * normalizes observations into Atlas canonical events. Otherwise it stays
 * honestly UNCONFIGURED and never fabricates a quote, a bar, or a CONNECTED state.
 * The transport factory is injectable so the whole path is testable without a
 * network; production defaults to the real WebSocket transport.
 */
import type {
  ConnectionStatus,
  HistoricalBarsRequest,
  NormalizedBar,
  NormalizedDepth,
  NormalizedQuote,
  NormalizedTrade,
} from '@atlas/contracts';
import type { DescribableProvider, ProviderCapabilities, ProviderListener, ProviderEvent } from '../provider.js';
import { redactedRithmicDescription, resolveRithmicConnection } from '../../infra/rithmic-config.js';
import { RithmicConnectionManager } from '../../rithmic/plants/connection-manager.js';
import { RithmicMarketDataService } from '../../rithmic/plants/market-data-service.js';
import { WsRithmicTransport } from '../../rithmic/transport/ws-transport.js';
import type { TransportFactory } from '../../rithmic/transport/transport.js';
import { rithmicExchange, isLaunchRoot } from '../../rithmic/domain/instruments.js';

export class RithmicMarketDataProvider implements DescribableProvider {
  readonly id = 'rithmic';
  readonly mode = 'REALTIME' as const;
  readonly depthLevels = 0; // BBO only in M9; no full DOM built

  private readonly subs = new Set<string>();
  private readonly quotes = new Map<string, NormalizedQuote>();
  private readonly trades = new Map<string, NormalizedTrade[]>();
  private readonly listeners = new Set<ProviderListener>();
  private manager: RithmicConnectionManager | null = null;
  private service: RithmicMarketDataService | null = null;
  private lastError: string | null = null;
  private lastMessageAt: number | null = null;
  private reconnectAttempts = 0;

  constructor(private readonly transportFactory: TransportFactory = (url) => new WsRithmicTransport(url)) {}

  configState(): 'CONFIGURED' | 'UNCONFIGURED' {
    return resolveRithmicConnection().ok ? 'CONFIGURED' : 'UNCONFIGURED';
  }

  async connect(): Promise<void> {
    const r = resolveRithmicConnection();
    if (!r.ok) { this.lastError = r.reason; throw new Error(`Rithmic market data is not configured (${r.reason}).`); }
    if (!r.connection.marketDataEnabled) {
      this.lastError = 'RITHMIC_MARKET_DATA_ENABLED is false';
      throw new Error('Rithmic market data is not enabled (RITHMIC_MARKET_DATA_ENABLED=false).');
    }
    const c = r.connection;
    const mgr = new RithmicConnectionManager({
      endpoint: c.endpoint,
      systemName: c.systemName,
      login: { user: c.credentials!.user, password: c.credentials!.password, appName: c.appName, appVersion: c.appVersion },
      plants: ['TICKER', 'HISTORY'],
      transportFactory: this.transportFactory,
      onPlantAuthenticated: (kind) => { if (kind === 'TICKER') this.service?.restoreSubscriptions(mgr.plant('TICKER')); },
    }, c.environment);
    await mgr.start();
    this.manager = mgr;
    const ticker = mgr.plant('TICKER')!;
    const history = mgr.plant('HISTORY') ?? null;
    const svc = new RithmicMarketDataService(ticker, history);
    svc.on((e) => this.onServiceEvent(e));
    this.service = svc;
    // Re-apply any subscriptions requested before connect.
    for (const symbol of this.subs) this.subscribeSymbol(symbol);
  }

  private onServiceEvent(e: { kind: 'trade'; trade: NormalizedTrade; observedAt: number } | { kind: 'quote'; quote: NormalizedQuote; observedAt: number }): void {
    this.lastMessageAt = e.observedAt;
    let ev: ProviderEvent;
    if (e.kind === 'trade') {
      const list = this.trades.get(e.trade.symbol) ?? [];
      list.push(e.trade);
      if (list.length > 1000) list.shift();
      this.trades.set(e.trade.symbol, list);
      ev = { kind: 'trade', trade: e.trade, observedAt: e.observedAt };
    } else {
      this.quotes.set(e.quote.symbol, e.quote);
      ev = { kind: 'quote', quote: e.quote, observedAt: e.observedAt };
    }
    for (const l of this.listeners) { try { l(ev); } catch { /* isolate */ } }
  }

  async disconnect(): Promise<void> {
    this.service?.dispose();
    this.manager?.stop();
    this.service = null;
    this.manager = null;
  }

  subscribe(symbol: string): void {
    this.subs.add(symbol);
    if (this.service) this.subscribeSymbol(symbol);
  }

  private subscribeSymbol(symbol: string): void {
    // `symbol` is the Atlas root or a resolved contract; map to a Rithmic exchange.
    const root = symbol.replace(/[FGHJKMNQUVXZ]\d+$/i, ''); // strip a trailing month+year if present
    const exchange = isLaunchRoot(root) ? rithmicExchange(root) : 'CME';
    this.service?.subscribe({ root, symbol, exchange });
  }

  unsubscribe(symbol: string): void {
    this.subs.delete(symbol);
    this.service?.unsubscribe(symbol);
  }
  subscriptions(): readonly string[] {
    return [...this.subs];
  }

  async getHistoricalBars(request: HistoricalBarsRequest): Promise<NormalizedBar[]> {
    if (!this.service) throw new Error('Rithmic history is not available (provider not connected).');
    const root = request.symbol.replace(/[FGHJKMNQUVXZ]\d+$/i, '');
    const exchange = isLaunchRoot(root) ? rithmicExchange(root) : 'CME';
    return this.service.getHistoricalBars({
      symbol: request.symbol, exchange, timeframe: request.timeframe,
      from: request.from ?? 0, to: request.to ?? 0,
    });
  }
  getQuote(symbol: string): NormalizedQuote | null {
    return this.quotes.get(symbol) ?? null; // never fabricate
  }
  getTrades(symbol: string): readonly NormalizedTrade[] {
    return this.trades.get(symbol) ?? [];
  }
  getDepth(_symbol: string): NormalizedDepth | null {
    return null; // no full DOM in M9
  }

  getConnectionStatus(): ConnectionStatus {
    const configured = this.configState() === 'CONFIGURED';
    const healthy = this.manager?.allHealthy() ?? false;
    const state = !configured ? 'DISCONNECTED' : healthy ? 'CONNECTED' : this.manager ? 'RECONNECTING' : 'ERROR';
    return {
      providerId: this.id,
      state,
      mode: this.mode,
      delaySeconds: 0,
      declaredDelaySeconds: 0,
      lastEventAt: null,
      lastMessageAt: this.lastMessageAt,
      error: !configured ? `UNCONFIGURED — ${redactedRithmicDescription()}` : (this.lastError ?? undefined),
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  era(): string {
    return 'rithmic:test';
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
      history: [
        { timeframe: '1m', maxLookbackDays: 30, supportsRangeQuery: true },
        { timeframe: '5m', maxLookbackDays: 60, supportsRangeQuery: true },
        { timeframe: '15m', maxLookbackDays: 120, supportsRangeQuery: true },
        { timeframe: '1h', maxLookbackDays: 365, supportsRangeQuery: true },
      ],
      notes: [
        'Rithmic Test (R | Protocol). Real-time observations via TICKER plant; history via HISTORY plant.',
        'Entitlement/market state may limit or delay data; freshness is reported truthfully.',
      ],
    };
  }
}
