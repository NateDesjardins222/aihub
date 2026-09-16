/**
 * Historical bar service.
 *
 * Serves bars from a PostgreSQL cache and falls back to the provider for spans
 * the cache does not hold, so scrolling left in the chart pulls genuinely older
 * market data instead of re-serving one fixed window.
 *
 * Only CLOSED bars are cached. A forming bar is by definition not final, and
 * persisting it would freeze a partial candle into history.
 */
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { InstrumentSpec, NormalizedBar, Timeframe } from '@atlas/contracts';
import { priceToTicks, requireInstrument, ticksToPrice } from '@atlas/instruments';
import { TIMEFRAME_MS, foldBars, isCalendarTimeframe } from '@atlas/core';
import type { Database } from '../db/client.js';
import { historicalBars } from '../db/schema.js';
import type { MarketDataProvider } from './provider.js';

/** Nominal bar length, used only to size fetch windows. */
function nominalBarMs(tf: Timeframe): number {
  if (tf === '1D') return 86_400_000;
  if (tf === '1W') return 7 * 86_400_000;
  if (tf === '1M') return 30 * 86_400_000;
  return TIMEFRAME_MS[tf];
}

export interface BarPage {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly bars: readonly NormalizedBar[];
  /** True when older bars are believed to exist and can be requested. */
  readonly hasMore: boolean;
  /** Pass as `before` to fetch the next page going backwards. */
  readonly nextCursor: number | null;
  /** Set when the provider, not the cache, is what limits the depth. */
  readonly limitReason: string | null;
  readonly source: 'CACHE' | 'PROVIDER' | 'MIXED';
}

export interface BarQuery {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly limit?: number;
  /** Exclusive upper bound for pagination: return bars strictly before this. */
  readonly before?: number;
}

const DEFAULT_LIMIT = 1_500;
const MAX_LIMIT = 20_000;

export class BarService {
  /** Guards against two concurrent requests fetching the same window twice. */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly provider: MarketDataProvider,
  ) {}

  /**
   * The persistent cache holds bars from the LIVE feed. A replay is a different
   * point in market time, so mixing the two would draw today's real prices onto
   * a chart that says it is replaying a past session. Replay therefore reads
   * straight from the provider and writes nothing back.
   */
  private get cacheable(): boolean {
    return this.provider.mode !== 'REPLAY';
  }

  async getBars(query: BarQuery): Promise<BarPage> {
    const spec = requireInstrument(query.symbol);
    const tf = query.timeframe;
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const before = query.before ?? Number.MAX_SAFE_INTEGER;

    if (!this.cacheable) return this.getUncachedBars(spec, tf, limit, before);

    let cached = await this.readCache(spec, tf, limit, before);
    let source: BarPage['source'] = 'CACHE';

    // Fetch from the vendor when the cache cannot satisfy the page. Asking for
    // one extra bar tells us whether older data exists at all.
    if (cached.length < limit) {
      const fetched = await this.fill(spec, tf, limit, before);
      if (fetched) {
        source = cached.length === 0 ? 'PROVIDER' : 'MIXED';
        cached = await this.readCache(spec, tf, limit, before);
      }
    }

    const oldest = cached[0]?.time ?? null;
    const providerLimit = this.providerLookbackDays(tf);
    const reachedProviderFloor =
      oldest !== null && Date.now() - oldest > providerLimit * 86_400_000 * 0.98;

    return {
      symbol: spec.root,
      timeframe: tf,
      bars: cached,
      hasMore: cached.length >= limit && !reachedProviderFloor,
      nextCursor: oldest,
      limitReason: reachedProviderFloor
        ? `Development feed serves at most ${providerLimit} days of ${tf} history.`
        : null,
      source,
    };
  }

  /** Serve directly from the provider, bypassing the live-data cache entirely. */
  private async getUncachedBars(
    spec: InstrumentSpec,
    tf: Timeframe,
    limit: number,
    before: number,
  ): Promise<BarPage> {
    const raw = await this.provider.getHistoricalBars({ symbol: spec.root, timeframe: tf });
    const folded = foldBars(spec, raw, tf).filter((b) => b.time < before);
    const bars = folded.slice(Math.max(0, folded.length - limit));
    return {
      symbol: spec.root,
      timeframe: tf,
      bars,
      hasMore: folded.length > bars.length,
      nextCursor: bars[0]?.time ?? null,
      limitReason:
        bars.length === 0
          ? 'The replay has not emitted any bars yet. Press play.'
          : 'Replaying a recorded session: history is limited to what the replay has emitted.',
      source: 'PROVIDER',
    };
  }

  /** Newest cached bar time, or null. Used to decide what to backfill. */
  async newestCachedTime(symbol: string, tf: Timeframe): Promise<number | null> {
    const [row] = await this.db
      .select({ t: sql<number>`max(${historicalBars.barTime})` })
      .from(historicalBars)
      .where(and(eq(historicalBars.symbol, symbol), eq(historicalBars.timeframe, tf)));
    return row?.t ?? null;
  }

  /** Persist closed bars. Existing buckets are revised, never duplicated. */
  async store(spec: InstrumentSpec, tf: Timeframe, bars: readonly NormalizedBar[]): Promise<number> {
    const closed = bars.filter((b) => b.closed);
    if (closed.length === 0) return 0;

    const rows = closed.map((b) => ({
      symbol: spec.root,
      timeframe: tf,
      barTime: b.time,
      open: priceToTicks(spec, b.open),
      high: priceToTicks(spec, b.high),
      low: priceToTicks(spec, b.low),
      close: priceToTicks(spec, b.close),
      volume: b.volume,
      provider: this.provider.id,
    }));

    // Chunked, because a session of 1m bars can exceed the parameter limit.
    const CHUNK = 500;
    let written = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await this.db
        .insert(historicalBars)
        .values(chunk)
        .onConflictDoUpdate({
          target: [historicalBars.symbol, historicalBars.timeframe, historicalBars.barTime],
          set: {
            open: sql`excluded.open_ticks`,
            high: sql`excluded.high_ticks`,
            low: sql`excluded.low_ticks`,
            close: sql`excluded.close_ticks`,
            volume: sql`excluded.volume`,
            updatedAt: new Date(),
          },
        });
      written += chunk.length;
    }
    return written;
  }

  private async readCache(
    spec: InstrumentSpec,
    tf: Timeframe,
    limit: number,
    before: number,
  ): Promise<NormalizedBar[]> {
    const rows = await this.db
      .select()
      .from(historicalBars)
      .where(
        and(
          eq(historicalBars.symbol, spec.root),
          eq(historicalBars.timeframe, tf),
          lt(historicalBars.barTime, before),
        ),
      )
      .orderBy(desc(historicalBars.barTime))
      .limit(limit);

    return rows
      .map((r) => ({
        symbol: spec.root,
        time: r.barTime,
        open: ticksToPrice(spec, r.open),
        high: ticksToPrice(spec, r.high),
        low: ticksToPrice(spec, r.low),
        close: ticksToPrice(spec, r.close),
        volume: r.volume,
        closed: true,
      }))
      .reverse();
  }

  /**
   * Fetch a window from the provider, fold it to the requested timeframe and
   * cache it. Concurrent callers for the same window share one fetch.
   */
  private async fill(
    spec: InstrumentSpec,
    tf: Timeframe,
    limit: number,
    before: number,
  ): Promise<boolean> {
    const to = before === Number.MAX_SAFE_INTEGER ? Date.now() : before;
    // Overshoot: sessions have gaps, so N bars span more than N bar-lengths.
    const span = nominalBarMs(tf) * limit * (isCalendarTimeframe(tf) ? 2.2 : 1.9);
    const from = to - span;

    const key = `${spec.root}:${tf}:${Math.floor(from / 60_000)}:${Math.floor(to / 60_000)}`;
    const existing = this.inflight.get(key);
    if (existing) {
      await existing;
      return true;
    }

    const task = (async () => {
      const raw = await this.provider.getHistoricalBars({
        symbol: spec.root,
        timeframe: tf,
        from,
        to,
      });
      if (raw.length === 0) return;

      // Whether a bucket is settled is decided upstream, against the EXCHANGE
      // clock, and folding propagates it: a bucket is closed only when every
      // bar inside it is. Re-deriving it from the server clock here would mark
      // the still-forming bucket of a delayed feed as final and freeze a
      // partial candle into the cache. store() persists closed bars only.
      const folded = foldBars(spec, raw, tf);
      await this.store(spec, tf, folded);
    })();

    this.inflight.set(key, task);
    try {
      await task;
      return true;
    } catch {
      return false;
    } finally {
      this.inflight.delete(key);
    }
  }

  private providerLookbackDays(tf: Timeframe): number {
    const provider = this.provider as { maxLookbackDays?: (tf: Timeframe) => number };
    return provider.maxLookbackDays?.(tf) ?? 3_650;
  }

  /** Count cached bars, for diagnostics. */
  async cacheStats(): Promise<Array<{ symbol: string; timeframe: string; bars: number }>> {
    const rows = await this.db
      .select({
        symbol: historicalBars.symbol,
        timeframe: historicalBars.timeframe,
        bars: sql<number>`count(*)::int`,
      })
      .from(historicalBars)
      .groupBy(historicalBars.symbol, historicalBars.timeframe)
      .orderBy(asc(historicalBars.symbol));
    return rows;
  }
}

/** Re-exported so callers can size windows without importing core directly. */
export { nominalBarMs, gte };
