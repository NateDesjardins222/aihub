/**
 * Databento adapter — offline unit tests. No network, no key: a fake fetch
 * feeds canned Databento-shaped JSON, and the tests assert normalization, tick
 * integrity, request building, auth handling (the key never appears in the
 * clear), historical mapping, contract-aware behaviour and the connection
 * lifecycle. These are the fixtures the offline completion gate rests on.
 */
import { describe, expect, it } from 'vitest';
import { requireInstrument, priceToTicks } from '@atlas/instruments';
import {
  nsToMs,
  scaledToPrice,
  ohlcvToBar,
  tradeToNormalized,
  mbp1ToQuote,
  type DbnOhlcv,
  type DbnTrade,
  type DbnMbp1,
} from './databento-normalize.js';
import { DatabentoHttp, parseNdjson, DatabentoHttpError } from './databento-http.js';
import { DatabentoProvider, foldBars } from './databento.js';
import type { FetchLike } from './databento-http.js';

const NANO = 1_000_000_000;
const TS_NS = '1700000000000000000'; // 2023-11-14T…Z, exact ms below
const TS_MS = 1_700_000_000_000;

function price(dollars: number): string {
  return String(BigInt(Math.round(dollars * NANO)));
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

describe('databento normalization', () => {
  it('parses nanosecond timestamps via BigInt without overflow', () => {
    expect(nsToMs(TS_NS)).toBe(TS_MS);
    expect(nsToMs('9223372036854775807')).toBeNull(); // UNDEF sentinel
    expect(nsToMs(undefined)).toBeNull();
    expect(nsToMs('0')).toBeNull();
  });

  it('scales fixed-point prices and treats UNDEF as null, never a huge number', () => {
    expect(scaledToPrice(price(20000.25))).toBeCloseTo(20000.25, 6);
    expect(scaledToPrice('9223372036854775807')).toBeNull();
    expect(scaledToPrice(undefined)).toBeNull();
  });

  it('normalizes an OHLCV record, tick-snapped and self-consistent', () => {
    const rec: DbnOhlcv = {
      hd: { ts_event: TS_NS, instrument_id: 42 },
      open: price(20000.25),
      high: price(20010.5),
      low: price(19995.0),
      close: price(20005.75),
      volume: '1234',
    };
    const bar = ohlcvToBar('NQ', rec, true)!;
    expect(bar).not.toBeNull();
    expect(bar.symbol).toBe('NQ');
    expect(bar.time).toBe(TS_MS);
    expect(bar.open).toBe(20000.25);
    expect(bar.close).toBe(20005.75);
    // high/low re-derived from the snapped four -> internally consistent
    expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
    expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
    expect(bar.volume).toBe(1234);
    expect(bar.closed).toBe(true);
    // every price is on the NQ tick grid
    const spec = requireInstrument('NQ');
    for (const p of [bar.open, bar.high, bar.low, bar.close]) {
      expect(Number.isInteger(priceToTicks(spec, p))).toBe(true);
    }
  });

  it('drops an OHLCV record with an UNDEF price', () => {
    const rec: DbnOhlcv = {
      hd: { ts_event: TS_NS },
      open: '9223372036854775807',
      high: price(1), low: price(1), close: price(1), volume: '0',
    };
    expect(ohlcvToBar('NQ', rec, true)).toBeNull();
  });

  it('normalizes a trade with aggressor side', () => {
    const rec: DbnTrade = { hd: { ts_event: TS_NS }, price: price(20001.5), size: 3, action: 'T', side: 'B' };
    const t = tradeToNormalized('NQ', rec, 7)!;
    expect(t.price).toBe(20001.5);
    expect(t.size).toBe(3);
    expect(t.aggressor).toBe('BUY');
    expect(t.seq).toBe(7);
  });

  it('normalizes MBP-1 into a real (non-synthesized) top of book', () => {
    const rec: DbnMbp1 = {
      hd: { ts_event: TS_NS },
      price: price(20002.0),
      size: 1,
      levels: [{ bid_px: price(20001.75), ask_px: price(20002.0), bid_sz: 5, ask_sz: 8 }],
    };
    const q = mbp1ToQuote('NQ', rec, 1)!;
    expect(q.bid).toBe(20001.75);
    expect(q.ask).toBe(20002.0);
    expect(q.bidSize).toBe(5);
    expect(q.askSize).toBe(8);
    expect(q.last).toBe(20002.0);
    expect(q.synthesizedBook).toBe(false);
  });

  it('drops an all-null MBP-1 frame rather than emitting an empty quote', () => {
    const rec: DbnMbp1 = {
      hd: { ts_event: TS_NS },
      levels: [{ bid_px: '9223372036854775807', ask_px: '9223372036854775807', bid_sz: 0, ask_sz: 0 }],
    };
    expect(mbp1ToQuote('NQ', rec, 1)).toBeNull();
  });
});

describe('databento HTTP client', () => {
  it('parses newline-delimited JSON, skipping blanks and malformed lines', () => {
    const text = '{"a":1}\n\n{"b":2}\nnot json\n{"c":3}\n';
    expect(parseNdjson(text)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('sends Basic auth with the key as username and never in the clear', async () => {
    let seenAuth = '';
    let seenUrl = '';
    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>).authorization ?? '';
      return jsonResponse('{"start":"x","end":"y"}');
    };
    const http = new DatabentoHttp({ apiKey: 'db-SECRET-KEY-123', fetchImpl });
    await http.datasetRange('GLBX.MDP3');
    expect(seenUrl).toBe('https://hist.databento.com/v0/metadata.get_dataset_range');
    // The raw key must not appear; only its base64(key:) form.
    expect(seenAuth.startsWith('Basic ')).toBe(true);
    expect(seenAuth).not.toContain('db-SECRET-KEY-123');
    expect(Buffer.from(seenAuth.slice(6), 'base64').toString()).toBe('db-SECRET-KEY-123:');
  });

  it('surfaces a 4xx immediately without retrying (no reconnect storm on a bad key)', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse('unauthorized', 401);
    };
    const http = new DatabentoHttp({ apiKey: 'db-bad', fetchImpl, maxRetries: 3 });
    await expect(http.getRange({ dataset: 'X', symbols: 'NQ.c.0', schema: 'ohlcv-1m', start: '2026-01-01' }))
      .rejects.toBeInstanceOf(DatabentoHttpError);
    expect(calls).toBe(1);
  });

  it('sends the request as form-encoded with json encoding', async () => {
    let body = '';
    const fetchImpl: FetchLike = async (_url, init) => {
      body = String(init?.body ?? '');
      return jsonResponse('');
    };
    const http = new DatabentoHttp({ apiKey: 'db-k', fetchImpl });
    await http.getRange({ dataset: 'GLBX.MDP3', symbols: 'NQ.c.0', schema: 'ohlcv-1m', start: '2026-01-01', stypeIn: 'continuous' });
    expect(body).toContain('dataset=GLBX.MDP3');
    expect(body).toContain('encoding=json');
    expect(body).toContain('schema=ohlcv-1m');
    expect(body).toContain('stype_in=continuous');
  });
});

describe('databento provider', () => {
  function ohlcvLine(tsMs: number, o: number, h: number, l: number, c: number, v: number): string {
    return JSON.stringify({
      hd: { ts_event: String(BigInt(tsMs) * 1_000_000n) },
      open: price(o), high: price(h), low: price(l), close: price(c), volume: String(v),
    });
  }

  it('resolves the continuous front-month series for history and returns snapped bars', async () => {
    let sentBody = '';
    const fetchImpl: FetchLike = async (_url, init) => {
      sentBody = String(init?.body ?? '');
      return jsonResponse(
        ohlcvLine(TS_MS, 20000.25, 20010, 19995, 20005, 100) + '\n' +
        ohlcvLine(TS_MS + 60_000, 20005, 20015, 20004, 20012.5, 80) + '\n',
      );
    };
    const p = new DatabentoProvider({ apiKey: 'db-k', fetchImpl });
    const bars = await p.getHistoricalBars({ symbol: 'NQ', timeframe: '1m', from: TS_MS, to: TS_MS + 120_000 });
    expect(bars).toHaveLength(2);
    expect(bars[0]!.symbol).toBe('NQ');
    expect(bars[0]!.open).toBe(20000.25);
    // continuous symbology used
    expect(sentBody).toContain('symbols=NQ.c.0');
    expect(sentBody).toContain('stype_in=continuous');
  });

  it('folds 1-minute bars into 5-minute buckets', () => {
    const base = [
      { symbol: 'NQ', time: 0, open: 10, high: 12, low: 9, close: 11, volume: 1, closed: true },
      { symbol: 'NQ', time: 60_000, open: 11, high: 15, low: 10, close: 14, volume: 2, closed: true },
      { symbol: 'NQ', time: 120_000, open: 14, high: 14, low: 8, close: 9, volume: 3, closed: true },
      { symbol: 'NQ', time: 300_000, open: 9, high: 10, low: 9, close: 10, volume: 4, closed: true },
    ];
    const folded = foldBars(base, 5, '5m');
    expect(folded).toHaveLength(2);
    expect(folded[0]).toMatchObject({ time: 0, open: 10, high: 15, low: 8, close: 9, volume: 6 });
    expect(folded[1]).toMatchObject({ time: 300_000, open: 9, close: 10, volume: 4 });
  });

  it('has a source-level era and honest DELAYED capabilities', () => {
    const p = new DatabentoProvider({ apiKey: 'db-k', dataset: 'GLBX.MDP3', fetchImpl: async () => jsonResponse('') });
    expect(p.era()).toBe('db:GLBX.MDP3');
    expect(p.mode).toBe('DELAYED');
    const caps = p.capabilities();
    expect(caps.providesOhlcv).toBe(true);
    expect(caps.providesTopOfBook).toBe(true);
    expect(caps.providesDepth).toBe(false);
  });

  it('connects by probing the dataset range and reports CONNECTED', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse('{"start":"2020-01-01","end":"2026-09-01"}');
    const p = new DatabentoProvider({ apiKey: 'db-k', fetchImpl, pollIntervalMs: 3_600_000 });
    await p.connect();
    expect(p.getConnectionStatus().state).toBe('CONNECTED');
    await p.disconnect();
    expect(p.getConnectionStatus().state).toBe('DISCONNECTED');
  });

  it('fails connect on a bad key without leaking it, staying diagnosable', async () => {
    const p = new DatabentoProvider({ apiKey: 'db-bad-secret', fetchImpl: async () => jsonResponse('nope', 401) });
    await expect(p.connect()).rejects.toBeTruthy();
    const status = p.getConnectionStatus();
    expect(status.state).toBe('ERROR');
    expect(JSON.stringify(status)).not.toContain('db-bad-secret');
  });

  it('tracks subscriptions by root', () => {
    const p = new DatabentoProvider({ apiKey: 'db-k', fetchImpl: async () => jsonResponse('') });
    p.subscribe('NQ');
    p.subscribe('nq'); // same root
    p.subscribe('ES');
    expect([...p.subscriptions()].sort()).toEqual(['ES', 'NQ']);
    p.unsubscribe('NQ');
    expect(p.subscriptions()).toEqual(['ES']);
  });

  it('emits new bars and marks from the delayed poll, deduping by bar time', async () => {
    let now = TS_MS + 120_000;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('get_dataset_range')) return jsonResponse('{"start":"x","end":"y"}');
      return jsonResponse(ohlcvLine(TS_MS, 20000, 20001, 19999, 20000.5, 10) + '\n');
    };
    const p = new DatabentoProvider({ apiKey: 'db-k', fetchImpl, pollIntervalMs: 3_600_000, now: () => now });
    const events: string[] = [];
    p.on((e) => events.push(e.kind));
    p.subscribe('NQ');
    await p.connect();
    await p.pollNow();
    now += 1_000;
    await p.pollNow(); // same bar -> deduped, no new bar/quote
    await p.disconnect();
    const bars = events.filter((k) => k === 'bar').length;
    const quotes = events.filter((k) => k === 'quote').length;
    expect(bars).toBe(1);
    expect(quotes).toBe(1);
  });
});
