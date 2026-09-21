/**
 * Databento record normalization — the ONLY place Databento's wire shapes are
 * understood, kept beside the adapter so its vendor types never leak into the
 * platform. Every function here is pure: a Databento JSON record in, a
 * vendor-neutral Atlas type out. That is what makes the adapter testable from
 * recorded fixtures without a live connection.
 *
 * Databento encodes prices as fixed-point int64 scaled by 1e-9 ("nanos"), and
 * timestamps as int64 nanoseconds since the Unix epoch. Both arrive as JSON
 * strings because they exceed IEEE-754 safe range, so both are parsed with
 * BigInt. The int64 max (9223372036854775807) is Databento's UNDEF sentinel for
 * "no value" and must read as null, never as an astronomical price.
 *
 * The exact JSON field names below are implemented from Databento's published
 * schema documentation; the first authenticated run confirms them against real
 * payloads. Where a field's placement varies (header nesting), the readers are
 * deliberately tolerant. Anything still unconfirmed is labelled in the report as
 * REQUIRES VENDOR CONFIRMATION.
 */
import { requireInstrument, snapPrice, isValidTickPrice } from '@atlas/instruments';
import type { NormalizedBar, NormalizedQuote, NormalizedTrade } from '@atlas/contracts';

/** int64 max — Databento's "undefined" sentinel for a fixed-point field. */
const UNDEF_INT64 = 9223372036854775807n;
/** Databento fixed-point price scale: 1e-9. */
const PRICE_SCALE = 1_000_000_000n;

/** A Databento record header, as it appears in JSON (`hd`). */
export interface DbnHeader {
  readonly ts_event: string; // int64 ns as string
  readonly rtype?: number;
  readonly publisher_id?: number;
  readonly instrument_id?: number;
}

/** Fields common to every Databento JSON record we read. */
interface DbnCommon {
  readonly hd?: DbnHeader;
  readonly ts_event?: string;
  readonly ts_recv?: string;
  readonly instrument_id?: number;
  readonly sequence?: number;
  /** Present when the request asked for symbols to be mapped onto records. */
  readonly symbol?: string;
}

export interface DbnOhlcv extends DbnCommon {
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string | number;
}

export interface DbnTrade extends DbnCommon {
  readonly price: string;
  readonly size: number;
  readonly action?: string; // 'T' for a trade
  readonly side?: 'A' | 'B' | 'N';
}

export interface DbnMbp1Level {
  readonly bid_px: string;
  readonly ask_px: string;
  readonly bid_sz: number;
  readonly ask_sz: number;
}

export interface DbnMbp1 extends DbnCommon {
  readonly price?: string;
  readonly size?: number;
  readonly side?: 'A' | 'B' | 'N';
  readonly levels: readonly DbnMbp1Level[];
}

export interface DbnSymbolMapping extends DbnCommon {
  readonly stype_in_symbol: string;
  readonly stype_out_symbol: string;
  readonly start_ts?: string;
  readonly end_ts?: string;
}

/** Nanoseconds (int64 string) → epoch milliseconds, via BigInt to avoid overflow. */
export function nsToMs(ns: string | undefined): number | null {
  if (ns === undefined || ns === '') return null;
  try {
    const v = BigInt(ns);
    if (v === UNDEF_INT64 || v <= 0n) return null;
    return Number(v / 1_000_000n);
  } catch {
    return null;
  }
}

/** Fixed-point int64 nanos (string) → a decimal price, or null for UNDEF. */
export function scaledToPrice(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  try {
    const v = BigInt(raw);
    if (v === UNDEF_INT64) return null;
    // futures prices * 1e9 stay well within Number's safe integer range.
    return Number(v) / Number(PRICE_SCALE);
  } catch {
    return null;
  }
}

function eventMs(r: DbnCommon): number | null {
  return nsToMs(r.hd?.ts_event ?? r.ts_event);
}

/**
 * Databento OHLCV record → NormalizedBar for a root, tick-snapped and made
 * self-consistent. `root` is Atlas's root (the record is the front-month
 * contract mapped onto it); `closed` is decided by the caller (a historical bar
 * is closed; a live forming bar is not).
 */
export function ohlcvToBar(root: string, r: DbnOhlcv, closed: boolean): NormalizedBar | null {
  const spec = requireInstrument(root);
  const time = eventMs(r);
  const open = scaledToPrice(r.open);
  const high = scaledToPrice(r.high);
  const low = scaledToPrice(r.low);
  const close = scaledToPrice(r.close);
  if (time === null || open === null || high === null || low === null || close === null) return null;
  const o = snapPrice(spec, open);
  const c = snapPrice(spec, close);
  const hi = snapPrice(spec, high);
  const lo = snapPrice(spec, low);
  // Re-derive extremes from the snapped four so the bar cannot be self-inconsistent.
  const barHigh = Math.max(o, c, hi, lo);
  const barLow = Math.min(o, c, hi, lo);
  const volume = Math.max(0, Math.round(Number(r.volume ?? 0)));
  return { symbol: spec.root, time, open: o, high: barHigh, low: barLow, close: c, volume, closed };
}

/** Databento trade record → NormalizedTrade for a root, tick-snapped. */
export function tradeToNormalized(root: string, r: DbnTrade, seq: number): NormalizedTrade | null {
  const spec = requireInstrument(root);
  const exchangeTs = eventMs(r);
  const price = scaledToPrice(r.price);
  if (exchangeTs === null || price === null) return null;
  const snapped = snapPrice(spec, price);
  const size = Math.max(0, Math.round(Number(r.size ?? 0)));
  const aggressor = r.side === 'B' ? 'BUY' : r.side === 'A' ? 'SELL' : 'UNKNOWN';
  return { symbol: spec.root, exchangeTs, price: snapped, size, seq, aggressor };
}

/** Databento MBP-1 record → NormalizedQuote (real top of book, not synthesized). */
export function mbp1ToQuote(root: string, r: DbnMbp1, seq: number): NormalizedQuote | null {
  const spec = requireInstrument(root);
  const exchangeTs = eventMs(r);
  if (exchangeTs === null) return null;
  const top = r.levels?.[0];
  const bid = top ? scaledToPrice(top.bid_px) : null;
  const ask = top ? scaledToPrice(top.ask_px) : null;
  const last = scaledToPrice(r.price);
  // A quote must carry SOMETHING priceable; an all-null frame is dropped.
  if (bid === null && ask === null && last === null) return null;
  const snap = (p: number | null): number | null => {
    if (p === null) return null;
    const s = snapPrice(spec, p);
    return isValidTickPrice(spec, s) ? s : null;
  };
  return {
    symbol: spec.root,
    exchangeTs,
    bid: snap(bid),
    bidSize: top && top.bid_sz > 0 ? top.bid_sz : null,
    ask: snap(ask),
    askSize: top && top.ask_sz > 0 ? top.ask_sz : null,
    last: snap(last),
    lastSize: r.size && r.size > 0 ? r.size : null,
    seq,
    // A real book from MBP-1 — never synthesized from a print.
    synthesizedBook: false,
  };
}
