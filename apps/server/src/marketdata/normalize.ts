/**
 * Normalization layer.
 *
 * Converts vendor payloads into canonical types, enforcing the invariants the
 * rest of the system relies on:
 *   - prices land on a valid tick for the instrument;
 *   - OHLC is internally consistent (low <= open/close <= high);
 *   - timestamps are EXCHANGE timestamps in epoch milliseconds;
 *   - nothing is invented to fill a gap.
 *
 * A bar that cannot be made valid is dropped and counted, never patched up with
 * a guess.
 */
import type { InstrumentSpec, NormalizedBar } from '@atlas/contracts';
import { snapPrice } from '@atlas/instruments';

export interface NormalizationStats {
  accepted: number;
  droppedNullPrice: number;
  droppedInvalidOhlc: number;
  droppedNonFinite: number;
  snapped: number;
}

export function emptyStats(): NormalizationStats {
  return { accepted: 0, droppedNullPrice: 0, droppedInvalidOhlc: 0, droppedNonFinite: 0, snapped: 0 };
}

export interface RawBarInput {
  /** Exchange timestamp in SECONDS, as most vendors publish it. */
  readonly tsSeconds: number;
  readonly open: number | null | undefined;
  readonly high: number | null | undefined;
  readonly low: number | null | undefined;
  readonly close: number | null | undefined;
  readonly volume: number | null | undefined;
}

/**
 * Normalize one vendor bar. Returns null when the bar cannot be trusted.
 *
 * Vendors routinely emit nulls for periods with no trading. Those are gaps in
 * the market, and a gap must stay a gap: interpolating across it would put
 * prices on the chart that never traded.
 */
export function normalizeBar(
  spec: InstrumentSpec,
  raw: RawBarInput,
  stats: NormalizationStats,
  closed: boolean,
): NormalizedBar | null {
  const { open, high, low, close } = raw;

  if (open == null || high == null || low == null || close == null) {
    stats.droppedNullPrice += 1;
    return null;
  }
  if (![open, high, low, close].every(Number.isFinite)) {
    stats.droppedNonFinite += 1;
    return null;
  }

  const o = snapPrice(spec, open);
  const h = snapPrice(spec, high);
  const l = snapPrice(spec, low);
  const c = snapPrice(spec, close);
  if (o !== open || h !== high || l !== low || c !== close) stats.snapped += 1;

  // After snapping, re-derive the extremes rather than trusting the vendor's,
  // so the bar is guaranteed self-consistent.
  const hi = Math.max(o, h, l, c);
  const lo = Math.min(o, h, l, c);
  if (!(lo <= o && o <= hi && lo <= c && c <= hi)) {
    stats.droppedInvalidOhlc += 1;
    return null;
  }

  const volume = raw.volume == null || !Number.isFinite(raw.volume) ? 0 : Math.max(0, Math.round(raw.volume));

  stats.accepted += 1;
  return {
    symbol: spec.root,
    time: raw.tsSeconds * 1000,
    open: o,
    high: hi,
    low: lo,
    close: c,
    volume,
    closed,
  };
}

/** Reject timestamps that are impossible, which usually means a unit mix-up. */
export function isPlausibleExchangeTs(tsMs: number, now = Date.now()): boolean {
  const YEAR_2000 = 946_684_800_000;
  const ONE_DAY_AHEAD = now + 86_400_000;
  return Number.isFinite(tsMs) && tsMs > YEAR_2000 && tsMs < ONE_DAY_AHEAD;
}
