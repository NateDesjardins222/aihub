/**
 * Rithmic market-data service (Milestone 9).
 *
 * Subscribes symbols on the TICKER plant, normalizes LastTrade / BestBidOffer into
 * Atlas canonical events, tracks freshness per symbol, and fetches historical bars
 * from the HISTORY plant. It emits only real provider observations; it never
 * fabricates a price or a bar. Subscriptions are restored on reconnect.
 */
import type { NormalizedBar, NormalizedQuote, NormalizedTrade, Timeframe } from '@atlas/contracts';
import type { RithmicPlant } from './plant.js';
import type { RithmicCodec } from '../protocol/codec.js';
import { rithmicCodec } from '../protocol/codec.js';
import { FreshnessTracker, type FreshnessSnapshot } from '../domain/freshness.js';
import { normalizeBBO, normalizeLastTrade, normalizeTimeBar, timeframeToRithmicBar } from '../domain/market-normalize.js';

export type MarketEvent =
  | { readonly kind: 'trade'; readonly trade: NormalizedTrade; readonly observedAt: number }
  | { readonly kind: 'quote'; readonly quote: NormalizedQuote; readonly observedAt: number };

export type MarketEventListener = (e: MarketEvent) => void;

const DEFAULT_UPDATE_BITS = ['LAST_TRADE', 'BBO', 'OPEN', 'HIGH_LOW', 'CLOSE', 'MARKET_MODE', 'SETTLEMENT'] as const;

interface Subscription {
  readonly root: string;
  readonly symbol: string;
  readonly exchange: string;
}

export class RithmicMarketDataService {
  private readonly codec: RithmicCodec;
  private readonly subs = new Map<string, Subscription>(); // key: symbol
  private readonly freshness = new Map<string, FreshnessTracker>();
  private readonly listeners = new Set<MarketEventListener>();
  private seq = 0;
  private routerUnsub: Array<() => void> = [];

  constructor(
    private ticker: RithmicPlant,
    private readonly history: RithmicPlant | null,
    private readonly opts: { now?: () => number; staleThresholdMs?: number } = {},
  ) {
    this.codec = rithmicCodec();
    this.attach(ticker);
  }

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  private attach(ticker: RithmicPlant): void {
    this.routerUnsub.forEach((u) => u());
    this.routerUnsub = [
      ticker.router.on('LastTrade', (m) => this.onLastTrade(m.message)),
      ticker.router.on('BestBidOffer', (m) => this.onBBO(m.message)),
    ];
  }

  on(listener: MarketEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private updateBitsMask(): number {
    let mask = 0;
    for (const name of DEFAULT_UPDATE_BITS) {
      try { mask |= this.codec.enumValue('RequestMarketDataUpdate', 'UpdateBits', name); } catch { /* skip unknown bit */ }
    }
    return mask;
  }

  /** Subscribe a symbol on the ticker plant. Idempotent per symbol. */
  subscribe(sub: Subscription): void {
    this.subs.set(sub.symbol, sub);
    if (!this.freshness.has(sub.symbol)) {
      this.freshness.set(sub.symbol, new FreshnessTracker(sub.symbol, this.opts.staleThresholdMs ?? 5_000, () => this.now()));
    }
    const req = this.codec.enumValue('RequestMarketDataUpdate', 'Request', 'SUBSCRIBE');
    this.ticker.send('RequestMarketDataUpdate', {
      symbol: sub.symbol, exchange: sub.exchange, request: req, update_bits: this.updateBitsMask(),
      user_msg: [`md-sub-${sub.symbol}`],
    });
  }

  unsubscribe(symbol: string): void {
    const sub = this.subs.get(symbol);
    if (!sub) return;
    this.subs.delete(symbol);
    const req = this.codec.enumValue('RequestMarketDataUpdate', 'Request', 'UNSUBSCRIBE');
    try {
      this.ticker.send('RequestMarketDataUpdate', { symbol: sub.symbol, exchange: sub.exchange, request: req, update_bits: this.updateBitsMask() });
    } catch { /* transport may be down; restore handles it */ }
  }

  /** Re-send every active subscription — called from the plant's onAuthenticated. */
  restoreSubscriptions(ticker?: RithmicPlant): void {
    if (ticker && ticker !== this.ticker) { this.ticker = ticker; this.attach(ticker); }
    for (const t of this.freshness.values()) t.noteReconnect();
    for (const sub of this.subs.values()) {
      try {
        const req = this.codec.enumValue('RequestMarketDataUpdate', 'Request', 'SUBSCRIBE');
        this.ticker.send('RequestMarketDataUpdate', { symbol: sub.symbol, exchange: sub.exchange, request: req, update_bits: this.updateBitsMask() });
      } catch { /* will retry on next reconnect */ }
    }
  }

  subscriptions(): readonly string[] { return [...this.subs.keys()]; }
  freshnessSnapshot(symbol: string): FreshnessSnapshot | null { return this.freshness.get(symbol)?.snapshot() ?? null; }
  allFreshness(): FreshnessSnapshot[] { return [...this.freshness.values()].map((f) => f.snapshot()); }

  private onLastTrade(msg: Record<string, unknown> | null): void {
    if (!msg) return;
    const symbol = String(msg['symbol'] ?? '');
    const trade = normalizeLastTrade(symbol, msg, ++this.seq);
    this.freshness.get(symbol)?.observe(trade?.exchangeTs ?? null);
    if (trade) for (const l of this.listeners) { try { l({ kind: 'trade', trade, observedAt: this.now() }); } catch { /* isolate */ } }
  }

  private onBBO(msg: Record<string, unknown> | null): void {
    if (!msg) return;
    const symbol = String(msg['symbol'] ?? '');
    const quote = normalizeBBO(symbol, msg, ++this.seq);
    this.freshness.get(symbol)?.observe(quote?.exchangeTs ?? null);
    if (quote) for (const l of this.listeners) { try { l({ kind: 'quote', quote, observedAt: this.now() }); } catch { /* isolate */ } }
  }

  /**
   * Fetch historical bars from the HISTORY plant. Collects ResponseTimeBarReplay
   * messages until a terminator (an rp_code-only message) or timeout, normalizes,
   * dedupes by open time and sorts ascending. Bars with bad OHLC are dropped, not
   * fabricated.
   */
  async getHistoricalBars(req: {
    symbol: string; exchange: string; timeframe: Timeframe; from: number; to: number;
  }, timeoutMs = 20_000): Promise<NormalizedBar[]> {
    if (!this.history) throw new Error('history plant not available');
    const bar = timeframeToRithmicBar(req.timeframe);
    if (!bar) throw new Error(`unsupported timeframe ${req.timeframe}`);
    const barTypeVal = this.codec.enumValue('RequestTimeBarReplay', 'BarType', bar.barType);
    const collected = new Map<number, NormalizedBar>();
    const history = this.history;
    return new Promise<NormalizedBar[]>((resolve, reject) => {
      const finish = (): void => { off(); clearTimeout(timer); resolve([...collected.values()].sort((a, b) => a.time - b.time)); };
      const timer = setTimeout(finish, timeoutMs);
      const off = history.router.on('ResponseTimeBarReplay', (m) => {
        const msg = m.message;
        if (!msg) return;
        const nb = normalizeTimeBar(req.symbol, msg);
        if (nb) {
          if (nb.time * 1000 >= 0 && nb.time >= req.from && nb.time <= req.to) collected.set(nb.time, nb);
          else if (req.from === 0 && req.to === 0) collected.set(nb.time, nb);
        } else {
          // A message with no bar payload but an rp_code is the stream terminator.
          const rp = msg['rp_code'];
          if (rp !== undefined) finish();
        }
      });
      try {
        history.send('RequestTimeBarReplay', {
          symbol: req.symbol, exchange: req.exchange,
          bar_type: barTypeVal, bar_type_period: bar.period,
          start_index: Math.floor(req.from / 1000), finish_index: Math.floor(req.to / 1000),
          user_msg: [`hist-${req.symbol}-${req.timeframe}`],
        });
      } catch (e) { clearTimeout(timer); off(); reject(e as Error); }
    });
  }

  dispose(): void {
    this.routerUnsub.forEach((u) => u());
    this.routerUnsub = [];
    this.listeners.clear();
  }
}
