/** Market-data contracts. Vendor-neutral by construction. */

export type ConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'ERROR';

/**
 * How the feed relates to the live market. Never report DELAYED data as REALTIME.
 * REPLAY means recorded real market data being played back.
 */
export type FeedMode = 'DELAYED' | 'REALTIME' | 'REPLAY';

export interface ConnectionStatus {
  readonly providerId: string;
  readonly state: ConnectionState;
  readonly mode: FeedMode;
  /** Measured or declared delay of the feed, in seconds. 0 for realtime. */
  readonly delaySeconds: number;
  /** Exchange timestamp (epoch ms) of the newest event we have seen, any symbol. */
  readonly lastEventAt: number | null;
  /** Wall-clock (epoch ms) when we last received anything from the provider. */
  readonly lastMessageAt: number | null;
  readonly error?: string;
  readonly reconnectAttempts: number;
}

/** Canonical timeframes. Non-time-based aggregations are added via BarTransform. */
export type Timeframe =
  | '1s' | '5s' | '10s' | '15s' | '30s'
  | '1m' | '2m' | '3m' | '5m' | '10m' | '15m' | '30m'
  | '1h' | '2h' | '4h'
  | '1D' | '1W' | '1M';

export interface NormalizedBar {
  readonly symbol: string;
  /** Bar OPEN time as exchange epoch ms, aligned to the timeframe boundary. */
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  /** False while the bar is still forming. */
  readonly closed: boolean;
}

export interface NormalizedQuote {
  readonly symbol: string;
  /** Exchange timestamp, epoch ms. Never the browser or server clock. */
  readonly exchangeTs: number;
  readonly bid: number | null;
  readonly bidSize: number | null;
  readonly ask: number | null;
  readonly askSize: number | null;
  readonly last: number | null;
  readonly lastSize: number | null;
  /** Provider-assigned monotonic sequence, used for dedupe/ordering. */
  readonly seq: number;
  /**
   * True when bid/ask are derived from a last-trade print rather than a real
   * book. The DOM and fill models must know the difference.
   */
  readonly synthesizedBook: boolean;
}

export interface NormalizedTrade {
  readonly symbol: string;
  readonly exchangeTs: number;
  readonly price: number;
  readonly size: number;
  readonly seq: number;
  readonly aggressor: 'BUY' | 'SELL' | 'UNKNOWN';
}

export interface DepthLevel {
  readonly price: number;
  readonly size: number;
  readonly orders?: number;
}

export interface NormalizedDepth {
  readonly symbol: string;
  readonly exchangeTs: number;
  readonly bids: readonly DepthLevel[];
  readonly asks: readonly DepthLevel[];
  /** Number of price levels the feed actually provides. 1 = top of book only. */
  readonly levels: number;
}

export interface HistoricalBarsRequest {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** Inclusive lower bound, epoch ms. */
  readonly from?: number;
  /** Exclusive upper bound, epoch ms. */
  readonly to?: number;
  readonly limit?: number;
}

export interface MarketDataStaleness {
  readonly symbol: string;
  readonly ageMs: number;
  readonly stale: boolean;
  readonly thresholdMs: number;
}
