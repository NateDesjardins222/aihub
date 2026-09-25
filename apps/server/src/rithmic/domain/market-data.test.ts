/**
 * Rithmic market-data — deterministic tests (Milestone 9).
 *
 * Normalization, freshness, instrument reconciliation against Atlas canonical,
 * historical bars, bar comparison and historical/live merge — all against the
 * test-double codec, no live Rithmic.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { loadSchema, resetSchemaCache } from '../protocol/registry.js';
import { RithmicCodec, rithmicCodec, resetCodec } from '../protocol/codec.js';
import { MockRithmicTransport } from '../transport/transport.js';
import { RithmicPlant } from '../plants/plant.js';
import { RithmicMarketDataService } from '../plants/market-data-service.js';
import { normalizeLastTrade, normalizeBBO, normalizeTimeBar, rithmicTsToMs, timeframeToRithmicBar } from './market-normalize.js';
import { FreshnessTracker } from './freshness.js';
import { atlasCanonical, rithmicExchange, reconcileReferenceData, parseReferenceData, LAUNCH_ROOTS } from './instruments.js';
import { compareBars, mergeHistoricalWithLive, validateBarSeries } from './bar-compare.js';
import type { NormalizedBar } from '@atlas/contracts';

let codec: RithmicCodec;
beforeEach(() => { resetSchemaCache(); resetCodec(); codec = new RithmicCodec(loadSchema({ force: true })); });

describe('normalization', () => {
  it('normalizes a LastTrade with the provider timestamp', () => {
    const t = normalizeLastTrade('NQZ5', { trade_price: 20100.25, trade_size: 2, aggressor: 1, ssboe: 1_700_000_000, usecs: 500_000 }, 1);
    expect(t).not.toBeNull();
    expect(t!.price).toBe(20100.25);
    expect(t!.size).toBe(2);
    expect(t!.aggressor).toBe('BUY');
    expect(t!.exchangeTs).toBe(1_700_000_000 * 1000 + 500);
  });

  it('returns null for a trade with no price (never fabricates)', () => {
    expect(normalizeLastTrade('NQ', { trade_size: 1 }, 1)).toBeNull();
  });

  it('normalizes a real BBO as a non-synthesized book', () => {
    const q = normalizeBBO('ESZ5', { bid_price: 5000.25, bid_size: 10, ask_price: 5000.5, ask_size: 8, ssboe: 1, usecs: 0 }, 2);
    expect(q!.bid).toBe(5000.25);
    expect(q!.ask).toBe(5000.5);
    expect(q!.synthesizedBook).toBe(false);
  });

  it('rithmicTsToMs handles missing/zero timestamps', () => {
    expect(rithmicTsToMs(0, 0)).toBeNull();
    expect(rithmicTsToMs(1_700_000_000, 250_000)).toBe(1_700_000_000_250);
  });

  it('maps every Atlas timeframe M9 requires to a Rithmic bar', () => {
    for (const tf of ['1m', '5m', '15m', '1h'] as const) expect(timeframeToRithmicBar(tf)).not.toBeNull();
  });

  it('normalizes a time bar and rejects one with missing OHLC', () => {
    const b = normalizeTimeBar('NQ', { open_price: 1, high_price: 2, low_price: 0.5, close_price: 1.5, volume: 100, marker: 1_700_000_000 });
    expect(b!.time).toBe(1_700_000_000_000);
    expect(b!.closed).toBe(true);
    expect(normalizeTimeBar('NQ', { open_price: 1, marker: 1 })).toBeNull();
  });
});

describe('freshness', () => {
  it('is stale before any observation and fresh right after one', () => {
    let now = 1_000_000;
    const f = new FreshnessTracker('NQ', 5_000, () => now);
    expect(f.isStale()).toBe(true);
    f.observe(now);
    expect(f.isStale()).toBe(false);
    expect(f.statusLabel(true, false)).toBe('CONNECTED');
  });

  it('goes STALE when data stops even though the socket is open', () => {
    let now = 1_000_000;
    const f = new FreshnessTracker('NQ', 5_000, () => now);
    f.observe(now);
    now += 6_000;
    expect(f.isStale()).toBe(true);
    expect(f.statusLabel(true, false)).toBe('STALE'); // connected socket, stale data
  });

  it('reports RECONNECTING and DISCONNECTED truthfully', () => {
    const f = new FreshnessTracker('NQ', 5_000, () => 1);
    expect(f.statusLabel(true, true)).toBe('RECONNECTING');
    expect(f.statusLabel(false, false)).toBe('DISCONNECTED');
  });

  it('measures a message rate', () => {
    let now = 0;
    const f = new FreshnessTracker('NQ', 5_000, () => now);
    for (let i = 0; i < 10; i += 1) { f.observe(now); now += 100; }
    expect(f.messagesPerSec()).toBeGreaterThan(0);
  });
});

describe('instrument reconciliation vs Atlas canonical', () => {
  it('exposes canonical economics for all eight launch roots', () => {
    for (const root of LAUNCH_ROOTS) {
      const c = atlasCanonical(root);
      expect(c.tickSize).toBeGreaterThan(0);
      expect(c.pointValue).toBeGreaterThan(0);
      expect(c.exchange).toMatch(/CME|COMEX|NYMEX|CBOT/);
    }
  });

  it('maps roots to their canonical exchange (not an identical default)', () => {
    expect(rithmicExchange('NQ')).toBe('CME');
    expect(rithmicExchange('GC')).toBe('COMEX');
    expect(rithmicExchange('CL')).toBe('NYMEX');
  });

  it('MATCHED when provider reference agrees with Atlas', () => {
    const c = atlasCanonical('NQ');
    const r = reconcileReferenceData('NQ', { symbol: 'NQZ5', exchange: 'CME', tickSize: c.tickSize, pointValue: c.pointValue, expiration: '20251219', tradingSymbol: 'NQZ5', tradable: true });
    expect(r.status).toBe('MATCHED');
    expect(r.discrepancies).toHaveLength(0);
  });

  it('DISCREPANCY when tick size or exchange disagree — Atlas is never overwritten', () => {
    const r = reconcileReferenceData('NQ', { symbol: 'NQZ5', exchange: 'NYMEX', tickSize: 0.5, pointValue: 20, expiration: null, tradingSymbol: null, tradable: true });
    expect(r.status).toBe('DISCREPANCY');
    expect(r.discrepancies.join(' ')).toMatch(/exchange/);
    expect(r.discrepancies.join(' ')).toMatch(/tickSize/);
    expect(r.canonical.tickSize).toBe(atlasCanonical('NQ').tickSize); // canonical intact
  });

  it('parses ResponseReferenceData fields', () => {
    const ref = parseReferenceData({ symbol: 'GCZ5', exchange: 'COMEX', min_qprice_change: 0.1, single_point_value: 100, is_tradable: 'true' });
    expect(ref.tickSize).toBe(0.1);
    expect(ref.pointValue).toBe(100);
    expect(ref.tradable).toBe(true);
  });
});

describe('bar comparison + merge', () => {
  const mk = (time: number, o: number, h: number, l: number, c: number, v: number): NormalizedBar => ({ symbol: 'NQ', time, open: o, high: h, low: l, close: c, volume: v, closed: true });

  it('reports identical series and exact field diffs', () => {
    const a = [mk(1000, 1, 2, 0.5, 1.5, 10), mk(2000, 1.5, 2.5, 1, 2, 20)];
    expect(compareBars(a, a).identical).toBe(true);
    const b = [mk(1000, 1, 2, 0.5, 1.9, 10), mk(2000, 1.5, 2.5, 1, 2, 25)];
    const cmp = compareBars(a, b);
    expect(cmp.identical).toBe(false);
    expect(cmp.diffs.some((d) => d.field === 'close')).toBe(true);
    expect(cmp.diffs.some((d) => d.field === 'volume')).toBe(true);
  });

  it('flags a missing bar (gap) on either side', () => {
    const a = [mk(1000, 1, 2, 0.5, 1.5, 10), mk(2000, 1, 2, 0.5, 1.5, 10)];
    const b = [mk(1000, 1, 2, 0.5, 1.5, 10)];
    expect(compareBars(a, b).diffs.some((d) => d.field === 'missing_in_b')).toBe(true);
  });

  it('merges historical + live with no duplicate current bar or backward time', () => {
    const hist = [mk(1000, 1, 2, 0.5, 1.5, 10), mk(2000, 1.5, 2.5, 1, 2, 20)];
    const live = [mk(2000, 1.5, 3, 1, 2.8, 35), mk(3000, 2.8, 3.2, 2.7, 3, 12)]; // live 2000 overrides
    const merged = mergeHistoricalWithLive(hist, live);
    expect(merged).toHaveLength(3);
    expect(merged.find((b) => b.time === 2000)!.close).toBe(2.8); // live won
    expect(validateBarSeries(merged)).toHaveLength(0);
  });

  it('validateBarSeries catches duplicates and bad OHLC', () => {
    const bad = [mk(1000, 1, 2, 0.5, 1.5, 10), mk(1000, 1, 2, 0.5, 1.5, 10)];
    expect(validateBarSeries(bad).some((p) => /duplicate/.test(p))).toBe(true);
    const badOhlc = [mk(1000, 5, 2, 0.5, 1.5, 10)]; // open>high
    expect(validateBarSeries(badOhlc).some((p) => /OHLC/.test(p))).toBe(true);
  });
});

// ---- market-data service against a mock ticker/history plant -----------------
function mockMarketServer() {
  const transports: MockRithmicTransport[] = [];
  const factory = (url: string): MockRithmicTransport => {
    const t = new MockRithmicTransport(url);
    t.serverHandler = (frame): void => {
      let d; try { d = rithmicCodec().decode(frame); } catch { return; }
      const echo = (d.message?.['user_msg'] as string[] | undefined) ?? [];
      if (d.name === 'RequestLogin') t.injectMessage(rithmicCodec().encode('ResponseLogin', { rp_code: ['0'], user_msg: echo, heartbeat_interval: 60 }));
      else if (d.name === 'RequestRithmicSystemInfo') t.injectMessage(rithmicCodec().encode('ResponseRithmicSystemInfo', { rp_code: ['0'], system_name: ['Rithmic Test'], user_msg: echo }));
      else if (d.name === 'RequestMarketDataUpdate') t.injectMessage(rithmicCodec().encode('ResponseMarketDataUpdate', { rp_code: ['0'], user_msg: echo }));
      else if (d.name === 'RequestTimeBarReplay') {
        // Two bars then a terminator (rp_code-only message).
        t.injectMessage(rithmicCodec().encode('ResponseTimeBarReplay', { symbol: 'NQZ5', open_price: 1, high_price: 2, low_price: 0.5, close_price: 1.5, volume: 100, marker: 1_700_000_060 }));
        t.injectMessage(rithmicCodec().encode('ResponseTimeBarReplay', { symbol: 'NQZ5', open_price: 1.5, high_price: 2.5, low_price: 1, close_price: 2, volume: 120, marker: 1_700_000_120 }));
        t.injectMessage(rithmicCodec().encode('ResponseTimeBarReplay', { rp_code: ['0'] }));
      }
    };
    transports.push(t);
    return t;
  };
  return { factory, transports };
}

describe('market-data service', () => {
  it('subscribes and emits normalized trades + quotes from provider messages', async () => {
    const { factory, transports } = mockMarketServer();
    const ticker = new RithmicPlant({ kind: 'TICKER', url: 'wss://m/1', transportFactory: factory, login: { user: 'u', password: 'p', systemName: 'Rithmic Test', appName: 'Atlas', appVersion: '9' } });
    await ticker.start();
    const svc = new RithmicMarketDataService(ticker, null);
    const events: string[] = [];
    svc.on((e) => events.push(e.kind));
    svc.subscribe({ root: 'NQ', symbol: 'NQZ5', exchange: 'CME' });
    // Server pushes a trade + a quote.
    transports[0]!.injectMessage(rithmicCodec().encode('LastTrade', { symbol: 'NQZ5', exchange: 'CME', trade_price: 20100.25, trade_size: 1, ssboe: 1_700_000_000, usecs: 0 }));
    transports[0]!.injectMessage(rithmicCodec().encode('BestBidOffer', { symbol: 'NQZ5', exchange: 'CME', bid_price: 20100, bid_size: 5, ask_price: 20100.25, ask_size: 3, ssboe: 1_700_000_000, usecs: 0 }));
    expect(events).toEqual(['trade', 'quote']);
    expect(svc.subscriptions()).toContain('NQZ5');
    expect(svc.freshnessSnapshot('NQZ5')!.stale).toBe(false);
    ticker.stop();
  });

  it('fetches historical bars from the history plant and normalizes them', async () => {
    const { factory } = mockMarketServer();
    const history = new RithmicPlant({ kind: 'HISTORY', url: 'wss://m/2', transportFactory: factory, login: { user: 'u', password: 'p', systemName: 'Rithmic Test', appName: 'Atlas', appVersion: '9' } });
    const ticker = new RithmicPlant({ kind: 'TICKER', url: 'wss://m/3', transportFactory: factory, login: { user: 'u', password: 'p', systemName: 'Rithmic Test', appName: 'Atlas', appVersion: '9' } });
    await Promise.all([history.start(), ticker.start()]);
    const svc = new RithmicMarketDataService(ticker, history);
    const bars = await svc.getHistoricalBars({ symbol: 'NQZ5', exchange: 'CME', timeframe: '1m', from: 0, to: 0 });
    expect(bars.length).toBe(2);
    expect(bars[0]!.time).toBeLessThan(bars[1]!.time);
    expect(validateBarSeries(bars)).toHaveLength(0);
    history.stop(); ticker.stop();
  });
});
