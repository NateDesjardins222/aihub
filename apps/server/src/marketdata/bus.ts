/**
 * Market event bus.
 *
 * Sits between the provider and every consumer, and is where ordering and
 * duplication are dealt with once rather than in each consumer:
 *
 *   - each symbol has a monotonic sequence number;
 *   - an event whose exchange timestamp regresses is dropped, so a reconnect
 *     replay cannot rewind a symbol's clock or double-count volume;
 *   - an event identical to the previous one is dropped.
 *
 * Bars are exempt from the timestamp-regression rule because a bar update for
 * the CURRENT bucket legitimately repeats its own open time.
 */
import { EventEmitter } from 'node:events';
import { getInstrument } from '@atlas/instruments';
import { PriceIntegrity } from './price-integrity.js';
import { LatencyRecorder } from './latency.js';
import type {
  ConnectionStatus,
  NormalizedBar,
  NormalizedDepth,
  NormalizedQuote,
  NormalizedTrade,
} from '@atlas/contracts';

export interface MarketEventMap {
  quote: NormalizedQuote;
  trade: NormalizedTrade;
  bar: NormalizedBar;
  depth: NormalizedDepth;
  status: ConnectionStatus;
}

export interface BusStats {
  published: number;
  droppedOutOfOrder: number;
  droppedDuplicate: number;
  /** Prices held back as uncorroborated outliers, and ones refused outright. */
  droppedQuarantined: number;
  droppedRejected: number;
  bySymbol: Record<string, number>;
}

interface SymbolClock {
  lastQuoteTs: number;
  lastTradeTs: number;
  lastTradeSeq: number;
  seq: number;
}

export class MarketEventBus {
  private readonly emitter = new EventEmitter();
  private readonly clocks = new Map<string, SymbolClock>();
  private readonly stats: BusStats = {
    published: 0,
    droppedOutOfOrder: 0,
    droppedDuplicate: 0,
    droppedQuarantined: 0,
    droppedRejected: 0,
    bySymbol: {},
  };

  /**
   * The price integrity gate.
   *
   * Every quote and bar passes through here, which is the only place that can
   * see a symbol's whole stream. A price that cannot be corroborated is not
   * published at all: it never reaches the aggregator that would draw a candle
   * at it, nor the quote store that would mark a position with it.
   */
  readonly integrity = new PriceIntegrity();

  /**
   * How long each observation took to get here, and to get out again.
   *
   * On the bus because the bus is the one place every observation passes
   * through, and because the socket gateway needs to close the measurement out
   * on the same object the provider opened it on.
   */
  readonly latency = new LatencyRecorder();

  constructor() {
    // Many charts and many accounts can watch one symbol.
    this.emitter.setMaxListeners(0);
  }

  private clock(symbol: string): SymbolClock {
    let c = this.clocks.get(symbol);
    if (!c) {
      c = { lastQuoteTs: 0, lastTradeTs: 0, lastTradeSeq: -1, seq: 0 };
      this.clocks.set(symbol, c);
    }
    return c;
  }

  /** Next sequence number for a symbol's stream. */
  nextSeq(symbol: string): number {
    const c = this.clock(symbol);
    c.seq += 1;
    return c.seq;
  }

  currentSeq(symbol: string): number {
    return this.clock(symbol).seq;
  }

  publishQuote(quote: NormalizedQuote): boolean {
    const c = this.clock(quote.symbol);
    if (quote.exchangeTs < c.lastQuoteTs) {
      this.stats.droppedOutOfOrder += 1;
      return false;
    }
    if (quote.exchangeTs === c.lastQuoteTs) {
      this.stats.droppedDuplicate += 1;
      return false;
    }
    const spec = getInstrument(quote.symbol);
    // The price this quote would mark a position at: the last trade, else the
    // mid of a real, two-sided, uncrossed book. A quote carrying only bid/ask
    // used to skip integrity entirely and then mark positions off an unchecked
    // (bid+ask)/2 — the mid-only bypass. Gate whatever would actually be used.
    const markable =
      quote.last != null
        ? quote.last
        : quote.bid != null && quote.ask != null && quote.bid <= quote.ask
          ? (quote.bid + quote.ask) / 2
          : null;
    if (spec && markable != null) {
      const verdict = this.integrity.check(spec, markable, quote.exchangeTs);
      if (verdict !== 'ACCEPT') {
        if (verdict === 'QUARANTINE') this.stats.droppedQuarantined += 1;
        else this.stats.droppedRejected += 1;
        // The clock is NOT advanced: a held price must not make the next,
        // believable one look out of order.
        return false;
      }
    }

    c.lastQuoteTs = quote.exchangeTs;
    this.record(quote.symbol);
    this.latency.markPublished(quote);
    this.emitter.emit('quote', quote);
    this.emitter.emit(`quote:${quote.symbol}`, quote);
    return true;
  }

  publishTrade(trade: NormalizedTrade): boolean {
    const c = this.clock(trade.symbol);
    if (trade.seq <= c.lastTradeSeq) {
      this.stats.droppedDuplicate += 1;
      return false;
    }
    if (trade.exchangeTs < c.lastTradeTs) {
      this.stats.droppedOutOfOrder += 1;
      return false;
    }
    c.lastTradeSeq = trade.seq;
    c.lastTradeTs = trade.exchangeTs;
    this.record(trade.symbol);
    this.emitter.emit('trade', trade);
    this.emitter.emit(`trade:${trade.symbol}`, trade);
    return true;
  }

  /**
   * Bars are published unconditionally: the aggregator owns bar identity by
   * bucket time, and a repeated bucket time is a legitimate revision of the
   * forming candle rather than an out-of-order event.
   */
  publishBar(bar: NormalizedBar): boolean {
    const spec = getInstrument(bar.symbol);
    if (spec) {
      const verdict = this.integrity.checkBar(spec, bar);
      if (verdict !== 'ACCEPT') {
        if (verdict === 'QUARANTINE') this.stats.droppedQuarantined += 1;
        else this.stats.droppedRejected += 1;
        return false;
      }
    }
    this.record(bar.symbol);
    this.latency.markPublished(bar);
    this.emitter.emit('bar', bar);
    this.emitter.emit(`bar:${bar.symbol}`, bar);
    return true;
  }

  publishDepth(depth: NormalizedDepth): boolean {
    this.record(depth.symbol);
    this.emitter.emit('depth', depth);
    this.emitter.emit(`depth:${depth.symbol}`, depth);
    return true;
  }

  publishStatus(status: ConnectionStatus): void {
    this.emitter.emit('status', status);
  }

  onQuote(symbol: string, listener: (q: NormalizedQuote) => void): () => void {
    return this.listen(`quote:${symbol}`, listener);
  }
  onTrade(symbol: string, listener: (t: NormalizedTrade) => void): () => void {
    return this.listen(`trade:${symbol}`, listener);
  }
  onBar(symbol: string, listener: (b: NormalizedBar) => void): () => void {
    return this.listen(`bar:${symbol}`, listener);
  }
  onDepth(symbol: string, listener: (d: NormalizedDepth) => void): () => void {
    return this.listen(`depth:${symbol}`, listener);
  }
  onStatus(listener: (s: ConnectionStatus) => void): () => void {
    return this.listen('status', listener);
  }
  onAnyQuote(listener: (q: NormalizedQuote) => void): () => void {
    return this.listen('quote', listener);
  }
  onAnyBar(listener: (b: NormalizedBar) => void): () => void {
    return this.listen('bar', listener);
  }

  private listen(event: string, listener: (...args: never[]) => void): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  private record(symbol: string): void {
    this.stats.published += 1;
    this.stats.bySymbol[symbol] = (this.stats.bySymbol[symbol] ?? 0) + 1;
  }

  getStats(): BusStats {
    return { ...this.stats, bySymbol: { ...this.stats.bySymbol } };
  }

  /** Forget a symbol's ordering state, e.g. when a replay seeks backwards. */
  resetSymbol(symbol: string): void {
    this.clocks.delete(symbol);
  }

  resetAll(): void {
    this.integrity.clear();
    this.clocks.clear();
  }
}
