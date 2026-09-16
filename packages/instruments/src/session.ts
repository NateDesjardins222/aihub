/**
 * Session calendar. Answers "was this instrument trading at this instant?" using
 * the exchange's own timezone and holiday calendar — not the server clock, and
 * not a fixed UTC offset.
 */
import { DateTime } from 'luxon';
import type { InstrumentSpec, MarketState } from '@atlas/contracts';
import { getHoliday, isFullClosure } from './holidays.js';

/** Luxon weekday is 1=Mon..7=Sun; the registry uses 0=Sun..6=Sat. */
function luxonToRegistryWeekday(luxonWeekday: number): number {
  return luxonWeekday % 7;
}

export function exchangeTime(spec: InstrumentSpec, epochMs: number): DateTime {
  return DateTime.fromMillis(epochMs, { zone: spec.sessionTimezone });
}

/** YYYY-MM-DD in the exchange's local calendar. */
export function exchangeDate(spec: InstrumentSpec, epochMs: number): string {
  return exchangeTime(spec, epochMs).toFormat('yyyy-MM-dd');
}

/**
 * The trading date an instant belongs to. The Globex day begins the previous
 * evening, so anything at or after the session open belongs to the NEXT calendar
 * date. This is the date used for daily P&L, daily loss limits and trading-day
 * counts, and it must not be confused with the calendar date.
 */
export function tradingDate(spec: InstrumentSpec, epochMs: number): string {
  const local = exchangeTime(spec, epochMs);
  const minuteOfDay = local.hour * 60 + local.minute;
  const openMinute = spec.sessionWindows[0]?.startMinute ?? 17 * 60;
  const dayStart = minuteOfDay >= openMinute ? local.plus({ days: 1 }) : local;
  return dayStart.toFormat('yyyy-MM-dd');
}

interface WindowHit {
  readonly openMinute: number;
  readonly closeMinute: number;
  readonly openDate: string;
}

/** Find the session window, if any, that contains this instant. */
function findWindow(spec: InstrumentSpec, local: DateTime): WindowHit | null {
  const minuteOfDay = local.hour * 60 + local.minute;
  const weekday = luxonToRegistryWeekday(local.weekday);

  for (const w of spec.sessionWindows) {
    // Window that opened today.
    if (w.weekday === weekday && minuteOfDay >= w.startMinute && minuteOfDay < w.endMinute) {
      return { openMinute: w.startMinute, closeMinute: w.endMinute, openDate: local.toFormat('yyyy-MM-dd') };
    }
    // Window that opened yesterday and crosses midnight.
    if (w.endMinute > 1440) {
      const yesterday = local.minus({ days: 1 });
      const yWeekday = luxonToRegistryWeekday(yesterday.weekday);
      if (w.weekday === yWeekday && minuteOfDay + 1440 < w.endMinute) {
        return {
          openMinute: w.startMinute,
          closeMinute: w.endMinute,
          openDate: yesterday.toFormat('yyyy-MM-dd'),
        };
      }
    }
  }
  return null;
}

function inMaintenance(spec: InstrumentSpec, local: DateTime): string | null {
  const minuteOfDay = local.hour * 60 + local.minute;
  const weekday = luxonToRegistryWeekday(local.weekday);
  for (const m of spec.maintenanceWindows) {
    const applies = m.weekdays.length === 0 || m.weekdays.includes(weekday);
    if (applies && minuteOfDay >= m.startMinute && minuteOfDay < m.endMinute) return m.label;
  }
  return null;
}

export interface MarketStateResult {
  readonly state: MarketState;
  /** Why the market is not open, when it is not. */
  readonly reason: string | null;
  readonly exchangeLocal: string;
  readonly tradingDate: string;
}

export function getMarketState(spec: InstrumentSpec, epochMs: number): MarketStateResult {
  const local = exchangeTime(spec, epochMs);
  const isoDate = local.toFormat('yyyy-MM-dd');
  const base = { exchangeLocal: local.toISO() ?? '', tradingDate: tradingDate(spec, epochMs) };

  if (isFullClosure(isoDate)) {
    return { state: 'CLOSED', reason: getHoliday(isoDate)?.label ?? 'Exchange holiday', ...base };
  }

  // Evaluated before the session lookup: the daily break falls between two
  // session windows, so a window search would report it as plain CLOSED.
  const maintenance = inMaintenance(spec, local);
  if (maintenance) return { state: 'MAINTENANCE', reason: maintenance, ...base };

  const window = findWindow(spec, local);
  if (!window) return { state: 'CLOSED', reason: 'Outside trading session', ...base };

  // The evening session that opens on day D belongs to trading date D+1. If that
  // trading date is a full closure there is no evening session to open into —
  // which is why the market does not reopen on Christmas Eve at 17:00, even
  // though Christmas Eve itself is only an early close.
  const sessionDate = tradingDate(spec, epochMs);
  if (isFullClosure(sessionDate)) {
    return {
      state: 'CLOSED',
      reason: getHoliday(sessionDate)?.label ?? 'Exchange holiday',
      ...base,
    };
  }

  // An early close truncates the evening session that began on that date.
  const holiday = getHoliday(isoDate);
  if (holiday?.kind === 'EARLY' && holiday.closeMinute != null) {
    const minuteOfDay = local.hour * 60 + local.minute;
    if (minuteOfDay >= holiday.closeMinute && minuteOfDay < 17 * 60) {
      return { state: 'CLOSED', reason: `${holiday.label} — early close`, ...base };
    }
  }

  return { state: 'OPEN', reason: null, ...base };
}

export function isMarketOpen(spec: InstrumentSpec, epochMs: number): boolean {
  return getMarketState(spec, epochMs).state === 'OPEN';
}

/** True when the instant falls inside regular (cash-session) hours. */
export function isRegularHours(spec: InstrumentSpec, epochMs: number): boolean {
  const local = exchangeTime(spec, epochMs);
  const weekday = luxonToRegistryWeekday(local.weekday);
  if (weekday === 0 || weekday === 6) return false;
  const minuteOfDay = local.hour * 60 + local.minute;
  return (
    minuteOfDay >= spec.regularHours.startMinute && minuteOfDay < spec.regularHours.endMinute
  );
}

/**
 * Start of the trading session that `epochMs` belongs to, as epoch ms. Used by
 * the candle engine to place daily/weekly/monthly bar boundaries on the
 * exchange's session, not on UTC midnight.
 */
export function sessionStart(spec: InstrumentSpec, epochMs: number): number | null {
  const local = exchangeTime(spec, epochMs);
  const window = findWindow(spec, local);
  if (!window) return null;
  const openDay = DateTime.fromFormat(window.openDate, 'yyyy-MM-dd', { zone: spec.sessionTimezone });
  return openDay.plus({ minutes: window.openMinute }).toMillis();
}

/** End of the current session as epoch ms, or null when closed. */
export function sessionEnd(spec: InstrumentSpec, epochMs: number): number | null {
  const local = exchangeTime(spec, epochMs);
  const window = findWindow(spec, local);
  if (!window) return null;
  const openDay = DateTime.fromFormat(window.openDate, 'yyyy-MM-dd', { zone: spec.sessionTimezone });
  return openDay.plus({ minutes: window.closeMinute }).toMillis();
}

/** The next instant at which this instrument opens, searching forward. */
export function nextOpen(spec: InstrumentSpec, epochMs: number, maxDays = 10): number | null {
  let cursor = epochMs;
  const stepMs = 60_000;
  const limit = epochMs + maxDays * 86_400_000;
  // Coarse scan by minute is sufficient: session boundaries are minute-aligned.
  while (cursor < limit) {
    if (isMarketOpen(spec, cursor)) return cursor;
    cursor += stepMs;
  }
  return null;
}
