/**
 * CME Group holiday calendar (full closures and early closes).
 *
 * Dates are exchange-local (US/Central) calendar dates. This is reference data,
 * not a schedule we invent: the engine consults it so candles are not created
 * for periods when the market did not trade.
 *
 * Early closes carry the exchange-local minute at which trading halts for the day.
 */
export interface HolidayEntry {
  readonly date: string; // YYYY-MM-DD, exchange local
  readonly label: string;
  /** FULL = no trading that day. EARLY = trading halts at closeMinute. */
  readonly kind: 'FULL' | 'EARLY';
  /** Minutes from exchange-local midnight; only meaningful when kind === 'EARLY'. */
  readonly closeMinute?: number;
}

const EARLY_1200 = 12 * 60; // 12:00 CT

export const CME_HOLIDAYS: readonly HolidayEntry[] = [
  { date: '2025-01-01', label: "New Year's Day", kind: 'FULL' },
  { date: '2025-01-20', label: 'Martin Luther King Jr. Day', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2025-02-17', label: "Presidents' Day", kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2025-04-18', label: 'Good Friday', kind: 'FULL' },
  { date: '2025-05-26', label: 'Memorial Day', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2025-06-19', label: 'Juneteenth', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2025-07-04', label: 'Independence Day', kind: 'FULL' },
  { date: '2025-09-01', label: 'Labor Day', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2025-11-27', label: 'Thanksgiving', kind: 'FULL' },
  { date: '2025-11-28', label: 'Day after Thanksgiving', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2025-12-25', label: 'Christmas Day', kind: 'FULL' },

  { date: '2026-01-01', label: "New Year's Day", kind: 'FULL' },
  { date: '2026-01-19', label: 'Martin Luther King Jr. Day', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2026-02-16', label: "Presidents' Day", kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2026-04-03', label: 'Good Friday', kind: 'FULL' },
  { date: '2026-05-25', label: 'Memorial Day', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2026-06-19', label: 'Juneteenth', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2026-07-03', label: 'Independence Day (observed)', kind: 'FULL' },
  { date: '2026-09-07', label: 'Labor Day', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2026-11-26', label: 'Thanksgiving', kind: 'FULL' },
  { date: '2026-11-27', label: 'Day after Thanksgiving', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2026-12-25', label: 'Christmas Day', kind: 'FULL' },

  { date: '2027-01-01', label: "New Year's Day", kind: 'FULL' },
  { date: '2027-01-18', label: 'Martin Luther King Jr. Day', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2027-02-15', label: "Presidents' Day", kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2027-03-26', label: 'Good Friday', kind: 'FULL' },
  { date: '2027-05-31', label: 'Memorial Day', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2027-06-18', label: 'Juneteenth (observed)', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2027-07-05', label: 'Independence Day (observed)', kind: 'FULL' },
  { date: '2027-09-06', label: 'Labor Day', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2027-11-25', label: 'Thanksgiving', kind: 'FULL' },
  { date: '2027-11-26', label: 'Day after Thanksgiving', kind: 'EARLY', closeMinute: EARLY_1200 },
  { date: '2027-12-24', label: 'Christmas Day (observed)', kind: 'FULL' },
];

const BY_DATE: ReadonlyMap<string, HolidayEntry> = new Map(
  CME_HOLIDAYS.map((h) => [h.date, h]),
);

export function getHoliday(isoDate: string): HolidayEntry | undefined {
  return BY_DATE.get(isoDate);
}

/**
 * True when the calendar has no entry for this date. Dates outside the loaded
 * range return true — the caller is responsible for keeping the table current,
 * and `holidayCalendarCoverage()` exposes the range so staleness is visible.
 */
export function isFullClosure(isoDate: string): boolean {
  return BY_DATE.get(isoDate)?.kind === 'FULL';
}

export function holidayCalendarCoverage(): { from: string; to: string } {
  const first = CME_HOLIDAYS[0]?.date ?? '';
  const last = CME_HOLIDAYS[CME_HOLIDAYS.length - 1]?.date ?? '';
  return { from: first, to: last };
}
