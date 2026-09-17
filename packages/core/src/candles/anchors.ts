/**
 * Named instants inside a trading session.
 *
 * "Jump to the New York open" is the most common thing a trader wants from a
 * replay, and the answer differs by product: a Globex session opens the evening
 * before, London walks in overnight, and the New York cash open is the moment
 * most intraday ranges are built around. These are computed from the
 * instrument's own calendar rather than hardcoded, so an energy contract and an
 * equity index contract each get their own.
 */
import { DateTime } from 'luxon';
import type { InstrumentSpec } from '@atlas/contracts';
import { sessionOpenForTradingDate } from './timeframe.js';

export type SessionAnchorId =
  | 'SESSION_OPEN'
  | 'ASIA'
  | 'LONDON_OPEN'
  | 'PRE_NY'
  | 'NY_OPEN'
  | 'RTH_OPEN'
  | 'MIDDAY'
  | 'PM'
  | 'RTH_CLOSE'
  | 'SESSION_CLOSE';

export interface SessionAnchor {
  readonly id: SessionAnchorId;
  readonly label: string;
  /** Exchange epoch ms of the anchor on this trading date. */
  readonly at: number;
  readonly description: string;
}

/** Minutes past midnight in the EXCHANGE's timezone for the fixed anchors. */
const FIXED: ReadonlyArray<{
  id: SessionAnchorId;
  label: string;
  minute: number;
  description: string;
}> = [
  { id: 'ASIA', label: 'Asia', minute: 19 * 60, description: 'Tokyo morning, 09:00 JST' },
  { id: 'LONDON_OPEN', label: 'London open', minute: 2 * 60, description: '08:00 London' },
  { id: 'PRE_NY', label: 'Pre-market', minute: 7 * 60, description: '08:00 New York' },
  { id: 'NY_OPEN', label: 'NY open', minute: 8 * 60 + 30, description: '09:30 New York, cash open' },
  { id: 'MIDDAY', label: 'Midday', minute: 11 * 60, description: 'The lunchtime lull' },
  { id: 'PM', label: 'PM session', minute: 13 * 60, description: 'The afternoon trend window' },
];

/**
 * An exchange-local time of day, placed on the right calendar day.
 *
 * A CME trading date runs from 17:00 the evening before to 16:00 on the date
 * itself, so a clock time at or after the session open belongs to the PREVIOUS
 * calendar day. Without that, "Asia" on the 15th lands twenty-six hours after
 * the session it belongs to opened.
 */
function atMinute(spec: InstrumentSpec, tradingDate: string, minute: number): number {
  const openMinute = spec.sessionWindows[0]?.startMinute ?? 17 * 60;
  const evening = openMinute < 24 * 60 && minute >= openMinute;
  return DateTime.fromFormat(tradingDate, 'yyyy-MM-dd', { zone: spec.sessionTimezone })
    .startOf('day')
    .minus({ days: evening ? 1 : 0 })
    .plus({ minutes: minute })
    .toMillis();
}

/**
 * Every anchor for one instrument on one trading date, in chronological order.
 *
 * A CME trading date starts the evening BEFORE it, so the session open lands on
 * the previous calendar day while everything else lands on the date itself.
 */
export function sessionAnchors(spec: InstrumentSpec, tradingDate: string): SessionAnchor[] {
  const open = sessionOpenForTradingDate(spec, tradingDate);
  const anchors: SessionAnchor[] = [
    {
      id: 'SESSION_OPEN',
      label: 'Session open',
      at: open,
      description: 'The Globex open, the evening before',
    },
    {
      id: 'RTH_OPEN',
      label: 'RTH open',
      at: atMinute(spec, tradingDate, spec.regularHours.startMinute),
      description: 'Regular trading hours for this product',
    },
    {
      id: 'RTH_CLOSE',
      label: 'RTH close',
      at: atMinute(spec, tradingDate, spec.regularHours.endMinute),
      description: 'The regular-hours close',
    },
    ...FIXED.map((fixed) => ({
      id: fixed.id,
      label: fixed.label,
      at: atMinute(spec, tradingDate, fixed.minute),
      description: fixed.description,
    })),
  ];

  // Anything that still lands before the open belongs to the next day's clock
  // rather than to a session that had not started.
  return anchors
    .map((anchor) =>
      anchor.id !== 'SESSION_OPEN' && anchor.at < open
        ? { ...anchor, at: anchor.at + 24 * 3_600_000 }
        : anchor,
    )
    .sort((a, b) => a.at - b.at);
}

/** The anchors that fall inside a recording's span, which are the useful ones. */
export function anchorsWithin(
  spec: InstrumentSpec,
  tradingDate: string,
  startTs: number,
  endTs: number,
): SessionAnchor[] {
  return sessionAnchors(spec, tradingDate).filter(
    (anchor) => anchor.at >= startTs && anchor.at <= endTs,
  );
}
