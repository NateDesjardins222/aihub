/**
 * Tick / quote store and staleness clock.
 *
 * Staleness is measured against the feed's EXPECTED delay, not against zero: a
 * 10-minute delayed feed is 10 minutes behind by design, and calling that stale
 * would disable order entry permanently. What matters is whether the feed has
 * stopped advancing relative to its own delay.
 *
 * When the market is closed there is nothing to be late for, so the store
 * reports MARKET_CLOSED rather than STALE. Telling a trader their data is broken
 * at 3am on a Saturday would be wrong.
 */
import type {
  ConnectionStatus,
  InstrumentSpec,
  NormalizedQuote,
  NormalizedTrade,
} from '@atlas/contracts';
import { getMarketState } from '@atlas/instruments';

export type FreshnessState = 'FRESH' | 'STALE' | 'MARKET_CLOSED' | 'NO_DATA';

/**
 * The clock a symbol's freshness is judged against.
 *
 * Live feeds are judged against the server clock: the quote should be no older
 * than the delay the provider declares. A REPLAY is judged against the
 * recording itself - a session from last Tuesday is not late data, it is data
 * from last Tuesday, and measuring it against today would block order entry for
 * the whole replay. A symbol the recording does not carry has no quote, which
 * reports as NO_DATA rather than as stale.
 */
export function freshnessClock(
  status: Pick<ConnectionStatus, 'mode'> & { lastEventAt: number | null },
  quoteExchangeTs: number | null,
  now = Date.now(),
): number {
  if (status.mode !== 'REPLAY') return now;
  return quoteExchangeTs ?? status.lastEventAt ?? now;
}

export interface Freshness {
  readonly symbol: string;
  readonly state: FreshnessState;
  /** Age of the newest exchange timestamp, in ms, relative to wall clock. */
  readonly ageMs: number | null;
  /** How far beyond the feed's expected delay that age is. */
  readonly excessMs: number | null;
  readonly thresholdMs: number;
  readonly lastExchangeTs: number | null;
  readonly lastReceivedAt: number | null;
  /** True when order entry must be blocked. */
  readonly blocksOrderEntry: boolean;
}

export interface QuoteStoreOptions {
  /** The feed's declared delay in ms. Quotes are expected to be this old. */
  readonly expectedDelayMs: number;
  /** Additional tolerance before the feed is considered stale. */
  readonly toleranceMs: number;
  /** How many recent trades to retain per symbol. */
  readonly tradeBufferSize?: number;
}

export class QuoteStore {
  private readonly quotes = new Map<string, NormalizedQuote>();
  private readonly receivedAt = new Map<string, number>();
  private readonly trades = new Map<string, NormalizedTrade[]>();
  private readonly bufferSize: number;

  constructor(private options: QuoteStoreOptions) {
    this.bufferSize = options.tradeBufferSize ?? 500;
  }

  setExpectedDelayMs(ms: number): void {
    this.options = { ...this.options, expectedDelayMs: ms };
  }

  get expectedDelayMs(): number {
    return this.options.expectedDelayMs;
  }

  putQuote(quote: NormalizedQuote, now = Date.now()): void {
    this.quotes.set(quote.symbol, quote);
    this.receivedAt.set(quote.symbol, now);
  }

  putTrade(trade: NormalizedTrade, now = Date.now()): void {
    let buffer = this.trades.get(trade.symbol);
    if (!buffer) {
      buffer = [];
      this.trades.set(trade.symbol, buffer);
    }
    buffer.push(trade);
    if (buffer.length > this.bufferSize) buffer.splice(0, buffer.length - this.bufferSize);
    this.receivedAt.set(trade.symbol, now);
  }

  getQuote(symbol: string): NormalizedQuote | null {
    return this.quotes.get(symbol) ?? null;
  }

  getTrades(symbol: string): readonly NormalizedTrade[] {
    return this.trades.get(symbol) ?? [];
  }

  /**
   * The price the simulation engine should mark against.
   *
   * Prefers the last trade. Falls back to the mid only when a real book exists —
   * it never manufactures a bid/ask from a last price.
   */
  markPrice(symbol: string): number | null {
    const quote = this.quotes.get(symbol);
    if (!quote) return null;
    if (quote.last != null) return quote.last;
    if (quote.bid != null && quote.ask != null) return (quote.bid + quote.ask) / 2;
    return null;
  }

  freshness(spec: InstrumentSpec, now = Date.now()): Freshness {
    const symbol = spec.root;
    const quote = this.quotes.get(symbol);
    const thresholdMs = this.options.expectedDelayMs + this.options.toleranceMs;
    const marketOpen = getMarketState(spec, now).state === 'OPEN';

    if (!quote) {
      return {
        symbol,
        state: 'NO_DATA',
        ageMs: null,
        excessMs: null,
        thresholdMs,
        lastExchangeTs: null,
        lastReceivedAt: null,
        // No data at all means nothing to price an order against.
        blocksOrderEntry: true,
      };
    }

    const ageMs = now - quote.exchangeTs;
    const excessMs = ageMs - this.options.expectedDelayMs;

    if (!marketOpen) {
      return {
        symbol,
        state: 'MARKET_CLOSED',
        ageMs,
        excessMs,
        thresholdMs,
        lastExchangeTs: quote.exchangeTs,
        lastReceivedAt: this.receivedAt.get(symbol) ?? null,
        blocksOrderEntry: true,
      };
    }

    const stale = ageMs > thresholdMs;
    return {
      symbol,
      state: stale ? 'STALE' : 'FRESH',
      ageMs,
      excessMs,
      thresholdMs,
      lastExchangeTs: quote.exchangeTs,
      lastReceivedAt: this.receivedAt.get(symbol) ?? null,
      blocksOrderEntry: stale,
    };
  }

  symbols(): string[] {
    return [...this.quotes.keys()];
  }

  clear(): void {
    this.quotes.clear();
    this.trades.clear();
    this.receivedAt.clear();
  }
}
