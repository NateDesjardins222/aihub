/**
 * Development market-data provider: real, exchange-derived, DELAYED OHLCV.
 *
 * THIS IS THE ONLY FILE IN THE PLATFORM THAT KNOWS THIS VENDOR EXISTS.
 * Everything it emits is a normalized type. Swapping in Databento, CME MDP,
 * Rithmic or dxFeed means writing a sibling of this file and changing one line
 * of configuration.
 *
 * Measured characteristics (probed 2026-09-16, NQ=F):
 *   - delay: 601 +/- 2 seconds behind the exchange, consistently;
 *   - the exchange timestamp advances in real time, so it is a genuine
 *     streaming delayed feed rather than a periodically refreshed snapshot;
 *   - OHLCV only. No bid, no ask, no depth, no individual trade prints.
 *
 * Because there is no book, this provider reports depthLevels = 0 and returns
 * null from getDepth(). It does not synthesize a bid/ask around the last price,
 * and the DOM must render that absence honestly.
 */
import type {
  ConnectionStatus,
  HistoricalBarsRequest,
  InstrumentSpec,
  NormalizedBar,
  NormalizedDepth,
  NormalizedQuote,
  NormalizedTrade,
  Timeframe,
} from '@atlas/contracts';
import { getInstrument, listInstruments, snapPrice } from '@atlas/instruments';
import type {
  DescribableProvider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderListener,
} from '../provider.js';
import { emptyStats, isPlausibleExchangeTs, normalizeBar, type NormalizationStats } from '../normalize.js';

const BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const USER_AGENT = 'Mozilla/5.0 (compatible; AtlasFuturesTerminal/0.1; simulation)';

/** Vendor granularities, with the history depth each one actually serves. */
type VendorInterval = '1m' | '2m' | '5m' | '15m' | '30m' | '1h' | '1d' | '1wk' | '1mo';

interface VendorIntervalSpec {
  readonly interval: VendorInterval;
  readonly maxLookbackDays: number;
  readonly barMs: number;
}

const VENDOR_INTERVALS: readonly VendorIntervalSpec[] = [
  { interval: '1m', maxLookbackDays: 7, barMs: 60_000 },
  { interval: '5m', maxLookbackDays: 60, barMs: 300_000 },
  { interval: '15m', maxLookbackDays: 60, barMs: 900_000 },
  { interval: '30m', maxLookbackDays: 60, barMs: 1_800_000 },
  { interval: '1h', maxLookbackDays: 730, barMs: 3_600_000 },
  { interval: '1d', maxLookbackDays: 20_000, barMs: 86_400_000 },
];

/**
 * Choose the finest vendor granularity that both divides the requested
 * timeframe and reaches far enough back to answer the window.
 */
export function chooseVendorInterval(tf: Timeframe, lookbackDays: number): VendorIntervalSpec {
  const targetMs = TIMEFRAME_TARGET_MS[tf];

  const candidates = VENDOR_INTERVALS.filter(
    (v) => targetMs % v.barMs === 0 && v.maxLookbackDays >= lookbackDays,
  );
  if (candidates.length > 0) {
    // Prefer the coarsest that still divides evenly: fewer bars, same result.
    return candidates[candidates.length - 1]!;
  }

  // Nothing reaches back far enough at a dividing granularity. Fall back to the
  // finest granularity that divides, and let the caller see a shorter history
  // rather than a fabricated one.
  const dividing = VENDOR_INTERVALS.filter((v) => targetMs % v.barMs === 0);
  return dividing[dividing.length - 1] ?? VENDOR_INTERVALS[0]!;
}

/** Nominal bar length used only for granularity selection. */
const TIMEFRAME_TARGET_MS: Record<Timeframe, number> = {
  '1s': 60_000,
  '5s': 60_000,
  '10s': 60_000,
  '15s': 60_000,
  '30s': 60_000,
  '1m': 60_000,
  '2m': 120_000,
  '3m': 180_000,
  '5m': 300_000,
  '10m': 600_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '1D': 86_400_000,
  '1W': 86_400_000,
  '1M': 86_400_000,
};

interface YahooChartMeta {
  symbol: string;
  exchangeName?: string;
  exchangeTimezoneName?: string;
  regularMarketPrice?: number;
  regularMarketTime?: number;
  regularMarketVolume?: number;
  instrumentType?: string;
}

interface YahooChartResult {
  meta: YahooChartMeta;
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      open?: Array<number | null>;
      high?: Array<number | null>;
      low?: Array<number | null>;
      close?: Array<number | null>;
      volume?: Array<number | null>;
    }>;
  };
}

export interface YahooProviderOptions {
  readonly pollIntervalMs: number;
  readonly declaredDelaySeconds: number;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class YahooDelayedProvider implements DescribableProvider {
  readonly id = 'yahoo-delayed';
  readonly mode = 'DELAYED' as const;
  /** No book of any kind. The DOM must say so rather than invent levels. */
  readonly depthLevels = 0;

  private readonly listeners = new Set<ProviderListener>();
  private readonly subscribed = new Set<string>();
  private readonly quotes = new Map<string, NormalizedQuote>();
  private readonly seqBySymbol = new Map<string, number>();
  /**
   * The last bar published per symbol, so a poll republishes only what changed.
   *
   * Every poll returns the vendor's whole intraday window - hundreds of bars
   * that were already published on the previous poll. Re-emitting them floods
   * every downstream consumer (the socket, the aggregators, and the matching
   * engine, which treats a closed bar as an opportunity to fill) with events
   * that carry no new information.
   */
  private readonly lastBarBySymbol = new Map<string, { time: number; signature: string }>();
  private timer: NodeJS.Timeout | null = null;
  /** The poll currently running, if any. */
  private pollInFlight: Promise<void> | null = null;
  /** A single follow-up poll shared by everyone who asked during this one. */
  private queuedPoll: Promise<void> | null = null;
  private state: ConnectionStatus['state'] = 'DISCONNECTED';
  private reconnectAttempts = 0;
  private lastMessageAt: number | null = null;
  private lastEventAt: number | null = null;
  private lastError: string | undefined;
  /** Measured, not assumed: updated from every successful poll. */
  private measuredDelaySeconds: number;
  readonly normalizationStats: NormalizationStats = emptyStats();

  private readonly doFetch: typeof fetch;

  constructor(private readonly options: YahooProviderOptions) {
    this.measuredDelaySeconds = options.declaredDelaySeconds;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  capabilities(): ProviderCapabilities {
    return {
      providesTrades: false,
      providesQuotes: true,
      providesTopOfBook: false,
      providesDepth: false,
      providesOhlcv: true,
      history: VENDOR_INTERVALS.map((v) => ({
        timeframe: v.interval,
        maxLookbackDays: v.maxLookbackDays,
        supportsRangeQuery: true,
      })),
      notes: [
        'Delayed approximately 10 minutes behind the exchange (measured 601s).',
        'Provides OHLCV and a last price only. No bid, no ask, no depth, no prints.',
        'Development use only. Redistribution and production use require a licensed vendor.',
      ],
    };
  }

  async connect(): Promise<void> {
    if (this.timer) return;
    this.state = 'CONNECTING';
    this.emitStatus();

    // Prove the feed answers before claiming to be connected. runPoll() is what
    // sets CONNECTED or RECONNECTING, based on whether a request actually
    // returned data; connect() must not overwrite that with an assumption.
    // If nothing is subscribed yet there was nothing to fetch and therefore
    // nothing proven, so the state stays CONNECTING until the first real poll.
    await this.pollOnce();
    this.emitStatus();

    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => {
        /* handled inside pollOnce */
      });
    }, this.options.pollIntervalMs);
    this.timer.unref?.();
  }

  async disconnect(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.state = 'DISCONNECTED';
    this.emitStatus();
  }

  subscribe(symbol: string): void {
    const root = symbol.toUpperCase();
    if (!getInstrument(root)) throw new Error(`UNKNOWN_INSTRUMENT: ${root}`);
    if (this.subscribed.has(root)) return;
    this.subscribed.add(root);
    // Fetch immediately so a new subscriber does not wait a full poll interval.
    void this.pollOnce().catch(() => {});
  }

  unsubscribe(symbol: string): void {
    const root = symbol.toUpperCase();
    this.subscribed.delete(root);
    // Forget the republish watermark: a later resubscribe has to reseed the
    // aggregators with the whole window again.
    this.lastBarBySymbol.delete(root);
  }

  subscriptions(): readonly string[] {
    return [...this.subscribed];
  }

  getQuote(symbol: string): NormalizedQuote | null {
    return this.quotes.get(symbol.toUpperCase()) ?? null;
  }

  /** This feed publishes no individual prints. Returning [] is the honest answer. */
  getTrades(): readonly NormalizedTrade[] {
    return [];
  }

  /** No book. Never synthesize one. */
  getDepth(): NormalizedDepth | null {
    return null;
  }

  era(): string {
    return `live:${this.id}`;
  }

  getConnectionStatus(): ConnectionStatus {
    return {
      providerId: this.id,
      state: this.state,
      mode: this.mode,
      delaySeconds: Math.round(this.measuredDelaySeconds),
      declaredDelaySeconds: this.options.declaredDelaySeconds,
      lastEventAt: this.lastEventAt,
      lastMessageAt: this.lastMessageAt,
      error: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  on(listener: ProviderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getHistoricalBars(request: HistoricalBarsRequest): Promise<NormalizedBar[]> {
    const spec = getInstrument(request.symbol);
    if (!spec) throw new Error(`UNKNOWN_INSTRUMENT: ${request.symbol}`);

    const to = request.to ?? Date.now();
    const from = request.from ?? to - 5 * 86_400_000;
    const lookbackDays = Math.ceil((Date.now() - from) / 86_400_000);
    const vendor = chooseVendorInterval(request.timeframe, lookbackDays);

    const url =
      `${BASE_URL}/${encodeURIComponent(this.vendorSymbol(spec))}` +
      `?interval=${vendor.interval}` +
      `&period1=${Math.floor(from / 1000)}` +
      `&period2=${Math.ceil(to / 1000)}` +
      `&includePrePost=true`;

    const result = await this.request(url);
    if (!result) return [];
    const marketTs = (result.meta.regularMarketTime ?? 0) * 1000;
    return this.extractBars(spec, result, { marketTs, barMs: vendor.barMs });
  }

  /** Deepest history this provider can serve for a timeframe, in days. */
  maxLookbackDays(tf: Timeframe): number {
    return chooseVendorInterval(tf, Number.POSITIVE_INFINITY).maxLookbackDays;
  }

  private vendorSymbol(spec: InstrumentSpec): string {
    const mapped = spec.providerSymbols['yahoo'];
    if (!mapped) throw new Error(`NO_PROVIDER_SYMBOL: ${spec.root} on ${this.id}`);
    return mapped;
  }

  /**
   * One poll cycle.
   *
   * Instruments sharing an underlying series (NQ and MNQ both track NQ=F) are
   * fetched once and fanned out, so eight subscribed instruments cost four
   * requests rather than eight.
   */
  /**
   * Run a poll, coalescing concurrent requests.
   *
   * Subscribing triggers an immediate poll so a new chart does not wait a whole
   * interval for data. Eight instruments subscribing at start-up would otherwise
   * have seven of their requests dropped by a simple in-flight guard, so a
   * request arriving mid-poll schedules exactly one follow-up instead.
   *
   * The returned promise resolves only once a poll that includes the caller's
   * subscription has actually finished; resolving early would make `await
   * pollOnce()` a lie.
   */
  private pollOnce(): Promise<void> {
    if (this.pollInFlight) {
      if (!this.queuedPoll) {
        this.queuedPoll = this.pollInFlight
          .catch(() => {})
          .then(() => {
            this.queuedPoll = null;
            return this.pollOnce();
          });
      }
      return this.queuedPoll;
    }

    this.pollInFlight = this.runPoll().finally(() => {
      this.pollInFlight = null;
    });
    return this.pollInFlight;
  }

  /**
   * One poll cycle.
   *
   * Instruments sharing an underlying series (NQ and MNQ both track NQ=F) are
   * fetched once and fanned out, so eight subscribed instruments cost four
   * requests rather than eight.
   */
  private async runPoll(): Promise<void> {
    if (this.subscribed.size === 0) return;

    const byVendorSymbol = new Map<string, InstrumentSpec[]>();
    for (const root of this.subscribed) {
      const spec = getInstrument(root);
      if (!spec) continue;
      const vs = this.vendorSymbol(spec);
      const group = byVendorSymbol.get(vs);
      if (group) group.push(spec);
      else byVendorSymbol.set(vs, [spec]);
    }

    let anySuccess = false;
    for (const [vendorSymbol, specs] of byVendorSymbol) {
      const url = `${BASE_URL}/${encodeURIComponent(vendorSymbol)}?interval=1m&range=1d&includePrePost=true`;
      const result = await this.request(url);
      if (!result) continue;
      anySuccess = true;
      for (const spec of specs) this.publishFrom(spec, result);
    }

    if (anySuccess) {
      if (this.state !== 'CONNECTED') {
        this.state = 'CONNECTED';
        this.reconnectAttempts = 0;
        this.lastError = undefined;
        this.emitStatus();
      }
    } else if (this.subscribed.size > 0) {
      this.markReconnecting('No symbol returned data');
    }
  }

  private markReconnecting(message: string): void {
    this.reconnectAttempts += 1;
    this.state = 'RECONNECTING';
    this.lastError = message;
    this.emitStatus();
  }

  private async request(url: string): Promise<YahooChartResult | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 15_000);
    try {
      const response = await this.doFetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: controller.signal,
      });
      this.lastMessageAt = Date.now();
      if (!response.ok) {
        this.markReconnecting(`HTTP ${response.status}`);
        return null;
      }
      const body = (await response.json()) as {
        chart?: { result?: YahooChartResult[] | null; error?: { description?: string } | null };
      };
      const error = body.chart?.error;
      if (error) {
        this.markReconnecting(error.description ?? 'vendor error');
        return null;
      }
      return body.chart?.result?.[0] ?? null;
    } catch (err) {
      this.markReconnecting(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Turn one vendor payload into normalized events.
   *
   * The vendor appends a final row whose timestamp is NOT minute-aligned: that
   * row is the current price, not a completed minute. It is treated as a live
   * update to the forming bar, which is exactly what it is.
   */
  private publishFrom(spec: InstrumentSpec, result: YahooChartResult): void {
    const meta = result.meta;
    const marketTs = (meta.regularMarketTime ?? 0) * 1000;
    const price = meta.regularMarketPrice;

    if (price != null && Number.isFinite(price) && isPlausibleExchangeTs(marketTs)) {
      this.measuredDelaySeconds = Math.max(0, (Date.now() - marketTs) / 1000);
      this.lastEventAt = marketTs;

      const seq = (this.seqBySymbol.get(spec.root) ?? 0) + 1;
      this.seqBySymbol.set(spec.root, seq);

      const quote: NormalizedQuote = {
        symbol: spec.root,
        exchangeTs: marketTs,
        // This feed carries no book. Nulls are the truthful representation.
        bid: null,
        bidSize: null,
        ask: null,
        askSize: null,
        last: snapPrice(spec, price),
        lastSize: null,
        seq,
        synthesizedBook: false,
      };
      this.quotes.set(spec.root, quote);
      this.emit({ kind: 'quote', quote });
    }

    for (const bar of this.newBars(spec.root, this.extractBars(spec, result, { marketTs, barMs: 60_000 }))) {
      this.emit({ kind: 'bar', bar });
    }
  }

  /**
   * Drop bars a previous poll already published.
   *
   * The first poll for a symbol seeds the aggregators with the whole window and
   * is let through untouched. After that only two things are news: a bucket
   * later than the newest one published, and a revision of that newest bucket,
   * whose extremes and volume still move while it forms.
   */
  private newBars(symbol: string, bars: NormalizedBar[]): NormalizedBar[] {
    const seen = this.lastBarBySymbol.get(symbol);
    const signature = (b: NormalizedBar): string =>
      `${b.open}|${b.high}|${b.low}|${b.close}|${b.volume}|${b.closed ? 1 : 0}`;

    let fresh: NormalizedBar[];
    if (!seen) {
      fresh = bars;
    } else {
      fresh = bars.filter((bar) => {
        if (bar.time > seen.time) return true;
        if (bar.time < seen.time) return false;
        return signature(bar) !== seen.signature;
      });
    }

    const newest = fresh[fresh.length - 1];
    if (newest) this.lastBarBySymbol.set(symbol, { time: newest.time, signature: signature(newest) });
    return fresh;
  }

  /**
   * Turn the vendor's parallel arrays into bars.
   *
   * Two vendor quirks are handled here rather than leaking downstream:
   *
   * 1. The payload appends a trailing row whose timestamp is the current market
   *    time rather than a bucket boundary. It is the last price, not a new bar,
   *    and its volume field is 0. Emitting it as a bar would overwrite the real
   *    bucket's volume with zero, so it is dropped: the quote carries that price.
   *
   * 2. Whether a bar is settled is decided against the EXCHANGE clock, not the
   *    server's. On a feed delayed ten minutes the most recent bucket is still
   *    forming even though its end time is long past in wall-clock terms.
   */
  private extractBars(
    spec: InstrumentSpec,
    result: YahooChartResult,
    opts: { marketTs: number; barMs: number },
  ): NormalizedBar[] {
    const timestamps = result.timestamp ?? [];
    const quote = result.indicators?.quote?.[0];
    if (timestamps.length === 0 || !quote) return [];

    const bars: NormalizedBar[] = [];
    const lastIndex = timestamps.length - 1;
    const barSeconds = opts.barMs / 1000;

    for (let i = 0; i < timestamps.length; i += 1) {
      const ts = timestamps[i];
      if (ts === undefined) continue;
      if (!isPlausibleExchangeTs(ts * 1000)) continue;

      // Quirk 1: identify the trailing live-price row and drop it.
      //
      // Intraday vendor buckets are epoch-aligned, so a trailing row that is not
      // on the grid is the live price. A gap heuristic is not enough here: the
      // vendor often publishes the live price before the aligned bar for that
      // same minute exists, which puts the two more than one bar apart.
      // Daily and coarser vendor bars are not epoch-aligned, so those fall back
      // to the spacing test.
      if (i === lastIndex && lastIndex > 0) {
        const previous = timestamps[lastIndex - 1];
        const isIntradayGrid = opts.barMs < 86_400_000;
        const offGrid = isIntradayGrid
          ? ts % barSeconds !== 0
          : previous !== undefined && ts - previous < barSeconds;
        if (offGrid) continue;
      }

      // Quirk 2: settled relative to the exchange clock.
      const closed = opts.marketTs > 0 ? ts * 1000 + opts.barMs <= opts.marketTs : true;

      const bar = normalizeBar(
        spec,
        {
          tsSeconds: ts,
          open: quote.open?.[i],
          high: quote.high?.[i],
          low: quote.low?.[i],
          close: quote.close?.[i],
          volume: quote.volume?.[i],
        },
        this.normalizationStats,
        closed,
      );
      if (bar) bars.push(bar);
    }
    return bars;
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitStatus(): void {
    this.emit({ kind: 'status', status: this.getConnectionStatus() });
  }
}

/** Every instrument this provider can serve, derived from the registry. */
export function yahooSupportedRoots(): string[] {
  return listInstruments()
    .filter((i) => i.providerSymbols['yahoo'])
    .map((i) => i.root);
}
