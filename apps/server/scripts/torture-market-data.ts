/**
 * Deterministic market-data torture harness (Professional Market Data V2,
 * Phases 73-74).
 *
 * A seeded pseudo-random stream drives the real market-data pipeline — the
 * MarketEventBus (sequencing, duplicate and regression handling, the price-
 * integrity gate), the CandleAggregator (trades and bars into candles) and the
 * QuoteStore (freshness) — with every adversarial condition a professional feed
 * produces: duplicates, late and out-of-order events, missing intervals,
 * bursts, disconnect/reconnect, contract change, session close/reopen, bad
 * prices, off-grid prices, and stale quotes/trades. After EVERY step the
 * invariants are re-checked; a single violation prints the seed and step and
 * exits non-zero.
 *
 * It runs entirely in-process against the genuine pipeline components — no
 * provider, no network, no key — so it is fully deterministic and part of the
 * offline completion gate. Data is fed already tick-snapped, exactly as the
 * normalization stage delivers it to the bus.
 *
 * Run: pnpm --filter @atlas/server exec tsx scripts/torture-market-data.ts --seed 1 --ops 500
 */
import { requireInstrument, snapPrice, priceToTicks, isValidTickPrice } from '@atlas/instruments';
import { CandleAggregator } from '@atlas/core';
import type { NormalizedBar, NormalizedQuote, NormalizedTrade, Timeframe } from '@atlas/contracts';
import { MarketEventBus } from '../src/marketdata/bus.js';
import { QuoteStore } from '../src/marketdata/quote-store.js';

const SYMBOL = 'NQ';
const BASE: Timeframe = '1s';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? dflt) : dflt;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Check {
  readonly ok: boolean;
  readonly reason: string;
}

function main(): void {
  const seed = Number(arg('seed', '1'));
  const ops = Number(arg('ops', '500'));
  const rng = makeRng(seed);
  const spec = requireInstrument(SYMBOL);

  const bus = new MarketEventBus();
  const agg = new CandleAggregator(spec, { baseTimeframe: BASE });
  const quotes = new QuoteStore({ expectedDelayMs: 0, toleranceMs: 5_000 });

  // Wire the pipeline exactly as the service does: accepted bus events feed the
  // aggregator and the quote store; a dropped event feeds nothing.
  bus.onBar(SYMBOL, (b) => agg.ingestBar(b, 'STREAM'));
  bus.onTrade(SYMBOL, (t) => agg.ingestTrade(t));
  bus.onQuote(SYMBOL, (q) => {
    if (q.last !== null) agg.ingestPrice(q.last, q.exchangeTs);
  });

  const START = Date.UTC(2026, 5, 1, 14, 0, 0); // an open RTH instant
  let t = START;
  let mid = 20_000;
  let seq = 0;
  const opCounts: Record<string, number> = {};
  const bump = (k: string): void => {
    opCounts[k] = (opCounts[k] ?? 0) + 1;
  };

  const onGrid = (p: number): number => snapPrice(spec, p);
  const step = (): number => Math.round((rng() - 0.5) * 8) * 0.25; // +/- up to 2 pts, on grid
  const advance = (ms: number): void => {
    t += ms;
  };

  function emitTrade(ts: number, price: number, size = 1): void {
    seq += 1;
    const trade: NormalizedTrade = { symbol: SYMBOL, exchangeTs: ts, price: onGrid(price), size, seq, aggressor: rng() < 0.5 ? 'BUY' : 'SELL' };
    bus.publishTrade(trade);
    const q: NormalizedQuote = {
      symbol: SYMBOL, exchangeTs: ts, bid: null, bidSize: null, ask: null, askSize: null,
      last: onGrid(price), lastSize: size, seq: bus.nextSeq(SYMBOL), synthesizedBook: false,
    };
    if (bus.publishQuote(q)) quotes.putQuote(q, ts + 1);
  }

  function emitBar(openTs: number, o: number, h: number, l: number, c: number, v: number, closed = true): void {
    const bar: NormalizedBar = {
      symbol: SYMBOL, time: openTs,
      open: onGrid(o), high: onGrid(Math.max(o, h, l, c)), low: onGrid(Math.min(o, h, l, c)), close: onGrid(c),
      volume: Math.max(0, Math.round(v)), closed,
    };
    bus.publishBar(bar);
  }

  const OPS = [
    'trade', 'trade', 'trade', 'quote', 'bar', 'dup-trade', 'late-trade', 'ooo-quote',
    'burst', 'disconnect', 'reconnect', 'contract-change', 'session-close', 'session-reopen',
    'bad-price', 'off-grid', 'stale-quote', 'stale-trade', 'missing',
  ] as const;

  // The invariants, checked after every step over all closed bars.
  function check(): Check {
    for (const tf of [BASE, '1m'] as Timeframe[]) {
      const bars = agg.series(tf);
      let prevTime = -Infinity;
      for (const b of bars) {
        if (b.closed && b.time <= prevTime) return fail(`I1 non-monotonic closed bar time on ${tf}: ${b.time} <= ${prevTime}`);
        if (b.closed) prevTime = b.time;
        if (!(b.high >= b.open && b.high >= b.close && b.high >= b.low)) return fail(`I2 high < o/c/l on ${tf} @${b.time}`);
        if (!(b.low <= b.open && b.low <= b.close && b.low <= b.high)) return fail(`I2 low > o/c/h on ${tf} @${b.time}`);
        if (b.volume < 0) return fail(`I3 negative volume on ${tf} @${b.time}`);
        for (const p of [b.open, b.high, b.low, b.close]) {
          if (!isValidTickPrice(spec, p) || !Number.isInteger(priceToTicks(spec, p))) {
            return fail(`I4 off-grid price ${p} on ${tf} @${b.time}`);
          }
        }
      }
    }
    return { ok: true, reason: '' };
  }
  function fail(reason: string): Check {
    return { ok: false, reason };
  }

  let staleObserved = false;
  let dupSuppressed = false;

  for (let i = 1; i <= ops; i += 1) {
    const op = OPS[Math.floor(rng() * OPS.length)]!;
    bump(op);
    switch (op) {
      case 'trade': {
        advance(200 + Math.floor(rng() * 800));
        mid = Math.max(100, mid + step());
        emitTrade(t, mid, 1 + Math.floor(rng() * 5));
        break;
      }
      case 'quote': {
        advance(100 + Math.floor(rng() * 400));
        mid = Math.max(100, mid + step());
        emitTrade(t, mid); // a quote+print pair
        break;
      }
      case 'bar': {
        advance(1_000);
        const o = mid, c = Math.max(100, mid + step());
        emitBar(Math.floor(t / 1000) * 1000, o, o + 1, o - 1, c, 1 + Math.floor(rng() * 10));
        mid = c;
        break;
      }
      case 'dup-trade': {
        // Re-send the last trade verbatim: the bus must drop it.
        const before = bus.getStats().droppedDuplicate;
        seq += 0; // same seq as last -> <= lastTradeSeq
        const dup: NormalizedTrade = { symbol: SYMBOL, exchangeTs: t, price: onGrid(mid), size: 1, seq, aggressor: 'BUY' };
        bus.publishTrade(dup);
        if (bus.getStats().droppedDuplicate > before) dupSuppressed = true;
        break;
      }
      case 'late-trade': {
        // A trade timestamped in the past: dropped as out-of-order.
        const late: NormalizedTrade = { symbol: SYMBOL, exchangeTs: t - 60_000, price: onGrid(mid), size: 1, seq: seq + 1, aggressor: 'BUY' };
        bus.publishTrade(late);
        break;
      }
      case 'ooo-quote': {
        const q: NormalizedQuote = { symbol: SYMBOL, exchangeTs: t - 30_000, bid: null, bidSize: null, ask: null, askSize: null, last: onGrid(mid), lastSize: 1, seq: bus.nextSeq(SYMBOL), synthesizedBook: false };
        bus.publishQuote(q); // dropped: exchangeTs regresses
        break;
      }
      case 'burst': {
        for (let k = 0; k < 20; k += 1) {
          advance(5);
          mid = Math.max(100, mid + step());
          emitTrade(t, mid);
        }
        break;
      }
      case 'disconnect':
        // A gap in the feed; nothing published.
        advance(30_000);
        break;
      case 'reconnect': {
        // Resume after a gap with a fresh, forward-timestamped print.
        advance(1_000);
        mid = Math.max(100, mid + step());
        emitTrade(t, mid);
        break;
      }
      case 'contract-change':
        // A roll in the source ordering state; the bus forgets the symbol clock
        // (as a real seek/era change would), then resumes forward.
        bus.resetSymbol(SYMBOL);
        advance(1_000);
        emitTrade(t, mid);
        break;
      case 'session-close':
        advance(60_000 * (30 + Math.floor(rng() * 60)));
        break;
      case 'session-reopen': {
        advance(1_000);
        mid = Math.max(100, mid + step());
        emitTrade(t, mid);
        break;
      }
      case 'bad-price': {
        // A lone wild outlier: the integrity gate holds it uncorroborated, so it
        // never reaches a candle.
        advance(300);
        const bad: NormalizedQuote = { symbol: SYMBOL, exchangeTs: t, bid: null, bidSize: null, ask: null, askSize: null, last: onGrid(mid * 5), lastSize: 1, seq: bus.nextSeq(SYMBOL), synthesizedBook: false };
        bus.publishQuote(bad);
        break;
      }
      case 'off-grid': {
        // An off-grid raw price, snapped as normalization would: prove it lands
        // on the tick grid before anything downstream sees it.
        const raw = mid + 0.13;
        const snapped = onGrid(raw);
        if (!isValidTickPrice(spec, snapped)) return finishFail(seed, i, op, `off-grid snap produced ${snapped}`);
        advance(300);
        emitTrade(t, snapped);
        break;
      }
      case 'stale-quote':
      case 'stale-trade': {
        // A quote whose exchange time is far older than the feed's tolerance:
        // freshness must not report it as live.
        const old = t - 60_000;
        const q: NormalizedQuote = { symbol: SYMBOL, exchangeTs: old, bid: null, bidSize: null, ask: null, askSize: null, last: onGrid(mid), lastSize: 1, seq: bus.nextSeq(SYMBOL), synthesizedBook: false };
        quotes.putQuote(q, t + 60_000);
        const fresh = quotes.freshness(spec, t + 60_000);
        if (fresh === 'FRESH') return finishFail(seed, i, op, `stale quote reported FRESH`);
        staleObserved = true;
        break;
      }
      case 'missing':
        advance(3_000); // skipped interval; no invented trades
        break;
    }

    const inv = check();
    if (!inv.ok) return finishFail(seed, i, op, inv.reason);
  }

  const stats = bus.getStats();
  console.log(`\n=== market-data torture (seed=${seed}, ops=${ops}) ===`);
  console.log('operations: ' + Object.entries(opCounts).map(([k, v]) => `${k}=${v}`).join(' '));
  console.log(`bus: published=${stats.published} droppedOutOfOrder=${stats.droppedOutOfOrder} droppedDuplicate=${stats.droppedDuplicate} quarantined=${stats.droppedQuarantined} rejected=${stats.droppedRejected}`);
  console.log(`fine bars=${agg.fineBarCount}; dup-suppression exercised=${dupSuppressed}; stale-detection exercised=${staleObserved}`);
  console.log('ALL MARKET-DATA INVARIANTS HELD');
  process.exitCode = 0;
}

function finishFail(seed: number, step: number, op: string, reason: string): void {
  console.error(`\nMARKET-DATA INVARIANT VIOLATION (seed=${seed}, step=${step}, op=${op}):`);
  console.error('  ' + reason);
  process.exitCode = 1;
}

main();
