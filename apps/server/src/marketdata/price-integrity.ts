/**
 * The gate that decides whether a price is believable.
 *
 * Atlas has shown isolated candles far away from the surrounding price action.
 * A single print at the wrong price does that: it enters the aggregator, opens
 * a bar of its own at a level the market never traded at, and it also becomes
 * the mark that prices every open position. One bad number, two visible
 * defects.
 *
 * The rule here is CORROBORATION, not plausibility:
 *
 *   A price far from the last accepted price is held back, not published. If
 *   the next observation agrees with it, the market really did move and both
 *   are accepted - the move is published one observation late. If the next
 *   observation goes back to where it was, the outlier is discarded and
 *   counted.
 *
 * This is why it does not erase genuine gaps. A real move sustains itself, so
 * it corroborates; an overnight or weekend gap arrives after a long silence,
 * which re-anchors rather than quarantines; a single wrong print never
 * corroborates, and it is the only thing removed.
 *
 * Nothing is ever interpolated, averaged, smoothed or invented. The only
 * outcomes are "published as received" and "not published, and counted".
 */
import type { InstrumentSpec } from '@atlas/contracts';

export type Verdict =
  /** Publish it. */
  | 'ACCEPT'
  /** Hold it back: too far from the last accepted price, not yet corroborated. */
  | 'QUARANTINE'
  /** Never publishable: not a number, or impossible for this instrument. */
  | 'REJECT';

export interface IntegrityAnomaly {
  readonly symbol: string;
  readonly verdict: Exclude<Verdict, 'ACCEPT'>;
  readonly price: number;
  readonly lastAccepted: number | null;
  readonly deviation: number;
  readonly exchangeTs: number;
  readonly at: number;
  readonly note: string;
}

export interface IntegrityCounters {
  accepted: number;
  quarantined: number;
  released: number;
  discarded: number;
  rejected: number;
  reanchored: number;
}

export interface PriceIntegrityOptions {
  /**
   * How far a price may move from the last accepted one, as a fraction, before
   * it needs corroborating. 0.005 is half a percent - about 150 NQ points,
   * which no single print of a healthy feed crosses on its own.
   */
  readonly toleranceFraction?: number;
  /**
   * Silence after which the anchor is stale and the next price re-anchors
   * instead of being questioned. Session gaps land here, and they must stay
   * visible: a weekend is a real gap in a real market.
   */
  readonly reanchorAfterMs?: number;
  /** How long a held price waits for corroboration before it is discarded. */
  readonly quarantineTtlMs?: number;
  readonly historySize?: number;
}

interface SymbolState {
  lastAccepted: number | null;
  lastAcceptedTs: number;
  pending: { price: number; exchangeTs: number; at: number } | null;
  /** The newest bucket seen, so an older bar can be recognised as a revision. */
  newestBarTime: number;
}

export class PriceIntegrity {
  private readonly states = new Map<string, SymbolState>();
  private readonly anomalies: IntegrityAnomaly[] = [];
  private readonly counters = new Map<string, IntegrityCounters>();
  private readonly tolerance: number;
  private readonly reanchorAfterMs: number;
  private readonly quarantineTtlMs: number;
  private readonly historySize: number;

  constructor(options: PriceIntegrityOptions = {}) {
    this.tolerance = options.toleranceFraction ?? 0.005;
    this.reanchorAfterMs = options.reanchorAfterMs ?? 120_000;
    this.quarantineTtlMs = options.quarantineTtlMs ?? 60_000;
    this.historySize = options.historySize ?? 50;
  }

  /**
   * Judge one price.
   *
   * `exchangeTs` is the observation's own clock - the market's, never the
   * server's - because the gap that re-anchors is a gap in TRADING, not in
   * polling.
   */
  check(
    spec: InstrumentSpec,
    price: number | null | undefined,
    exchangeTs: number,
    now = Date.now(),
  ): Verdict {
    const symbol = spec.root;
    const state = this.stateFor(symbol);
    const counters = this.countersFor(symbol);

    if (price == null || !Number.isFinite(price)) {
      counters.rejected += 1;
      this.record({
        symbol,
        verdict: 'REJECT',
        price: Number(price),
        lastAccepted: state.lastAccepted,
        deviation: Number.NaN,
        exchangeTs,
        at: now,
        note: 'not a finite number',
      });
      return 'REJECT';
    }

    /*
     * Zero and below.
     *
     * Not impossible everywhere - WTI crude settled at -$37.63 on 20 April
     * 2020, and that print is real history Atlas still serves - so this is
     * decided per instrument rather than globally.
     */
    if (price <= 0 && !spec.allowsNegativePrice) {
      counters.rejected += 1;
      this.record({
        symbol,
        verdict: 'REJECT',
        price,
        lastAccepted: state.lastAccepted,
        deviation: Number.NaN,
        exchangeTs,
        at: now,
        note: `${symbol} cannot trade at or below zero`,
      });
      return 'REJECT';
    }

    // Nothing to compare against yet.
    if (state.lastAccepted === null) {
      this.accept(state, counters, price, exchangeTs);
      return 'ACCEPT';
    }

    // A gap in trading, not a bad print: re-anchor and keep the gap visible.
    if (exchangeTs - state.lastAcceptedTs > this.reanchorAfterMs) {
      counters.reanchored += 1;
      this.accept(state, counters, price, exchangeTs);
      return 'ACCEPT';
    }

    const deviation = Math.abs(price - state.lastAccepted) / Math.abs(state.lastAccepted);
    if (deviation <= this.tolerance) {
      // Within reach of where the market was. A pending outlier that this
      // price contradicts is discarded here, which is the whole point.
      if (state.pending) {
        counters.discarded += 1;
        this.record({
          symbol,
          verdict: 'QUARANTINE',
          price: state.pending.price,
          lastAccepted: state.lastAccepted,
          deviation:
            Math.abs(state.pending.price - state.lastAccepted) / Math.abs(state.lastAccepted),
          exchangeTs: state.pending.exchangeTs,
          at: now,
          note: 'discarded: the next price went back to where the market was',
        });
        state.pending = null;
      }
      this.accept(state, counters, price, exchangeTs);
      return 'ACCEPT';
    }

    // Far from the last accepted price. Does anything corroborate it?
    const pending = state.pending;
    if (pending && now - pending.at <= this.quarantineTtlMs) {
      const agreement = Math.abs(price - pending.price) / Math.abs(pending.price);
      if (agreement <= this.tolerance) {
        counters.released += 1;
        state.pending = null;
        this.accept(state, counters, price, exchangeTs);
        return 'ACCEPT';
      }
    }

    counters.quarantined += 1;
    state.pending = { price, exchangeTs, at: now };
    this.record({
      symbol,
      verdict: 'QUARANTINE',
      price,
      lastAccepted: state.lastAccepted,
      deviation,
      exchangeTs,
      at: now,
      note: `held: ${(deviation * 100).toFixed(2)}% from the last accepted price, waiting for a second opinion`,
    });
    return 'QUARANTINE';
  }

  /**
   * Judge a bar.
   *
   * A bar carries four prices and its own range. It is believable when its
   * range contains the last accepted price, or when its close corroborates a
   * move the same way a quote does.
   */
  checkBar(
    spec: InstrumentSpec,
    bar: { open: number; high: number; low: number; close: number; time: number },
    now = Date.now(),
  ): Verdict {
    const state = this.stateFor(spec.root);

    /*
     * A bar for a bucket that has already passed is a REVISION, not a price.
     *
     * Feeds re-publish history: a warm-up poll, a reconnect, a vendor
     * correcting a bar an hour later. NQ genuinely traded at 29,462.75 at
     * 04:09 and at 29,721.25 at 20:50, and when the 04:09 bar arrived again in
     * the evening this gate questioned it - 0.87% from "the last accepted
     * price" - because it was comparing a bar from this morning with a price
     * from tonight. The bar was right and the comparison was meaningless.
     *
     * Such a bar passes straight through to whoever keeps the history, and it
     * does NOT become the anchor the next live price is judged against.
     */
    if (state.newestBarTime > 0 && bar.time < state.newestBarTime) return 'ACCEPT';
    state.newestBarTime = Math.max(state.newestBarTime, bar.time);

    const last = state.lastAccepted;
    if (
      last !== null &&
      bar.time - state.lastAcceptedTs <= this.reanchorAfterMs &&
      last >= bar.low &&
      last <= bar.high
    ) {
      // The bar covers where the market was: continuous with it by definition.
      this.accept(state, this.countersFor(spec.root), bar.close, bar.time);
      return 'ACCEPT';
    }
    return this.check(spec, bar.close, bar.time, now);
  }

  /** The last price this symbol is known to have traded at, as far as we trust. */
  lastAccepted(symbol: string): number | null {
    return this.states.get(symbol.toUpperCase())?.lastAccepted ?? null;
  }

  counts(symbol: string): IntegrityCounters {
    return { ...this.countersFor(symbol.toUpperCase()) };
  }

  /** Every symbol's counters, for the diagnostics endpoint. */
  all(): Record<string, IntegrityCounters> {
    const out: Record<string, IntegrityCounters> = {};
    for (const [symbol, counters] of this.counters) out[symbol] = { ...counters };
    return out;
  }

  /** The most recent anomalies, newest last. Bounded. */
  recent(): readonly IntegrityAnomaly[] {
    return this.anomalies;
  }

  clear(): void {
    this.states.clear();
    this.anomalies.length = 0;
    this.counters.clear();
  }

  private accept(
    state: SymbolState,
    counters: IntegrityCounters,
    price: number,
    exchangeTs: number,
  ): void {
    state.lastAccepted = price;
    state.lastAcceptedTs = exchangeTs;
    counters.accepted += 1;
  }

  private stateFor(symbol: string): SymbolState {
    const key = symbol.toUpperCase();
    let state = this.states.get(key);
    if (!state) {
      state = { lastAccepted: null, lastAcceptedTs: 0, pending: null, newestBarTime: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  private countersFor(symbol: string): IntegrityCounters {
    const key = symbol.toUpperCase();
    let counters = this.counters.get(key);
    if (!counters) {
      counters = { accepted: 0, quarantined: 0, released: 0, discarded: 0, rejected: 0, reanchored: 0 };
      this.counters.set(key, counters);
    }
    return counters;
  }

  private record(anomaly: IntegrityAnomaly): void {
    this.anomalies.push(anomaly);
    if (this.anomalies.length > this.historySize) {
      this.anomalies.splice(0, this.anomalies.length - this.historySize);
    }
  }
}
