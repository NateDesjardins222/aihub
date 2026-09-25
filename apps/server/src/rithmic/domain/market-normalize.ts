/**
 * Normalize Rithmic market-data messages into Atlas canonical events (Milestone 9).
 *
 * Only actual provider observations become canonical events. Nothing is
 * fabricated: a message missing a price yields no trade/quote. The provider
 * timestamp (ssboe seconds + usecs microseconds) becomes the exchange timestamp;
 * the receive timestamp is recorded separately for freshness measurement.
 */
import type { NormalizedBar, NormalizedQuote, NormalizedTrade, Timeframe } from '@atlas/contracts';

/** Rithmic ssboe (epoch seconds) + usecs → epoch milliseconds. */
export function rithmicTsToMs(ssboe: unknown, usecs: unknown): number | null {
  const s = Number(ssboe);
  if (!Number.isFinite(s) || s <= 0) return null;
  const u = Number(usecs);
  return s * 1000 + (Number.isFinite(u) ? Math.floor(u / 1000) : 0);
}

/** Map a Rithmic aggressor code to Atlas's side vocabulary. */
export function normalizeAggressor(v: unknown): NormalizedTrade['aggressor'] {
  const n = Number(v);
  if (n === 1) return 'BUY';
  if (n === 2) return 'SELL';
  return 'UNKNOWN';
}

/** LastTrade → NormalizedTrade. Returns null when there is no usable price. */
export function normalizeLastTrade(symbol: string, msg: Record<string, unknown>, seq: number): NormalizedTrade | null {
  const price = Number(msg['trade_price']);
  if (!Number.isFinite(price)) return null;
  const size = Number(msg['trade_size']);
  const ts = rithmicTsToMs(msg['ssboe'], msg['usecs']);
  return {
    symbol,
    exchangeTs: ts ?? Date.now(),
    price,
    size: Number.isFinite(size) ? size : 0,
    seq,
    aggressor: normalizeAggressor(msg['aggressor']),
  };
}

/** BestBidOffer → NormalizedQuote (real book, not synthesized). Null if no side present. */
export function normalizeBBO(symbol: string, msg: Record<string, unknown>, seq: number): NormalizedQuote | null {
  const bid = num(msg['bid_price']);
  const ask = num(msg['ask_price']);
  if (bid === null && ask === null) return null;
  const ts = rithmicTsToMs(msg['ssboe'], msg['usecs']);
  return {
    symbol,
    exchangeTs: ts ?? Date.now(),
    bid, bidSize: num(msg['bid_size']),
    ask, askSize: num(msg['ask_size']),
    last: null, lastSize: null,
    seq,
    synthesizedBook: false, // a real BBO from the provider
  };
}

/** Map an Atlas timeframe to a Rithmic time-bar request (bar type + period). */
export function timeframeToRithmicBar(tf: Timeframe): { barType: 'SECOND_BAR' | 'MINUTE_BAR' | 'DAILY_BAR' | 'WEEKLY_BAR'; period: number } | null {
  const m: Record<string, { barType: 'SECOND_BAR' | 'MINUTE_BAR' | 'DAILY_BAR' | 'WEEKLY_BAR'; period: number }> = {
    '1s': { barType: 'SECOND_BAR', period: 1 },
    '5s': { barType: 'SECOND_BAR', period: 5 },
    '10s': { barType: 'SECOND_BAR', period: 10 },
    '15s': { barType: 'SECOND_BAR', period: 15 },
    '30s': { barType: 'SECOND_BAR', period: 30 },
    '1m': { barType: 'MINUTE_BAR', period: 1 },
    '2m': { barType: 'MINUTE_BAR', period: 2 },
    '3m': { barType: 'MINUTE_BAR', period: 3 },
    '5m': { barType: 'MINUTE_BAR', period: 5 },
    '10m': { barType: 'MINUTE_BAR', period: 10 },
    '15m': { barType: 'MINUTE_BAR', period: 15 },
    '30m': { barType: 'MINUTE_BAR', period: 30 },
    '1h': { barType: 'MINUTE_BAR', period: 60 },
    '2h': { barType: 'MINUTE_BAR', period: 120 },
    '4h': { barType: 'MINUTE_BAR', period: 240 },
    '1D': { barType: 'DAILY_BAR', period: 1 },
    '1W': { barType: 'WEEKLY_BAR', period: 1 },
  };
  return m[tf] ?? null;
}

/**
 * ResponseTimeBarReplay → NormalizedBar. The `marker` is the bar open time in
 * epoch seconds; a bar missing OHLC is rejected (returns null) rather than
 * fabricated. Historical bars are always `closed`.
 */
export function normalizeTimeBar(symbol: string, msg: Record<string, unknown>): NormalizedBar | null {
  const open = num(msg['open_price']);
  const high = num(msg['high_price']);
  const low = num(msg['low_price']);
  const close = num(msg['close_price']);
  const markerSec = Number(msg['marker']);
  if (open === null || high === null || low === null || close === null || !Number.isFinite(markerSec)) return null;
  const volume = Number(msg['volume']);
  return {
    symbol,
    time: markerSec * 1000,
    open, high, low, close,
    volume: Number.isFinite(volume) ? volume : 0,
    closed: true,
  };
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== null && v !== '' ? n : null;
}
