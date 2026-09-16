/**
 * Market data service: the seam between a provider and the rest of the platform.
 *
 *   provider -> normalization -> bus -> quote store
 *                                    \-> candle aggregators -> subscribers
 *
 * Nothing above this layer knows which provider is running, and switching from
 * the delayed development feed to the replay feed (or to a licensed real-time
 * feed) is a swap of one object.
 */
import type {
  ConnectionStatus,
  InstrumentSpec,
  NormalizedBar,
  NormalizedQuote,
  Timeframe,
} from '@atlas/contracts';
import { getInstrument, getMarketState, requireInstrument } from '@atlas/instruments';
import { CandleAggregator, bucketStart, timeframeMs, type BarUpdate } from '@atlas/core';
import type { Database } from '../db/client.js';
import { marketDataMeta } from '../db/schema.js';
import { MarketEventBus } from './bus.js';
import { QuoteStore, freshnessClock, type Freshness } from './quote-store.js';
import { BarService, type BarPage, type BarQuery } from './bar-service.js';
import type { MarketDataProvider, ProviderCapabilities } from './provider.js';

export interface MarketDataServiceOptions {
  readonly staleToleranceMs: number;
  readonly historyWarmupBars: number;
  readonly baseTimeframe: Timeframe;
}

export interface SymbolStatus {
  readonly symbol: string;
  readonly quote: NormalizedQuote | null;
  readonly freshness: Freshness;
  readonly marketState: ReturnType<typeof getMarketState>;
  readonly activeAggregatorBars: number;
}

export class MarketDataService {
  readonly bus = new MarketEventBus();
  readonly quotes: QuoteStore;
  /** Rebuilt when the provider is swapped, so it always fetches from the live one. */
  bars: BarService;

  private readonly aggregators = new Map<string, CandleAggregator>();
  private readonly subscriberCounts = new Map<string, number>();
  private readonly warmups = new Map<string, Promise<void>>();
  private detach: (() => void) | null = null;
  private status: ConnectionStatus;

  constructor(
    private provider: MarketDataProvider,
    private readonly db: Database,
    private readonly options: MarketDataServiceOptions,
  ) {
    this.quotes = new QuoteStore({
      expectedDelayMs: provider.mode === 'DELAYED' ? 600_000 : 0,
      toleranceMs: options.staleToleranceMs,
    });
    this.bars = new BarService(db, provider);
    this.status = provider.getConnectionStatus();
  }

  get currentProvider(): MarketDataProvider {
    return this.provider;
  }

  capabilities(): ProviderCapabilities | null {
    const p = this.provider as Partial<{ capabilities: () => ProviderCapabilities }>;
    return p.capabilities?.() ?? null;
  }

  async start(): Promise<void> {
    this.attach();
    await this.provider.connect();
  }

  async stop(): Promise<void> {
    this.detach?.();
    this.detach = null;
    await this.provider.disconnect();
  }

  /**
   * Replace the running provider, keeping every subscription.
   *
   * Aggregators are cleared rather than carried over: mixing a live delayed feed
   * with a replayed session in one series would produce a chart that is not a
   * record of anything real.
   */
  async switchProvider(next: MarketDataProvider): Promise<void> {
    const symbols = [...this.subscriberCounts.keys()];
    await this.stop();
    this.provider = next;
    this.bars = new BarService(this.db, next);
    this.quotes.clear();
    this.bus.resetAll();
    for (const agg of this.aggregators.values()) agg.clear();
    this.aggregators.clear();
    this.warmups.clear();
    // Reference counts refer to the old provider's subscriptions; they are
    // rebuilt below as each symbol is re-subscribed.
    this.subscriberCounts.clear();
    this.quotes.setExpectedDelayMs(next.mode === 'DELAYED' ? 600_000 : 0);
    this.attach();
    await next.connect();

    // Re-subscribe through the SERVICE, not the provider. Calling
    // provider.subscribe() directly attaches the feed but never recreates the
    // candle aggregators, so bars would arrive with nowhere to go: the chart
    // would keep serving cached history and its price would silently freeze.
    for (const symbol of symbols) await this.subscribe(symbol);
  }

  private attach(): void {
    this.detach?.();
    this.detach = this.provider.on((event) => {
      switch (event.kind) {
        case 'quote': {
          if (!this.bus.publishQuote(event.quote)) return;
          this.quotes.putQuote(event.quote);
          // Keep the forming candle's close current between bar republishes.
          if (event.quote.last != null) {
            this.aggregators
              .get(event.quote.symbol)
              ?.ingestPrice(event.quote.last, event.quote.exchangeTs);
          }
          void this.recordMeta(event.quote.symbol, event.quote.exchangeTs);
          return;
        }
        case 'trade': {
          if (!this.bus.publishTrade(event.trade)) return;
          this.quotes.putTrade(event.trade);
          this.aggregators.get(event.trade.symbol)?.ingestTrade(event.trade);
          return;
        }
        case 'bar': {
          this.bus.publishBar(event.bar);
          this.aggregators.get(event.bar.symbol)?.ingestBar(event.bar, 'STREAM');
          return;
        }
        case 'depth': {
          this.bus.publishDepth(event.depth);
          return;
        }
        case 'status': {
          this.status = event.status;
          if (event.status.mode === 'DELAYED') {
            // The DECLARED delay, never the measured one. A feed that has
            // stopped publishing measures an ever-growing delay, so calibrating
            // staleness to it would keep reporting a frozen feed as fresh.
            this.quotes.setExpectedDelayMs(event.status.declaredDelaySeconds * 1000);
          }
          this.bus.publishStatus(event.status);
          return;
        }
      }
    });
  }

  /**
   * Begin following a symbol. Reference-counted, so the last chart to close a
   * symbol is the one that unsubscribes it.
   */
  async subscribe(symbol: string): Promise<void> {
    const spec = requireInstrument(symbol);
    const count = this.subscriberCounts.get(spec.root) ?? 0;
    this.subscriberCounts.set(spec.root, count + 1);
    if (count === 0) {
      this.provider.subscribe(spec.root);
      await this.warmup(spec);
    } else {
      await this.warmups.get(spec.root);
    }
  }

  unsubscribe(symbol: string): void {
    const root = symbol.toUpperCase();
    const count = this.subscriberCounts.get(root) ?? 0;
    if (count <= 1) {
      this.subscriberCounts.delete(root);
      this.provider.unsubscribe(root);
    } else {
      this.subscriberCounts.set(root, count - 1);
    }
  }

  /** Seed the aggregator with real recent history so live bars have context. */
  private warmup(spec: InstrumentSpec): Promise<void> {
    const existing = this.warmups.get(spec.root);
    if (existing) return existing;

    const task = (async () => {
      const agg = this.aggregatorFor(spec);
      const page = await this.bars.getBars({
        symbol: spec.root,
        timeframe: this.options.baseTimeframe,
        limit: this.options.historyWarmupBars,
      });
      agg.seed(page.bars);
    })();

    this.warmups.set(spec.root, task);
    return task;
  }

  aggregatorFor(spec: InstrumentSpec): CandleAggregator {
    let agg = this.aggregators.get(spec.root);
    if (!agg) {
      agg = new CandleAggregator(spec, { baseTimeframe: this.options.baseTimeframe });
      this.aggregators.set(spec.root, agg);
    }
    return agg;
  }

  /** Live updates for one symbol and timeframe. */
  onBar(symbol: string, timeframe: Timeframe, listener: (u: BarUpdate) => void): () => void {
    const spec = requireInstrument(symbol);
    return this.aggregatorFor(spec).subscribe(timeframe, listener);
  }

  onQuote(symbol: string, listener: (q: NormalizedQuote) => void): () => void {
    return this.bus.onQuote(symbol.toUpperCase(), listener);
  }

  onStatus(listener: (s: ConnectionStatus) => void): () => void {
    return this.bus.onStatus(listener);
  }

  /**
   * Bars for a chart: cached history, with the aggregator's live forming bar
   * merged on top so the handover produces no duplicate and no gap.
   */
  async getChartBars(query: BarQuery): Promise<BarPage> {
    const spec = requireInstrument(query.symbol);
    const page = await this.bars.getBars(query);

    // Only the newest page carries a forming bar.
    if (query.before !== undefined) return page;

    const agg = this.aggregators.get(spec.root);
    const forming = agg?.latest(query.timeframe);
    if (!forming) return page;

    // The live bucket is the one containing the EXCHANGE's latest timestamp. On
    // a delayed feed that is minutes behind the server clock, so using Date.now()
    // here would point at a bucket the market has not reached yet.
    const marketNow = this.quotes.getQuote(spec.root)?.exchangeTs ?? Date.now();
    const liveBucket = bucketStart(spec, marketNow, query.timeframe);
    if (forming.time !== liveBucket) return page;

    const merged = [...page.bars];
    const last = merged[merged.length - 1];

    if (last && last.time === forming.time) {
      // Combine rather than replace. The cached bar is the vendor's own
      // aggregate for this bucket and may hold volume and a range that the
      // aggregator's fine-bar window does not reach back far enough to see.
      merged[merged.length - 1] = {
        ...forming,
        open: last.open,
        high: Math.max(last.high, forming.high),
        low: Math.min(last.low, forming.low),
        volume: Math.max(last.volume, forming.volume),
        closed: false,
      };
    } else if (!last || forming.time > last.time) {
      merged.push(forming);
    }

    return { ...page, bars: merged };
  }

  getQuote(symbol: string): NormalizedQuote | null {
    return this.quotes.getQuote(symbol.toUpperCase());
  }

  /**
   * The most recently SETTLED base bar for a symbol.
   *
   * The execution engine uses a closed bar's high and low to fill orders the
   * quote stream never sampled. A forming bar is excluded deliberately: its
   * extremes are not final, and filling against a high that later turns out not
   * to have been the high would be filling on data that did not exist.
   */
  /** Length of the fine bars `lastClosedBar` returns, in ms. */
  baseBarMs(symbol: string): number {
    const agg = this.aggregators.get(symbol.toUpperCase());
    return timeframeMs(agg?.baseTimeframe ?? '1m');
  }

  lastClosedBar(symbol: string): NormalizedBar | null {
    const agg = this.aggregators.get(symbol.toUpperCase());
    if (!agg) return null;
    const fine = agg.fineSeries();
    for (let i = fine.length - 1; i >= 0; i -= 1) {
      const bar = fine[i]!;
      if (bar.closed) return bar;
    }
    return null;
  }

  markPrice(symbol: string): number | null {
    return this.quotes.markPrice(symbol.toUpperCase());
  }

  /**
   * The clock staleness is judged against.
   *
   * Wall clock for a live feed. For a REPLAY it is the playback position: a
   * recording of last Tuesday is not stale data, it is data from last Tuesday,
   * and judging it against the server clock would call every replayed quote
   * hours out of date and block order entry for the whole session.
   */
  freshness(symbol: string): Freshness {
    const root = symbol.toUpperCase();
    // Read the provider directly: `this.status` is only as current as the last
    // status EVENT, and a provider that has just been swapped in has not sent
    // one yet - which would judge a fresh replay against the server clock.
    const clock = freshnessClock(
      this.provider.getConnectionStatus(),
      this.quotes.getQuote(root)?.exchangeTs ?? null,
    );
    return this.quotes.freshness(requireInstrument(root), clock);
  }

  getConnectionStatus(): ConnectionStatus {
    return this.provider.getConnectionStatus();
  }

  symbolStatus(symbol: string): SymbolStatus {
    const spec = requireInstrument(symbol);
    return {
      symbol: spec.root,
      quote: this.getQuote(spec.root),
      freshness: this.freshness(spec.root),
      marketState: getMarketState(spec, Date.now()),
      activeAggregatorBars: this.aggregators.get(spec.root)?.fineBarCount ?? 0,
    };
  }

  subscribedSymbols(): string[] {
    return [...this.subscriberCounts.keys()];
  }

  /** Aggregator internals, for the diagnostics endpoint. */
  aggregatorDiagnostics(symbol: string): {
    exists: boolean;
    fineBars: number;
    subscribers: number;
    lastFine: NormalizedBar | null;
    latest1m: NormalizedBar | null;
  } {
    const root = symbol.toUpperCase();
    const agg = this.aggregators.get(root);
    if (!agg) {
      return { exists: false, fineBars: 0, subscribers: 0, lastFine: null, latest1m: null };
    }
    const fine = agg.fineSeries();
    return {
      exists: true,
      fineBars: fine.length,
      subscribers: this.subscriberCounts.get(root) ?? 0,
      lastFine: fine[fine.length - 1] ?? null,
      latest1m: agg.latest('1m'),
    };
  }

  /**
   * Persist the newest bar the aggregator has settled, so a restart does not
   * refetch the whole session.
   */
  async persistSettled(symbol: string, timeframe: Timeframe): Promise<number> {
    const spec = requireInstrument(symbol);
    const agg = this.aggregators.get(spec.root);
    if (!agg) return 0;
    const settled = agg.series(timeframe).filter((b) => b.closed);
    return this.bars.store(spec, timeframe, settled);
  }

  private async recordMeta(symbol: string, exchangeTs: number): Promise<void> {
    const spec = getInstrument(symbol);
    if (!spec) return;
    try {
      await this.db
        .insert(marketDataMeta)
        .values({
          symbol: spec.root,
          provider: this.provider.id,
          mode: this.provider.mode,
          delaySeconds: this.status.delaySeconds,
          lastEventAt: new Date(exchangeTs),
          lastMessageAt: new Date(),
          depthLevels: this.provider.depthLevels,
        })
        .onConflictDoUpdate({
          target: marketDataMeta.symbol,
          set: {
            provider: this.provider.id,
            mode: this.provider.mode,
            delaySeconds: this.status.delaySeconds,
            lastEventAt: new Date(exchangeTs),
            lastMessageAt: new Date(),
            depthLevels: this.provider.depthLevels,
            updatedAt: new Date(),
          },
        });
    } catch {
      // Provenance bookkeeping must never take the feed down.
    }
  }
}

export type { NormalizedBar };
