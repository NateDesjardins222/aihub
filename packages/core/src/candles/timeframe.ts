/**
 * Timeframe definitions and session-anchored bucket alignment.
 *
 * Intraday buckets are anchored to the SESSION OPEN, not to UTC midnight. For
 * CME products the session opens at 17:00 exchange-local, so a 4-hour bar runs
 * 17:00-21:00, 21:00-01:00, 01:00-05:00 and so on. Anchoring to UTC instead
 * would cut the overnight session in the middle of the night and produce bars
 * that no futures trader would recognise.
 */
import type { InstrumentSpec, Timeframe } from '@atlas/contracts';
import { DateTime } from 'luxon';
import { sessionEnd, sessionStart, tradingDate } from '@atlas/instruments';

/** Duration of one bar in milliseconds. Calendar timeframes are 0 (variable). */
export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  '1s': 1_000,
  '5s': 5_000,
  '10s': 10_000,
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '2m': 120_000,
  '3m': 180_000,
  '5m': 300_000,
  '10m': 600_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '1D': 0,
  '1W': 0,
  '1M': 0,
};

export const ALL_TIMEFRAMES: readonly Timeframe[] = Object.keys(TIMEFRAME_MS) as Timeframe[];

export function isCalendarTimeframe(tf: Timeframe): boolean {
  return tf === '1D' || tf === '1W' || tf === '1M';
}

export function isIntraday(tf: Timeframe): boolean {
  return !isCalendarTimeframe(tf);
}

export function timeframeMs(tf: Timeframe): number {
  return TIMEFRAME_MS[tf];
}

/** True when `coarse` is an exact multiple of `fine`, so folding is lossless. */
export function isDivisible(fine: Timeframe, coarse: Timeframe): boolean {
  if (isCalendarTimeframe(coarse)) return isIntraday(fine) || fine === '1D';
  if (isCalendarTimeframe(fine)) return false;
  return TIMEFRAME_MS[coarse] % TIMEFRAME_MS[fine] === 0;
}

/**
 * Session bounds with a one-entry cache.
 *
 * Bucketing walks bars in time order, so consecutive lookups almost always land
 * in the same session. Without this cache a 20,000-bar fold would build tens of
 * thousands of DateTime objects.
 */
interface SessionBounds {
  readonly start: number;
  readonly end: number;
}

class SessionCache {
  private last: { root: string; bounds: SessionBounds } | null = null;

  get(spec: InstrumentSpec, t: number): SessionBounds | null {
    const cached = this.last;
    if (cached && cached.root === spec.root && t >= cached.bounds.start && t < cached.bounds.end) {
      return cached.bounds;
    }
    const start = sessionStart(spec, t);
    const end = sessionEnd(spec, t);
    if (start === null || end === null) return null;
    const bounds = { start, end };
    this.last = { root: spec.root, bounds };
    return bounds;
  }
}

const sessionCache = new SessionCache();

/**
 * The session open that produced a given trading date.
 *
 * A Globex trading day begins the previous evening, so the session for trading
 * date D opened on D-1 at the session open minute.
 */
export function sessionOpenForTradingDate(spec: InstrumentSpec, date: string): number {
  const openMinute = spec.sessionWindows[0]?.startMinute ?? 17 * 60;
  return DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: spec.sessionTimezone })
    .minus({ days: 1 })
    .startOf('day')
    .plus({ minutes: openMinute })
    .toMillis();
}

/** The trading date of the first session of the week containing `t` (Monday). */
function weekAnchor(spec: InstrumentSpec, t: number): number {
  const date = tradingDate(spec, t);
  const monday = DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: spec.sessionTimezone }).startOf(
    'week',
  );
  return sessionOpenForTradingDate(spec, monday.toFormat('yyyy-MM-dd'));
}

/** The trading date of the first session of the calendar month containing `t`. */
function monthAnchor(spec: InstrumentSpec, t: number): number {
  const date = tradingDate(spec, t);
  const first = DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: spec.sessionTimezone }).startOf(
    'month',
  );
  // Roll forward to the first weekday: weekends have no session.
  let cursor = first;
  while (cursor.weekday === 6 || cursor.weekday === 7) cursor = cursor.plus({ days: 1 });
  return sessionOpenForTradingDate(spec, cursor.toFormat('yyyy-MM-dd'));
}

/**
 * The opening timestamp of the bucket containing `t`.
 *
 * Every bar in the system is keyed by this value, which is what makes duplicate
 * candles impossible: two events in the same bucket resolve to the same key.
 */
export function bucketStart(spec: InstrumentSpec, t: number, tf: Timeframe): number {
  if (tf === '1D') return sessionOpenForTradingDate(spec, tradingDate(spec, t));
  if (tf === '1W') return weekAnchor(spec, t);
  if (tf === '1M') return monthAnchor(spec, t);

  const ms = TIMEFRAME_MS[tf];
  const bounds = sessionCache.get(spec, t);
  if (!bounds) {
    // Outside any session (holiday, maintenance, weekend). Fall back to epoch
    // alignment so the data is still bucketed deterministically rather than
    // dropped, and so it stays comparable across restarts.
    return Math.floor(t / ms) * ms;
  }
  const offset = t - bounds.start;
  return bounds.start + Math.floor(offset / ms) * ms;
}

/** Exclusive end of the bucket containing `t`. */
export function bucketEnd(spec: InstrumentSpec, t: number, tf: Timeframe): number {
  const start = bucketStart(spec, t, tf);
  if (tf === '1D' || tf === '1W' || tf === '1M') {
    // Step one bar forward and re-align, because calendar buckets vary in length.
    const probe = start + estimateCalendarSpanMs(tf);
    return bucketStart(spec, probe, tf);
  }
  return start + TIMEFRAME_MS[tf];
}

function estimateCalendarSpanMs(tf: Timeframe): number {
  if (tf === '1D') return 26 * 3_600_000; // a Globex day is 23h; overshoot into the next
  if (tf === '1W') return 8 * 86_400_000;
  return 32 * 86_400_000;
}

/** Seconds remaining until the bucket containing `now` closes. */
export function secondsToBucketClose(spec: InstrumentSpec, now: number, tf: Timeframe): number {
  return Math.max(0, Math.ceil((bucketEnd(spec, now, tf) - now) / 1000));
}
