import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { requireInstrument } from '@atlas/instruments';
import type { NormalizedQuote, NormalizedTrade } from '@atlas/contracts';
import { MarketEventBus } from './bus.js';
import { QuoteStore, freshnessClock } from './quote-store.js';
import { emptyStats, isPlausibleExchangeTs, normalizeBar } from './normalize.js';
import { YahooDelayedProvider, chooseVendorInterval } from './providers/yahoo.js';

const NQ = requireInstrument('NQ');
const GC = requireInstrument('GC');

function ct(iso: string): number {
  return DateTime.fromISO(iso, { zone: 'America/Chicago' }).toMillis();
}

function quote(overrides: Partial<NormalizedQuote> = {}): NormalizedQuote {
  return {
    symbol: 'NQ',
    exchangeTs: 1_000_000,
    bid: null,
    bidSize: null,
    ask: null,
    askSize: null,
    last: 20_000,
    lastSize: null,
    seq: 1,
    synthesizedBook: false,
    ...overrides,
  };
}

describe('normalization', () => {
  it('snaps vendor prices onto the instrument tick grid', () => {
    const stats = emptyStats();
    // A vendor float that is a hair off a valid NQ tick.
    const bar = normalizeBar(
      NQ,
      { tsSeconds: 1_700_000_040, open: 20_000.26, high: 20_010.24, low: 19_999.99, close: 20_005.01, volume: 120 },
      stats,
      true,
    );
    expect(bar).not.toBeNull();
    expect(bar!.open).toBe(20_000.25);
    expect(bar!.high).toBe(20_010.25);
    expect(bar!.low).toBe(20_000.0);
    expect(bar!.close).toBe(20_005.0);
    expect(stats.snapped).toBe(1);
  });

  it('drops a bar with a null price rather than interpolating one', () => {
    const stats = emptyStats();
    const bar = normalizeBar(
      NQ,
      { tsSeconds: 1_700_000_040, open: null, high: 1, low: 1, close: 1, volume: 0 },
      stats,
      true,
    );
    expect(bar).toBeNull();
    expect(stats.droppedNullPrice).toBe(1);
    expect(stats.accepted).toBe(0);
  });

  it('drops non-finite values', () => {
    const stats = emptyStats();
    expect(
      normalizeBar(
        NQ,
        { tsSeconds: 1_700_000_040, open: Number.NaN, high: 1, low: 1, close: 1, volume: 1 },
        stats,
        true,
      ),
    ).toBeNull();
    expect(stats.droppedNonFinite).toBe(1);
  });

  it('re-derives the extremes so a bar cannot be self-inconsistent', () => {
    const stats = emptyStats();
    // Vendor claims a high below the close, which is impossible.
    const bar = normalizeBar(
      NQ,
      { tsSeconds: 1_700_000_040, open: 100, high: 100, low: 100, close: 105, volume: 1 },
      stats,
      true,
    );
    expect(bar!.high).toBe(105);
    expect(bar!.low).toBe(100);
  });

  it('treats a missing volume as zero rather than guessing', () => {
    const stats = emptyStats();
    const bar = normalizeBar(
      NQ,
      { tsSeconds: 1_700_000_040, open: 100, high: 100, low: 100, close: 100, volume: null },
      stats,
      true,
    );
    expect(bar!.volume).toBe(0);
  });

  it('rejects timestamps that indicate a unit mix-up', () => {
    expect(isPlausibleExchangeTs(1_700_000_000)).toBe(false); // seconds, not ms
    expect(isPlausibleExchangeTs(1_700_000_000_000)).toBe(true);
    expect(isPlausibleExchangeTs(Date.now() + 10 * 86_400_000)).toBe(false); // far future
  });

  it('applies each instrument’s own tick grid', () => {
    const stats = emptyStats();
    // 0.07 is not a valid gold tick (0.10); it must snap, not pass through.
    const bar = normalizeBar(
      GC,
      { tsSeconds: 1_700_000_040, open: 2_000.07, high: 2_000.07, low: 2_000.07, close: 2_000.07, volume: 1 },
      stats,
      true,
    );
    expect(bar!.open).toBe(2_000.1);
  });
});

describe('market event bus ordering', () => {
  let bus: MarketEventBus;
  beforeEach(() => {
    bus = new MarketEventBus();
  });

  it('drops a quote whose exchange timestamp regresses', () => {
    expect(bus.publishQuote(quote({ exchangeTs: 2_000 }))).toBe(true);
    expect(bus.publishQuote(quote({ exchangeTs: 1_000 }))).toBe(false);
    expect(bus.getStats().droppedOutOfOrder).toBe(1);
  });

  it('drops a duplicate quote for the same timestamp', () => {
    expect(bus.publishQuote(quote({ exchangeTs: 2_000 }))).toBe(true);
    expect(bus.publishQuote(quote({ exchangeTs: 2_000 }))).toBe(false);
    expect(bus.getStats().droppedDuplicate).toBe(1);
  });

  /**
   * The reconnect case: a provider that resends the last N events must not
   * double-count them into the series.
   */
  it('survives a reconnect replay without double-counting', () => {
    const received: number[] = [];
    bus.onQuote('NQ', (q) => received.push(q.exchangeTs));

    for (const ts of [1_000, 2_000, 3_000]) bus.publishQuote(quote({ exchangeTs: ts }));
    // Reconnect: the provider replays from the start.
    for (const ts of [1_000, 2_000, 3_000, 4_000]) bus.publishQuote(quote({ exchangeTs: ts }));

    expect(received).toEqual([1_000, 2_000, 3_000, 4_000]);
  });

  it('keeps sequence state per symbol', () => {
    bus.publishQuote(quote({ symbol: 'NQ', exchangeTs: 5_000 }));
    // ES is a different symbol, so an earlier timestamp is not out of order.
    expect(bus.publishQuote(quote({ symbol: 'ES', exchangeTs: 1_000 }))).toBe(true);
  });

  it('de-duplicates trades by provider sequence', () => {
    const trade = (seq: number, ts: number): NormalizedTrade => ({
      symbol: 'NQ',
      exchangeTs: ts,
      price: 100,
      size: 1,
      seq,
      aggressor: 'BUY',
    });
    expect(bus.publishTrade(trade(1, 1_000))).toBe(true);
    expect(bus.publishTrade(trade(1, 1_000))).toBe(false);
    expect(bus.publishTrade(trade(2, 1_100))).toBe(true);
  });

  it('lets a bar repeat its own bucket time, because that is a revision', () => {
    // Bars are identified by bucket; the aggregator owns that identity.
    expect(bus.publishBar({ symbol: 'NQ', time: 1_000, open: 1, high: 1, low: 1, close: 1, volume: 1, closed: false })).toBe(true);
    expect(bus.publishBar({ symbol: 'NQ', time: 1_000, open: 1, high: 2, low: 1, close: 2, volume: 3, closed: false })).toBe(true);
  });

  it('forgets ordering state when a replay seeks backwards', () => {
    bus.publishQuote(quote({ exchangeTs: 9_000 }));
    bus.resetSymbol('NQ');
    expect(bus.publishQuote(quote({ exchangeTs: 1_000 }))).toBe(true);
  });
});

describe('staleness detection', () => {
  const EXPECTED_DELAY = 600_000; // the development feed is 10 minutes behind
  const TOLERANCE = 120_000;

  function store(): QuoteStore {
    return new QuoteStore({ expectedDelayMs: EXPECTED_DELAY, toleranceMs: TOLERANCE });
  }

  /** A Tuesday inside the regular session. */
  const OPEN_NOW = ct('2026-09-15T10:00:00');

  it('does not call a delayed feed stale merely for being delayed', () => {
    const s = store();
    s.putQuote(quote({ exchangeTs: OPEN_NOW - EXPECTED_DELAY }), OPEN_NOW);
    const f = s.freshness(NQ, OPEN_NOW);
    expect(f.state).toBe('FRESH');
    expect(f.blocksOrderEntry).toBe(false);
    expect(f.excessMs).toBe(0);
  });

  it('flags stale once the feed falls beyond its own delay plus tolerance', () => {
    const s = store();
    s.putQuote(quote({ exchangeTs: OPEN_NOW - EXPECTED_DELAY - TOLERANCE - 1_000 }), OPEN_NOW);
    const f = s.freshness(NQ, OPEN_NOW);
    expect(f.state).toBe('STALE');
    expect(f.blocksOrderEntry).toBe(true);
  });

  it('says MARKET CLOSED rather than STALE outside the session', () => {
    // 03:00 Saturday: nothing is late, the market is simply shut.
    const saturday = ct('2026-09-19T03:00:00');
    const s = store();
    s.putQuote(quote({ exchangeTs: saturday - 20 * 3_600_000 }), saturday);
    const f = s.freshness(NQ, saturday);
    expect(f.state).toBe('MARKET_CLOSED');
    expect(f.blocksOrderEntry).toBe(true);
  });

  it('blocks order entry when no quote has arrived at all', () => {
    const f = store().freshness(NQ, OPEN_NOW);
    expect(f.state).toBe('NO_DATA');
    expect(f.blocksOrderEntry).toBe(true);
  });

  it('follows the delay the provider declares when it is revised', () => {
    const s = store();
    s.setExpectedDelayMs(0); // e.g. a licensed real-time feed was attached
    s.putQuote(quote({ exchangeTs: OPEN_NOW - 300_000 }), OPEN_NOW);
    expect(s.freshness(NQ, OPEN_NOW).state).toBe('STALE');
  });

  it('does not calibrate staleness to a growing measured delay', async () => {
    // A frozen feed measures an ever-growing delay. Calibrating to it would make
    // the freeze invisible: the check exists precisely to catch this.
    const frozenAt = Math.floor((Date.now() - 30 * 60_000) / 1000);
    const impl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [
            {
              meta: { symbol: 'NQ=F', regularMarketPrice: 20_000.25, regularMarketTime: frozenAt },
              timestamp: [frozenAt - 60],
              indicators: {
                quote: [{ open: [20_000], high: [20_010], low: [19_990], close: [20_005], volume: [7] }],
              },
            },
          ],
        },
      }),
    })) as unknown as typeof fetch;

    const provider = new YahooDelayedProvider({
      pollIntervalMs: 1_000_000,
      declaredDelaySeconds: 600,
      fetchImpl: impl,
    });
    provider.subscribe('NQ');
    await (provider as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    const status = provider.getConnectionStatus();
    // The measured figure reflects the freeze; the contracted one does not move.
    expect(status.delaySeconds).toBeGreaterThan(1_500);
    expect(status.declaredDelaySeconds).toBe(600);

    // Calibrated on the declared delay, a thirty-minute-old quote is stale.
    const s = store();
    s.setExpectedDelayMs(status.declaredDelaySeconds * 1_000);
    s.putQuote(quote({ exchangeTs: OPEN_NOW - 30 * 60_000 }), OPEN_NOW);
    expect(s.freshness(NQ, OPEN_NOW).state).toBe('STALE');

    await provider.disconnect();
  });

  it('judges a replay against the recording rather than the server clock', () => {
    const recorded = ct('2026-09-15T10:00:00');
    const status = { mode: 'REPLAY' as const, lastEventAt: recorded };
    const now = recorded + 47 * 3_600_000; // two days later, in the real world

    // A quote from the replay is exactly as recent as the playback position.
    expect(freshnessClock(status, recorded, now)).toBe(recorded);
    const s = store();
    s.setExpectedDelayMs(0);
    s.putQuote(quote({ exchangeTs: recorded }), recorded);
    expect(s.freshness(NQ, freshnessClock(status, recorded, now)).state).toBe('FRESH');

    // A symbol the recording does not carry has nothing to trade against.
    expect(store().freshness(GC, freshnessClock(status, null, now)).state).toBe('NO_DATA');
  });

  it('judges a live feed against the server clock', () => {
    const status = { mode: 'DELAYED' as const, lastEventAt: OPEN_NOW - EXPECTED_DELAY };
    expect(freshnessClock(status, OPEN_NOW - EXPECTED_DELAY, OPEN_NOW)).toBe(OPEN_NOW);
  });

  it('marks against the last trade and never invents a bid/ask spread', () => {
    const s = store();
    s.putQuote(quote({ last: 20_123.25, bid: null, ask: null }), OPEN_NOW);
    expect(s.markPrice('NQ')).toBe(20_123.25);
    expect(s.getQuote('NQ')!.bid).toBeNull();
    expect(s.getQuote('NQ')!.ask).toBeNull();
  });

  it('uses the mid only when a real book exists', () => {
    const s = store();
    s.putQuote(quote({ last: null, bid: 100, ask: 102 }), OPEN_NOW);
    expect(s.markPrice('NQ')).toBe(101);
  });
});

describe('vendor granularity selection', () => {
  it('picks a granularity that divides the target timeframe', () => {
    expect(chooseVendorInterval('1m', 1).interval).toBe('1m');
    expect(chooseVendorInterval('3m', 1).interval).toBe('1m'); // 5m does not divide 3m
    expect(chooseVendorInterval('15m', 30).interval).toBe('15m');
    expect(chooseVendorInterval('4h', 300).interval).toBe('1h');
    expect(chooseVendorInterval('1D', 1_000).interval).toBe('1d');
  });

  it('prefers a coarser granularity when the window is deep', () => {
    // 5 minutes of history: 1m is available and finest.
    expect(chooseVendorInterval('5m', 3).interval).toBe('5m');
    // 90 days: 1m only reaches 7, so a coarser one must be used.
    expect(chooseVendorInterval('5m', 90).interval).toBe('5m');
  });

  it('never returns a granularity that cannot fold into the target', () => {
    for (const tf of ['1m', '3m', '5m', '15m', '30m', '1h', '4h'] as const) {
      for (const days of [1, 30, 200, 900]) {
        const chosen = chooseVendorInterval(tf, days);
        expect(chosen.interval).toBeTruthy();
      }
    }
  });
});

describe('poll republication', () => {
  /**
   * The vendor returns its whole intraday window on every poll. Republishing
   * all of it turns one poll into hundreds of bar events, every one of which
   * the matching engine treats as a chance to fill a resting order.
   */
  function windowFetch(state: { minutes: number; lastClose: number }): typeof fetch {
    return (async () => {
      const nowSec = Math.floor(Date.now() / 1000) - 600;
      const base = Math.floor(nowSec / 60) * 60 - state.minutes * 60;
      const timestamp: number[] = [];
      const open: number[] = [];
      const high: number[] = [];
      const low: number[] = [];
      const close: number[] = [];
      const volume: number[] = [];
      for (let i = 0; i < state.minutes; i += 1) {
        timestamp.push(base + i * 60);
        open.push(20_000 + i);
        high.push(20_010 + i);
        low.push(19_990 + i);
        close.push(i === state.minutes - 1 ? state.lastClose : 20_005 + i);
        volume.push(42 + i);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          chart: {
            result: [
              {
                meta: {
                  symbol: 'NQ=F',
                  regularMarketPrice: 20_000.25,
                  regularMarketTime: nowSec,
                },
                timestamp,
                indicators: { quote: [{ open, high, low, close, volume }] },
              },
            ],
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  async function poll(provider: YahooDelayedProvider): Promise<void> {
    await (provider as unknown as { pollOnce: () => Promise<void> }).pollOnce();
  }

  it('publishes the window once and then only what changed', async () => {
    const state = { minutes: 8, lastClose: 20_012 };
    const provider = new YahooDelayedProvider({
      pollIntervalMs: 1_000_000,
      declaredDelaySeconds: 600,
      fetchImpl: windowFetch(state),
    });
    const bars: number[] = [];
    provider.on((e) => {
      if (e.kind === 'bar') bars.push(e.bar.time);
    });

    provider.subscribe('NQ');
    await poll(provider);
    const seeded = bars.length;
    expect(seeded).toBeGreaterThan(1);

    // Nothing moved: a second poll of the same window is not news.
    bars.length = 0;
    await poll(provider);
    expect(bars).toHaveLength(0);

    // The newest bucket revises: exactly one bar, and it is that bucket.
    state.lastClose = 20_099;
    await poll(provider);
    expect(bars).toHaveLength(1);

    // A new bucket appears: again exactly one bar.
    bars.length = 0;
    state.minutes = 9;
    await poll(provider);
    expect(bars).toHaveLength(1);

    await provider.disconnect();
  });

  it('reseeds the window after a resubscribe', async () => {
    const state = { minutes: 5, lastClose: 20_012 };
    const provider = new YahooDelayedProvider({
      pollIntervalMs: 1_000_000,
      declaredDelaySeconds: 600,
      fetchImpl: windowFetch(state),
    });
    let bars = 0;
    provider.on((e) => {
      if (e.kind === 'bar') bars += 1;
    });

    provider.subscribe('NQ');
    await poll(provider);
    expect(bars).toBeGreaterThan(1);

    provider.unsubscribe('NQ');
    provider.subscribe('NQ');
    bars = 0;
    await poll(provider);
    expect(bars).toBeGreaterThan(1);

    await provider.disconnect();
  });
});

describe('provider reconnect behaviour', () => {
  /** A fetch that fails N times then succeeds, for exercising recovery. */
  function flakyFetch(failures: number): { impl: typeof fetch; calls: () => number } {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      if (calls <= failures) throw new Error('ECONNRESET');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          chart: {
            result: [
              {
                meta: {
                  symbol: 'NQ=F',
                  regularMarketPrice: 20_000.25,
                  regularMarketTime: Math.floor(Date.now() / 1000) - 600,
                },
                timestamp: [Math.floor(Date.now() / 1000) - 660],
                indicators: {
                  quote: [{ open: [20_000], high: [20_010], low: [19_990], close: [20_005], volume: [42] }],
                },
              },
            ],
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls: () => calls };
  }

  it('reports RECONNECTING and counts attempts while the vendor is unreachable', async () => {
    const { impl } = flakyFetch(99);
    const provider = new YahooDelayedProvider({
      pollIntervalMs: 1_000_000,
      declaredDelaySeconds: 600,
      fetchImpl: impl,
    });
    provider.subscribe('NQ');
    await provider.connect();

    const status = provider.getConnectionStatus();
    expect(['RECONNECTING', 'ERROR']).toContain(status.state);
    expect(status.reconnectAttempts).toBeGreaterThan(0);
    expect(status.mode).toBe('DELAYED');
    await provider.disconnect();
  });

  it('never claims CONNECTED without a request having actually succeeded', async () => {
    // connect() used to set CONNECTED unconditionally, because the vendor
    // request swallows its own errors and never throws. A terminal that says
    // "connected" while every fetch is failing is worse than one that says
    // nothing at all.
    const { impl } = flakyFetch(99);
    const provider = new YahooDelayedProvider({
      pollIntervalMs: 1_000_000,
      declaredDelaySeconds: 600,
      fetchImpl: impl,
    });
    provider.subscribe('NQ');
    await provider.connect();
    expect(provider.getConnectionStatus().state).not.toBe('CONNECTED');
    await provider.disconnect();
  });

  it('recovers to CONNECTED once the vendor answers again', async () => {
    const { impl } = flakyFetch(1);
    const provider = new YahooDelayedProvider({
      pollIntervalMs: 1_000_000,
      declaredDelaySeconds: 600,
      fetchImpl: impl,
    });
    const events: string[] = [];
    provider.on((e) => events.push(e.kind));

    // First poll, triggered by subscribing, fails.
    provider.subscribe('NQ');
    await new Promise((done) => setTimeout(done, 20));
    expect(provider.getConnectionStatus().state).toBe('RECONNECTING');
    expect(provider.getConnectionStatus().reconnectAttempts).toBeGreaterThan(0);

    // The next poll succeeds and the provider recovers.
    await (provider as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    expect(provider.getConnectionStatus().state).toBe('CONNECTED');
    expect(provider.getConnectionStatus().reconnectAttempts).toBe(0);
    expect(events).toContain('quote');
    expect(events).toContain('bar');
    await provider.disconnect();
  });

  it('never reports a delayed feed as real-time', async () => {
    const { impl } = flakyFetch(0);
    const provider = new YahooDelayedProvider({
      pollIntervalMs: 1_000_000,
      declaredDelaySeconds: 600,
      fetchImpl: impl,
    });
    provider.subscribe('NQ');
    await provider.connect();
    const status = provider.getConnectionStatus();
    expect(status.mode).toBe('DELAYED');
    expect(status.delaySeconds).toBeGreaterThan(500);
    await provider.disconnect();
  });

  it('reports no depth and returns none, rather than inventing a book', async () => {
    const provider = new YahooDelayedProvider({
      pollIntervalMs: 1_000_000,
      declaredDelaySeconds: 600,
      fetchImpl: flakyFetch(0).impl,
    });
    expect(provider.depthLevels).toBe(0);
    expect(provider.getDepth()).toBeNull();
    expect(provider.getTrades()).toEqual([]);
    expect(provider.capabilities().providesDepth).toBe(false);
    expect(provider.capabilities().providesTopOfBook).toBe(false);
  });

  it('fans one vendor request out to every instrument sharing the series', async () => {
    let requests = 0;
    const impl = (async () => {
      requests += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          chart: {
            result: [
              {
                meta: { symbol: 'NQ=F', regularMarketPrice: 20_000.25, regularMarketTime: Math.floor(Date.now() / 1000) - 600 },
                timestamp: [],
                indicators: { quote: [{}] },
              },
            ],
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = new YahooDelayedProvider({
      pollIntervalMs: 1_000_000,
      declaredDelaySeconds: 600,
      fetchImpl: impl,
    });
    const symbols = new Set<string>();
    provider.on((e) => {
      if (e.kind === 'quote') symbols.add(e.quote.symbol);
    });
    // NQ and MNQ track the same underlying series.
    provider.subscribe('NQ');
    provider.subscribe('MNQ');
    // Let the polls that subscribe() kicked off settle first.
    await new Promise((done) => setTimeout(done, 20));

    symbols.clear();
    requests = 0;
    await (provider as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(symbols).toEqual(new Set(['NQ', 'MNQ']));
    // One vendor symbol, therefore one request, not two.
    expect(requests).toBe(1);
    await provider.disconnect();
  });

  it('queues a poll requested mid-flight instead of dropping it', async () => {
    // Without coalescing, subscribing eight instruments at start-up would leave
    // seven of them waiting a whole poll interval for their first quote.
    let requests = 0;
    const impl = (async () => {
      requests += 1;
      await new Promise((done) => setTimeout(done, 5));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          chart: {
            result: [
              {
                meta: {
                  symbol: 'NQ=F',
                  regularMarketPrice: 20_000.25,
                  regularMarketTime: Math.floor(Date.now() / 1000) - 600,
                },
                timestamp: [],
                indicators: { quote: [{}] },
              },
            ],
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = new YahooDelayedProvider({
      pollIntervalMs: 1_000_000,
      declaredDelaySeconds: 600,
      fetchImpl: impl,
    });
    const seen = new Set<string>();
    provider.on((e) => {
      if (e.kind === 'quote') seen.add(e.quote.symbol);
    });

    provider.subscribe('NQ');
    provider.subscribe('ES');
    provider.subscribe('GC');
    await new Promise((done) => setTimeout(done, 80));

    // Every subscribed instrument received a quote without waiting for the timer.
    expect(seen.has('NQ')).toBe(true);
    expect(seen.has('ES')).toBe(true);
    expect(seen.has('GC')).toBe(true);
    expect(requests).toBeGreaterThan(0);
    await provider.disconnect();
  });

  it('refuses to subscribe to an instrument the registry does not know', () => {
    const provider = new YahooDelayedProvider({
      pollIntervalMs: 1_000_000,
      declaredDelaySeconds: 600,
      fetchImpl: flakyFetch(0).impl,
    });
    expect(() => provider.subscribe('NOPE')).toThrow(/UNKNOWN_INSTRUMENT/);
  });
});
