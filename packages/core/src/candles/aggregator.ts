/**
 * The candle aggregator.
 *
 * Holds one fine-granularity BarSeries per symbol and derives every requested
 * display timeframe from it by folding. Because the derived series is a pure
 * function of the fine series, a revised or duplicated source bar can never
 * produce a duplicated candle downstream.
 *
 * It also ingests trades, so that when a licensed tick feed replaces the Phase 1
 * bar feed the same code path builds the same candles.
 */
import type { InstrumentSpec, NormalizedBar, NormalizedTrade, Timeframe } from '@atlas/contracts';
import { BarSeries, type BarSource } from './series.js';
import { bucketEnd, bucketStart } from './timeframe.js';
import { foldBars, refoldBucket } from './fold.js';

export interface BarUpdate {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly bar: NormalizedBar;
  /** True when this update closed the previous bucket and opened a new one. */
  readonly rolled: boolean;
}

export type BarListener = (update: BarUpdate) => void;

export interface AggregatorOptions {
  /** Granularity of the bars fed in. Everything coarser is derived from it. */
  readonly baseTimeframe: Timeframe;
  /** Cap on retained fine bars, to bound memory. */
  readonly maxFineBars?: number;
}

export class CandleAggregator {
  private readonly fine: BarSeries;
  private readonly listeners = new Map<Timeframe, Set<BarListener>>();
  /** Last bucket time emitted per timeframe, used to detect a roll. */
  private readonly lastBucket = new Map<Timeframe, number>();
  /**
   * Freshest price print per forming bucket.
   *
   * A delayed feed republishes its bar array less often than its last price, so
   * within a forming bucket the print is newer than the bar's own close. Without
   * this, every republished bar would roll the live candle's close backwards to
   * a price the market has already left.
   */
  private readonly lastPrint = new Map<number, number>();
  private readonly maxFineBars: number;
  /**
   * Why prices did and did not reach the chart.
   *
   * Counted because "the chart barely moves" was a real complaint that took a
   * WebSocket capture to explain: the feed was delivering twelve prices a
   * minute and the chart was drawing one. Whichever of these refusals is
   * large is the answer, and without the counters it is guesswork.
   */
  readonly counters = {
    pricesIn: 0,
    priceRefusedClosedBucket: 0,
    priceRefusedStale: 0,
    priceRefusedUnchanged: 0,
    priceAccepted: 0,
    barsIn: 0,
    barRefusedUnchanged: 0,
    barAccepted: 0,
    emits: 0,
    emitNoListeners: 0,
    emitNoBar: 0,
  };

  constructor(
    readonly spec: InstrumentSpec,
    readonly options: AggregatorOptions,
  ) {
    this.fine = new BarSeries(spec.root);
    this.maxFineBars = options.maxFineBars ?? 40_000;
  }

  get baseTimeframe(): Timeframe {
    return this.options.baseTimeframe;
  }

  get fineBarCount(): number {
    return this.fine.size;
  }

  /** How many live subscribers there are, across all timeframes. */
  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  subscribe(tf: Timeframe, listener: BarListener): () => void {
    let set = this.listeners.get(tf);
    if (!set) {
      set = new Set();
      this.listeners.set(tf, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(tf);
    };
  }

  /**
   * Seed historical bars in bulk. Emits nothing: callers snapshot the series
   * afterwards rather than receiving thousands of individual updates.
   */
  seed(bars: readonly NormalizedBar[]): number {
    let added = 0;
    for (const bar of bars) {
      const aligned = this.align(bar);
      if (this.fine.upsert(aligned, 'HISTORY').changed) added += 1;
    }
    this.fine.trimTo(this.maxFineBars);
    return added;
  }

  /**
   * Ingest one fine bar, emitting derived updates for every subscribed
   * timeframe whose bucket the bar touches.
   */
  ingestBar(bar: NormalizedBar, source: BarSource = 'STREAM'): boolean {
    this.counters.barsIn += 1;
    const aligned = this.merge(this.align(bar));
    const result = this.fine.upsert(aligned, source);
    if (!result.changed) {
      this.counters.barRefusedUnchanged += 1;
      return false;
    }
    this.counters.barAccepted += 1;
    this.fine.trimTo(this.maxFineBars);
    this.emitFor(aligned.time);
    return true;
  }

  /**
   * Ingest a trade print. Builds or extends the fine bar containing it, which
   * then flows into every derived timeframe through the same path as bar data.
   */
  ingestTrade(trade: NormalizedTrade): boolean {
    const base = this.options.baseTimeframe;
    const time = bucketStart(this.spec, trade.exchangeTs, base);
    const existing = this.fine.get(time);

    const next: NormalizedBar = existing
      ? {
          ...existing,
          high: Math.max(existing.high, trade.price),
          low: Math.min(existing.low, trade.price),
          close: trade.price,
          volume: existing.volume + trade.size,
          closed: false,
        }
      : {
          symbol: this.spec.root,
          time,
          open: trade.price,
          high: trade.price,
          low: trade.price,
          close: trade.price,
          volume: trade.size,
          closed: false,
        };

    const result = this.fine.upsert(next, 'STREAM');
    if (!result.changed) return false;
    this.emitFor(time);
    return true;
  }

  /**
   * Close every bucket strictly older than `now`, so a series that stopped
   * receiving data still settles its last forming bar.
   */
  settleBefore(now: number): NormalizedBar[] {
    const settled: NormalizedBar[] = [];
    const base = this.options.baseTimeframe;
    const currentBucket = bucketStart(this.spec, now, base);
    for (const bar of this.fine.all()) {
      if (!bar.closed && bar.time < currentBucket) {
        const closedBar = { ...bar, closed: true };
        this.fine.upsert(closedBar, 'HISTORY');
        settled.push(closedBar);
      }
    }
    if (settled.length > 0) {
      for (const tf of this.listeners.keys()) this.emitTimeframe(tf, settled[0]!.time);
    }
    return settled;
  }

  /** Derived series for a timeframe, ascending. */
  series(tf: Timeframe, limit?: number): NormalizedBar[] {
    const folded = foldBars(this.spec, this.fine.all(), tf);
    if (limit === undefined || folded.length <= limit) return folded;
    return folded.slice(folded.length - limit);
  }

  /** Newest derived bar for a timeframe, which is the one still forming. */
  latest(tf: Timeframe): NormalizedBar | null {
    const fineLast = this.fine.last();
    if (!fineLast) return null;
    const time = bucketStart(this.spec, fineLast.time, tf);
    const end = bucketEnd(this.spec, fineLast.time, tf);
    return refoldBucket(this.spec, this.fine.range(time, end), time, end);
  }

  fineSeries(): NormalizedBar[] {
    return this.fine.all();
  }

  oldestFineTime(): number | null {
    return this.fine.first()?.time ?? null;
  }

  clear(): void {
    this.fine.clear();
    this.lastBucket.clear();
    this.lastPrint.clear();
  }

  /**
   * Update the forming bar from a price print that carries no size.
   *
   * A delayed feed publishes a last price more often than it republishes the
   * minute bar, so this keeps the live candle's close current without claiming
   * volume that was never reported.
   */
  ingestPrice(price: number, exchangeTs: number): boolean {
    if (!Number.isFinite(price)) return false;
    this.counters.pricesIn += 1;
    const time = bucketStart(this.spec, exchangeTs, this.options.baseTimeframe);
    const existing = this.fine.get(time);

    // A bucket the feed has already settled is not ours to reopen.
    if (existing?.closed) {
      this.counters.priceRefusedClosedBucket += 1;
      return false;
    }

    /*
     * A stale print does not open a bar in the past.
     *
     * A last price arrives with its own exchange timestamp, and feeds
     * re-publish old ones - a warm-up poll, a reconnect. Without this check a
     * single print stamped hours ago CREATED a bar in the middle of the
     * history: one price, no volume, drawn as an isolated candle wherever that
     * minute sat on the chart. A print older than the newest bucket is only
     * allowed to revise a bar that already exists; it never invents one.
     */
    const newest = this.fine.last();
    if (!existing && newest && time < newest.time) {
      this.counters.priceRefusedStale += 1;
      return false;
    }

    const next: NormalizedBar = existing
      ? {
          ...existing,
          high: Math.max(existing.high, price),
          low: Math.min(existing.low, price),
          close: price,
        }
      : {
          symbol: this.spec.root,
          time,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
          closed: false,
        };

    this.lastPrint.set(time, price);
    if (!this.fine.upsert(next, 'STREAM').changed) {
      this.counters.priceRefusedUnchanged += 1;
      return false;
    }
    this.counters.priceAccepted += 1;
    this.emitFor(time);
    return true;
  }

  /** Snap an incoming bar to the base bucket grid, so keys always agree. */
  private align(bar: NormalizedBar): NormalizedBar {
    const time = bucketStart(this.spec, bar.time, this.options.baseTimeframe);
    return time === bar.time ? bar : { ...bar, time };
  }

  /**
   * Reconcile a new reading of a bucket that is still forming.
   *
   * Within one forming bucket the high can only rise and the low can only fall,
   * so a fresh vendor snapshot must never shrink the range we have already
   * observed. Volume likewise only accumulates; taking the larger of the two
   * protects against a vendor republishing a partial count.
   *
   * THE OPEN IS THE FEED'S, NOT OURS. A price print can reach us before the
   * feed's bar for that minute does, and `ingestPrice` has to open a bucket
   * from it or the live candle would not move at all. But that open is the
   * first price ATLAS happened to see, not the minute's first trade, and the
   * audit caught the difference: at 22:08 gold's real open was 4387.50 and
   * Atlas was showing 4388.30, eight ticks away, on a candle a trader was
   * looking at. It corrected itself when the minute closed, which is why every
   * closed bar reconciles - and "wrong until it is too late to matter" is not
   * a standard. As soon as the feed has a bar for the bucket, that bar owns the
   * open and the print stream is left with the high, the low and the close.
   */
  private merge(bar: NormalizedBar): NormalizedBar {
    if (bar.closed) {
      // The feed has settled this bucket; its own close is final from here.
      this.lastPrint.delete(bar.time);
      return bar;
    }

    const existing = this.fine.get(bar.time);
    if (!existing || existing.closed) return bar;

    // A price print observed inside this bucket is newer than the bar snapshot
    // that carries it, so it wins the close.
    const print = this.lastPrint.get(bar.time);
    const close = print ?? bar.close;

    return {
      ...bar,
      open: bar.open,
      high: Math.max(existing.high, bar.high, close),
      low: Math.min(existing.low, bar.low, close),
      close,
      volume: Math.max(existing.volume, bar.volume),
    };
  }

  private emitFor(fineTime: number): void {
    if (this.listeners.size === 0) {
      this.counters.emitNoListeners += 1;
      return;
    }
    for (const tf of this.listeners.keys()) this.emitTimeframe(tf, fineTime);
  }

  private emitTimeframe(tf: Timeframe, fineTime: number): void {
    const listeners = this.listeners.get(tf);
    if (!listeners || listeners.size === 0) {
      this.counters.emitNoListeners += 1;
      return;
    }

    const time = bucketStart(this.spec, fineTime, tf);
    const end = bucketEnd(this.spec, fineTime, tf);
    const bar = refoldBucket(this.spec, this.fine.range(time, end), time, end);
    if (!bar) {
      this.counters.emitNoBar += 1;
      return;
    }

    const previous = this.lastBucket.get(tf);
    const rolled = previous !== undefined && previous !== time;
    this.lastBucket.set(tf, time);

    const update: BarUpdate = { symbol: this.spec.root, timeframe: tf, bar, rolled };
    this.counters.emits += 1;
    for (const listener of listeners) listener(update);
  }
}
