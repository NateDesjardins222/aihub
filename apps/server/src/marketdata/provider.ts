/**
 * The ONLY vendor-aware interface in the platform.
 *
 * Everything downstream — the bus, the aggregator, the WebSocket gateway, the
 * chart, the simulation engine — consumes normalized types and has no knowledge
 * of which vendor produced them. Replacing the development feed with a licensed
 * real-time provider is a new implementation of this interface and nothing else.
 */
import type {
  ConnectionStatus,
  HistoricalBarsRequest,
  NormalizedBar,
  NormalizedDepth,
  NormalizedQuote,
  NormalizedTrade,
} from '@atlas/contracts';

/**
 * When the vendor response that produced this event was parsed.
 *
 * Optional because a provider is not obliged to measure itself, and absent on
 * status events, which carry no market observation. It is the start of the only
 * half of the latency path Atlas controls, so it is worth threading.
 */
interface Observed {
  readonly observedAt?: number;
}

export type ProviderEvent =
  | ({ readonly kind: 'quote'; readonly quote: NormalizedQuote } & Observed)
  | ({ readonly kind: 'trade'; readonly trade: NormalizedTrade } & Observed)
  | ({ readonly kind: 'bar'; readonly bar: NormalizedBar } & Observed)
  | ({ readonly kind: 'depth'; readonly depth: NormalizedDepth } & Observed)
  | { readonly kind: 'status'; readonly status: ConnectionStatus };

export type ProviderListener = (event: ProviderEvent) => void;

export interface MarketDataProvider {
  readonly id: string;
  /** Declared relationship to the live market. Never lie about this. */
  readonly mode: 'DELAYED' | 'REALTIME' | 'REPLAY';
  /**
   * Number of price levels this feed actually provides.
   * 0 = no book at all, 1 = top of book, >1 = true depth.
   * The DOM reads this to decide what it is allowed to render.
   */
  readonly depthLevels: number;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  subscribe(symbol: string): void;
  unsubscribe(symbol: string): void;
  subscriptions(): readonly string[];

  getHistoricalBars(request: HistoricalBarsRequest): Promise<NormalizedBar[]>;
  getQuote(symbol: string): NormalizedQuote | null;
  getTrades(symbol: string): readonly NormalizedTrade[];
  /** Null when the feed genuinely has no depth. Callers must not invent one. */
  getDepth(symbol: string): NormalizedDepth | null;
  getConnectionStatus(): ConnectionStatus;

  /**
   * Which market this source is, as a stable string.
   *
   * Identity, not description: a position is marked only by the era it was
   * opened in, so this has to change whenever the prices change meaning - a
   * different provider, or a different recording. It is stored on open
   * positions, so it stays short.
   */
  era(): string;

  on(listener: ProviderListener): () => void;
}

/** Deepest history a provider can serve at a given granularity. */
export interface HistoryCapability {
  readonly timeframe: string;
  readonly maxLookbackDays: number;
  /** True when the provider can answer an arbitrary [from, to) window. */
  readonly supportsRangeQuery: boolean;
}

export interface ProviderCapabilities {
  readonly providesTrades: boolean;
  readonly providesQuotes: boolean;
  readonly providesTopOfBook: boolean;
  readonly providesDepth: boolean;
  readonly providesOhlcv: boolean;
  readonly history: readonly HistoryCapability[];
  readonly notes: readonly string[];
}

export interface DescribableProvider extends MarketDataProvider {
  capabilities(): ProviderCapabilities;
}
