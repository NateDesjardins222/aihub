/**
 * Test harness for the trading engine.
 *
 * Provides a scripted market and a real PostgreSQL database, so integration
 * tests exercise the genuine persistence and transaction paths rather than a
 * mock of them. The market is scripted rather than mocked: prices are set
 * explicitly by the test, which is the only way to assert what a fill should be.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { NormalizedBar, NormalizedQuote } from '@atlas/contracts';
import { requireInstrument, ticksToPrice } from '@atlas/instruments';
import type { SimulationEnvironment } from '@atlas/core';
import { createDb, type Database } from '../db/client.js';
import { accounts, ruleTemplates, users } from '../db/schema.js';
import type { Freshness } from '../marketdata/quote-store.js';
import type { MarketView } from './engine.js';

type QuoteListener = (q: NormalizedQuote) => void;
type BarListener = (b: NormalizedBar) => void;

/**
 * A market whose prices the test sets directly.
 *
 * Note it stores DECIMAL prices, exactly as the real quote store does, so the
 * engine's tick conversion is exercised rather than bypassed.
 */
export class ScriptedMarket implements MarketView {
  private readonly quotes = new Map<string, NormalizedQuote>();
  private readonly bars = new Map<string, NormalizedBar>();
  private readonly quoteListeners = new Set<QuoteListener>();
  private readonly barListeners = new Set<BarListener>();
  private seq = 0;
  private stale = false;
  private frozenAgeMs: number | null = null;

  readonly bus = {
    onAnyQuote: (listener: QuoteListener): (() => void) => {
      this.quoteListeners.add(listener);
      return () => this.quoteListeners.delete(listener);
    },
    onAnyBar: (listener: BarListener): (() => void) => {
      this.barListeners.add(listener);
      return () => this.barListeners.delete(listener);
    },
  };

  /** Set the last traded price and notify anything following the symbol. */
  async quote(symbol: string, price: number, exchangeTs = OPEN_MARKET_TS): Promise<void> {
    this.seq += 1;
    const q: NormalizedQuote = {
      symbol,
      exchangeTs,
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      last: price,
      lastSize: null,
      seq: this.seq,
      synthesizedBook: false,
    };
    this.quotes.set(symbol, q);
    for (const listener of this.quoteListeners) listener(q);
    await settle();
  }

  /** Publish a settled bar, whose extremes the engine may fill against. */
  async bar(
    symbol: string,
    ohlc: { open: number; high: number; low: number; close: number; volume?: number },
    exchangeTs = OPEN_MARKET_TS,
  ): Promise<void> {
    const bar: NormalizedBar = {
      symbol,
      time: exchangeTs,
      open: ohlc.open,
      high: ohlc.high,
      low: ohlc.low,
      close: ohlc.close,
      volume: ohlc.volume ?? 100,
      closed: true,
    };
    this.bars.set(symbol, bar);
    // A bar's close is also the latest price.
    await this.quote(symbol, ohlc.close, exchangeTs);
    for (const listener of this.barListeners) listener(bar);
    await settle();
  }

  setStale(stale: boolean): void {
    this.stale = stale;
  }

  /**
   * Report the feed as frozen: the server's clock says the session is shut, so
   * the state reads MARKET_CLOSED, while the quote itself is far past the age
   * the feed promises. This is what a live delayed feed looks like for the ten
   * minutes after a session break begins.
   */
  setFrozen(ageMs: number | null): void {
    this.frozenAgeMs = ageMs;
  }

  getQuote(symbol: string): NormalizedQuote | null {
    return this.quotes.get(symbol) ?? null;
  }

  markPrice(symbol: string): number | null {
    return this.quotes.get(symbol)?.last ?? null;
  }

  lastClosedBar(symbol: string): NormalizedBar | null {
    return this.bars.get(symbol) ?? null;
  }

  /** The scripted bars are one-minute bars, like the live fine series. */
  baseBarMs(): number {
    return 60_000;
  }

  freshness(symbol: string): Freshness {
    const quote = this.quotes.get(symbol);
    if (this.frozenAgeMs !== null && quote) {
      return {
        symbol,
        state: 'MARKET_CLOSED',
        ageMs: this.frozenAgeMs,
        excessMs: this.frozenAgeMs - 120_000,
        thresholdMs: 120_000,
        lastExchangeTs: quote.exchangeTs,
        lastReceivedAt: Date.now(),
        blocksOrderEntry: true,
      };
    }
    return {
      symbol,
      state: this.stale ? 'STALE' : quote ? 'FRESH' : 'NO_DATA',
      ageMs: 0,
      excessMs: 0,
      thresholdMs: 120_000,
      lastExchangeTs: quote?.exchangeTs ?? null,
      lastReceivedAt: Date.now(),
      blocksOrderEntry: this.stale || !quote,
    };
  }

  /** Clear the bar so a later quote-only observation is genuinely quote-only. */
  clearBar(symbol: string): void {
    this.bars.delete(symbol);
  }
}

/**
 * A known-open instant: Tuesday 15 September 2026, 10:00 CT.
 *
 * Scripted market events are stamped with this rather than the wall clock, so
 * the suite does not pass or fail depending on whether the real CME happens to
 * be inside its 15:15-15:30 equity-index halt when the tests run.
 */
export const OPEN_MARKET_TS = Date.UTC(2026, 8, 15, 15, 0, 0);

/** Let queued microtasks and the engine's async work drain. */
export function settle(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TestFixture {
  readonly db: Database;
  readonly accountId: string;
  readonly userId: string;
  readonly close: () => Promise<void>;
}

/**
 * Create an isolated account on the shared test database.
 *
 * Each fixture gets its own user and account, so tests can run without
 * interfering with one another and without truncating shared tables.
 */
export async function createFixture(options?: {
  environment?: Partial<SimulationEnvironment>;
  maxContracts?: number;
  startingBalanceMicros?: number;
}): Promise<TestFixture> {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  const { db, sql } = createDb(url);

  const suffix = randomUUID().slice(0, 8);
  const [user] = await db
    .insert(users)
    .values({
      email: `engine-${suffix}@test.local`,
      passwordHash: 'not-used',
      displayName: 'Engine Test',
    })
    .returning();

  const size = options?.startingBalanceMicros ?? 100_000 * 1_000_000;
  const [template] = await db
    .insert(ruleTemplates)
    .values({
      name: `Engine Test ${suffix}`,
      accountType: 'PRACTICE',
      accountSizeMicros: size,
      profitTargetMicros: 1_000_000 * 1_000_000,
      maxLossMicros: size,
      drawdownType: 'STATIC',
      trailingLockAtMicros: null,
      dailyLossLimitMicros: null,
      consistencyFormula: 'BEST_DAY_OVER_TOTAL',
      consistencyThreshold: null,
      maxContracts: options?.maxContracts ?? 50,
      microsCountAsFraction: false,
      minTradingDays: 0,
      maxTradingDays: null,
      minDailyPnlToCountMicros: 0,
      payoutRules: {},
    })
    .returning();

  const [account] = await db
    .insert(accounts)
    .values({
      userId: user!.id,
      ruleTemplateId: template!.id,
      name: `Engine Test ${suffix}`,
      accountType: 'PRACTICE',
      status: 'ACTIVE',
      startingBalanceMicros: size,
      balanceMicros: size,
      highWaterMarkMicros: size,
      drawdownFloorMicros: 0,
      dayStartBalanceMicros: size,
      dayStartEquityMicros: size,
      simulationEnvironment: (options?.environment ?? null) as never,
    })
    .returning();

  return {
    db,
    accountId: account!.id,
    userId: user!.id,
    close: async () => {
      await db.delete(accounts).where(eq(accounts.id, account!.id));
      await db.delete(ruleTemplates).where(eq(ruleTemplates.id, template!.id));
      await db.delete(users).where(eq(users.id, user!.id));
      await sql.end({ timeout: 5 });
    },
  };
}

/** Round-trip a decimal price through the instrument's tick grid. */
export function atTick(symbol: string, price: number): number {
  const spec = requireInstrument(symbol);
  return ticksToPrice(spec, Math.round(price / (spec.tickSizeScaled / 10 ** spec.pricePrecision)));
}
