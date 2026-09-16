/**
 * Active-contract (front month) resolution.
 *
 * The delayed Phase 1 feed gives us a continuous front-month series, so the
 * active contract is derived from the exchange's listing cycle rather than
 * hardcoded. When a licensed feed supplies explicit contract symbols this module
 * is what maps them.
 */
import { DateTime } from 'luxon';
import type { InstrumentSpec, RollRule } from '@atlas/contracts';
import { isFullClosure } from './holidays.js';

/** CME month codes, index 0 = January. */
export const MONTH_CODES = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'] as const;
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

export interface ActiveContract {
  /** e.g. "NQZ26" */
  readonly code: string;
  /** e.g. "NQ DEC 26" */
  readonly display: string;
  readonly month: number; // 1-12
  readonly year: number;
  /** Last trading day, epoch ms at exchange-local midnight. */
  readonly lastTradingDay: number;
  /** Instant at which the front month rolls to the next contract, epoch ms. */
  readonly rollDate: number;
}

function monthsForCycle(rule: RollRule): readonly number[] {
  switch (rule.cycle.kind) {
    case 'QUARTERLY':
      return [3, 6, 9, 12];
    case 'MONTHLY':
      return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    case 'CUSTOM':
      return rule.cycle.months;
  }
}

function isBusinessDay(dt: DateTime): boolean {
  if (dt.weekday === 6 || dt.weekday === 7) return false;
  return !isFullClosure(dt.toFormat('yyyy-MM-dd'));
}

/** Walk backwards `n` business days from `dt` (exclusive of dt itself). */
function minusBusinessDays(dt: DateTime, n: number): DateTime {
  let cursor = dt;
  let remaining = n;
  while (remaining > 0) {
    cursor = cursor.minus({ days: 1 });
    if (isBusinessDay(cursor)) remaining -= 1;
  }
  return cursor;
}

function thirdFriday(year: number, month: number, zone: string): DateTime {
  let dt = DateTime.fromObject({ year, month, day: 1 }, { zone });
  // Advance to the first Friday, then add two weeks.
  const offset = (5 - dt.weekday + 7) % 7;
  dt = dt.plus({ days: offset + 14 });
  return dt;
}

/** Last trading day for a given contract month, at exchange-local midnight. */
export function lastTradingDay(spec: InstrumentSpec, year: number, month: number): DateTime {
  const zone = spec.sessionTimezone;
  const rule = spec.rollRule;
  switch (rule.expiry.kind) {
    case 'THIRD_FRIDAY':
      return thirdFriday(year, month, zone).startOf('day');
    case 'BUSINESS_DAYS_BEFORE_DAY': {
      // Energy convention: N business days before day D of the PRECEDING month.
      const anchor = DateTime.fromObject(
        { year, month, day: rule.expiry.dayOfMonth },
        { zone },
      ).minus({ months: 1 });
      return minusBusinessDays(anchor, rule.expiry.businessDays).startOf('day');
    }
    case 'BUSINESS_DAYS_BEFORE_MONTH_END': {
      // Metals convention: N business days before the end of the delivery month.
      const endOfMonth = DateTime.fromObject({ year, month }, { zone }).endOf('month').startOf('day');
      return minusBusinessDays(endOfMonth.plus({ days: 1 }), rule.expiry.businessDays).startOf('day');
    }
  }
}

/**
 * Resolve the front-month contract for an instant. Returns the first listed
 * contract whose roll date has not yet passed.
 */
export function resolveActiveContract(spec: InstrumentSpec, asOfMs: number): ActiveContract {
  const zone = spec.sessionTimezone;
  const asOf = DateTime.fromMillis(asOfMs, { zone });
  const cycleMonths = monthsForCycle(spec.rollRule);

  for (let offset = 0; offset < 36; offset += 1) {
    const candidate = asOf.plus({ months: offset });
    const year = candidate.year;
    const month = candidate.month;
    if (!cycleMonths.includes(month)) continue;

    const ltd = lastTradingDay(spec, year, month);
    const roll = ltd.minus({ days: spec.rollRule.rollDaysBeforeExpiry });
    if (roll.toMillis() > asOfMs) {
      const code = `${spec.root}${MONTH_CODES[month - 1]}${String(year % 100).padStart(2, '0')}`;
      return {
        code,
        display: `${spec.root} ${MONTH_NAMES[month - 1]} ${String(year % 100).padStart(2, '0')}`,
        month,
        year,
        lastTradingDay: ltd.toMillis(),
        rollDate: roll.toMillis(),
      };
    }
  }
  throw new Error(`Unable to resolve active contract for ${spec.root}`);
}

/** True when a contract has passed its last trading day. */
export function isExpired(contract: ActiveContract, asOfMs: number): boolean {
  return asOfMs > contract.lastTradingDay + 86_400_000;
}
