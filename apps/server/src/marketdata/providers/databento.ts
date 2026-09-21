/**
 * Databento market-data provider — the first professional adapter behind the
 * Atlas provider seam. Databento's SDK types and wire shapes live here and in
 * its two helper modules (`databento-http.ts`, `databento-normalize.ts`); the
 * rest of the platform sees only normalized Atlas events.
 *
 * Mode. This adapter runs in **DELAYED** mode, sourced from Databento's
 * Historical HTTP API. That is deliberate, and it is the lighter licensing path
 * (see docs/market-data-licensing-gate.md): historical/delayed data needs only
 * an API key and its free credits, not an exchange real-time ILA. A true
 * REALTIME mode over Databento's raw TCP (DBN) live feed is future work behind
 * this same class — it changes `mode` and the transport, nothing downstream.
 *
 * Contract identity. Atlas keeps its live/chart pipeline keyed on the ROOT (the
 * front-month continuous experience). This adapter subscribes to Databento's
 * continuous front-month symbology (`<root>.c.0`) so the chart draws a
 * continuous series, while the tradeable contract a position locks onto is
 * resolved and persisted by the engine (contract_code). `era()` stays
 * source-level; the open-position contract lock is enforced by contract_code in
 * the engine, not by era. See docs/professional-market-data-v2-plan.md.
 *
 * The credential is read once by DatabentoHttp into an auth header and is never
 * logged, returned, or placed in an error.
 */
import type {
  ConnectionState,
  ConnectionStatus,
  HistoricalBarsRequest,
  NormalizedBar,
  NormalizedDepth,
  NormalizedQuote,
  NormalizedTrade,
  Timeframe,
} from '@atlas/contracts';
import { requireInstrument, contractResolver } from '@atlas/instruments';
import type {
  DescribableProvider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderListener,
} from '../provider.js';
import { DatabentoHttp, type FetchLike } from './databento-http.js';
import { ohlcvToBar, type DbnOhlcv } from './databento-normalize.js';

/** Timeframes Databento serves natively as an OHLCV schema. */
const NATIVE_OHLCV: Partial<Record<Timeframe, string>> = {
  '1s': 'ohlcv-1s',
  '1m': 'ohlcv-1m',
  '1h': 'ohlcv-1h',
  '1D': 'ohlcv-1d',
};

/** For non-native frames Atlas uses, request 1m and fold in-adapter. */
const FOLD_FROM_1M: Partial<Record<Timeframe, number>> = {
  '2m': 2, '3m': 3, '5m': 5, '10m': 10, '15m': 15, '30m': 30,
};

export interface DatabentoProviderOptions {
  readonly apiKey: string;
  readonly dataset?: string;
  /** Declared delay surfaced in the UI; the historical feed is never realtime. */
  readonly declaredDelaySeconds?: number;
  /** Poll cadence for the delayed live experience. */
  readonly pollIntervalMs?: number;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  /** A clock, injectable for deterministic tests. */
  readonly now?: () => number;
}

export class DatabentoProvider implements DescribableProvider {
  readonly id = 'databento';
  readonly mode = 'DELAYED' as const;
  readonly depthLevels = 1; // MBP-1 top of book, when the live path is enabled.

  private readonly http: DatabentoHttp;
  private readonly dataset: string;
  private readonly declaredDelaySeconds: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  private readonly subs = new Set<string>();
  private readonly listeners = new Set<ProviderListener>();
  private readonly latestQuote = new Map<string, NormalizedQuote>();
  private readonly lastBarTime = new Map<string, number>();
  private seq = 0;

  private state: ConnectionState = 'DISCONNECTED';
  private lastEventAt: number | null = null;
  private lastMessageAt: number | null = null;
  private reconnectAttempts = 0;
  private lastError: string | undefined;
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DatabentoProviderOptions) {
    this.http = new DatabentoHttp({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
    });
    this.dataset = opts.dataset ?? 'GLBX.MDP3';
    this.declaredDelaySeconds = opts.declaredDelaySeconds ?? 0;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.now = opts.now ?? (() => Date.now());
  }

  // -- lifecycle -----------------------------------------------------------

  async connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emitStatus();
    try {
      // A cheap authenticated probe: the dataset's available range. Confirms the
      // key and the dataset without pulling market data. A 4xx here (bad/expired
      // key) surfaces immediately without a reconnect storm.
      await this.http.datasetRange(this.dataset);
      this.state = 'CONNECTED';
      this.reconnectAttempts = 0;
      this.lastError = undefined;
      this.emitStatus();
      this.startPolling();
    } catch (err) {
      this.state = 'ERROR';
      this.lastError = errorLabel(err);
      this.emitStatus();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.state = 'DISCONNECTED';
    this.emitStatus();
  }

  subscribe(symbol: string): void {
    const spec = requireInstrument(symbol);
    this.subs.add(spec.root);
  }

  unsubscribe(symbol: string): void {
    const spec = requireInstrument(symbol);
    this.subs.delete(spec.root);
  }

  subscriptions(): readonly string[] {
    return [...this.subs];
  }

  // -- historical ----------------------------------------------------------

  async getHistoricalBars(request: HistoricalBarsRequest): Promise<NormalizedBar[]> {
    const spec = requireInstrument(request.symbol);
    const native = NATIVE_OHLCV[request.timeframe];
    const fold = FOLD_FROM_1M[request.timeframe];
    const schema = native ?? 'ohlcv-1m';
    const records = await this.http.getRange({
      dataset: this.dataset,
      // Continuous front-month series: a chart draws a continuous experience,
      // the engine still resolves the tradeable contract itself.
      symbols: contractResolver.resolveContinuousSeries(spec.root).seriesId,
      stypeIn: 'continuous',
      schema,
      start: isoOf(request.from),
      end: request.to !== undefined ? isoOf(request.to) : undefined,
      limit: request.limit,
    });
    const bars: NormalizedBar[] = [];
    for (const rec of records) {
      const bar = ohlcvToBar(spec.root, rec as unknown as DbnOhlcv, true);
      if (bar) bars.push(bar);
    }
    return fold ? foldBars(bars, fold, request.timeframe) : bars;
  }

  getQuote(symbol: string): NormalizedQuote | null {
    const spec = requireInstrument(symbol);
    return this.latestQuote.get(spec.root) ?? null;
  }

  getTrades(): readonly NormalizedTrade[] {
    // The delayed OHLCV-poll path does not carry a per-print tape; the realtime
    // DBN path will. Returning [] is honest, not a stub that invents prints.
    return [];
  }

  getDepth(): NormalizedDepth | null {
    return null; // No DOM is built this milestone (Phase 90). MBP-1 top only.
  }

  getConnectionStatus(): ConnectionStatus {
    return {
      providerId: this.id,
      state: this.state,
      mode: this.mode,
      delaySeconds: this.measuredDelaySeconds(),
      declaredDelaySeconds: this.declaredDelaySeconds,
      lastEventAt: this.lastEventAt,
      lastMessageAt: this.lastMessageAt,
      error: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * Source-level identity. It changes when the data SOURCE changes (a different
   * provider, or a switch away from replay), not when a contract rolls — the
   * open-position contract lock is enforced by contract_code in the engine, not
   * here, so a roll does not invalidate every position's marks.
   */
  era(): string {
    return `db:${this.dataset}`;
  }

  on(listener: ProviderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  capabilities(): ProviderCapabilities {
    return {
      providesTrades: true, // via the trades schema (realtime path)
      providesQuotes: true, // via MBP-1 (realtime path)
      providesTopOfBook: true,
      providesDepth: false, // MBP-10 exists but no DOM is built this milestone
      providesOhlcv: true,
      history: [
        { timeframe: '1s', maxLookbackDays: 365, supportsRangeQuery: true },
        { timeframe: '1m', maxLookbackDays: 3650, supportsRangeQuery: true },
        { timeframe: '1h', maxLookbackDays: 3650, supportsRangeQuery: true },
        { timeframe: '1D', maxLookbackDays: 3650, supportsRangeQuery: true },
      ],
      notes: [
        'DELAYED mode via the Historical HTTP API — the lighter licensing path.',
        'REALTIME (raw TCP / DBN live) is future work behind this same adapter.',
        'GLBX.MDP3 covers CME/CBOT/NYMEX/COMEX — all eight Atlas roots.',
      ],
    };
  }

  // -- delayed live experience (historical poll) ---------------------------

  private startPolling(): void {
    if (this.poller) return;
    this.poller = setInterval(() => {
      void this.pollOnce().catch((err) => {
        this.lastError = errorLabel(err);
        // A transient poll failure degrades but does not crash; connect()'s
        // probe already proved the key, so this is treated as DEGRADED-ish.
        if (this.state === 'CONNECTED') {
          this.state = 'RECONNECTING';
          this.reconnectAttempts += 1;
          this.emitStatus();
        }
      });
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  /** Run one poll cycle now (also the seam tests and a manual refresh use). */
  async pollNow(): Promise<void> {
    return this.pollOnce();
  }

  /** Fetch the most recent 1-minute bar for each subscribed root and emit new ones. */
  private async pollOnce(): Promise<void> {
    if (this.subs.size === 0) return;
    const end = this.now();
    const start = end - 5 * 60_000; // a small trailing window
    for (const root of this.subs) {
      const spec = requireInstrument(root);
      const records = await this.http.getRange({
        dataset: this.dataset,
        symbols: contractResolver.resolveContinuousSeries(spec.root).seriesId,
        stypeIn: 'continuous',
        schema: 'ohlcv-1m',
        start: isoOf(start),
        end: isoOf(end),
      });
      this.lastMessageAt = this.now();
      if (this.state === 'RECONNECTING') {
        this.state = 'CONNECTED';
        this.emitStatus();
      }
      for (const rec of records) {
        const bar = ohlcvToBar(root, rec as unknown as DbnOhlcv, true);
        if (!bar) continue;
        const prev = this.lastBarTime.get(root) ?? 0;
        if (bar.time <= prev) continue; // already emitted
        this.lastBarTime.set(root, bar.time);
        this.lastEventAt = bar.time;
        this.emit({ kind: 'bar', bar, observedAt: this.now() });
        // A bar close also yields a mark: last = close, no invented book.
        const quote: NormalizedQuote = {
          symbol: root,
          exchangeTs: bar.time,
          bid: null, bidSize: null, ask: null, askSize: null,
          last: bar.close, lastSize: null,
          seq: (this.seq += 1),
          synthesizedBook: false,
        };
        this.latestQuote.set(root, quote);
        this.emit({ kind: 'quote', quote, observedAt: this.now() });
      }
    }
  }

  private measuredDelaySeconds(): number {
    if (this.lastEventAt === null) return this.declaredDelaySeconds;
    return Math.max(0, Math.round((this.now() - this.lastEventAt) / 1000));
  }

  private emit(event: ProviderEvent): void {
    for (const l of this.listeners) l(event);
  }

  private emitStatus(): void {
    this.emit({ kind: 'status', status: this.getConnectionStatus() });
  }
}

/** Fold consecutive 1-minute bars into `n`-minute bars aligned to the boundary. */
export function foldBars(bars: readonly NormalizedBar[], n: number, _tf: Timeframe): NormalizedBar[] {
  if (n <= 1) return [...bars];
  const bucketMs = n * 60_000;
  const out: NormalizedBar[] = [];
  let cur: { time: number; open: number; high: number; low: number; close: number; volume: number } | null = null;
  for (const b of bars) {
    const bucket = Math.floor(b.time / bucketMs) * bucketMs;
    if (!cur || cur.time !== bucket) {
      if (cur) out.push({ symbol: bars[0]!.symbol, ...cur, closed: true });
      cur = { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push({ symbol: bars[0]!.symbol, ...cur, closed: true });
  return out;
}

function isoOf(ms: number | undefined): string {
  return new Date(ms ?? Date.now()).toISOString();
}

/** A credential-safe label for an error — never includes a body that could echo a key. */
function errorLabel(err: unknown): string {
  if (err instanceof Error) {
    // DatabentoHttpError's message already excludes the credential by construction.
    return err.name === 'DatabentoHttpError' ? err.message : err.name;
  }
  return 'error';
}
