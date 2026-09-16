import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { requireInstrument } from './registry.js';
import {
  exchangeDate,
  getMarketState,
  isMarketOpen,
  isRegularHours,
  sessionEnd,
  sessionStart,
  tradingDate,
} from './session.js';
import { resolveActiveContract, lastTradingDay, isExpired, MONTH_CODES } from './contracts.js';

const NQ = requireInstrument('NQ');
const GC = requireInstrument('GC');
const CL = requireInstrument('CL');

/** Build an epoch-ms instant from an exchange-local wall clock reading. */
function ct(iso: string): number {
  const dt = DateTime.fromISO(iso, { zone: 'America/Chicago' });
  if (!dt.isValid) throw new Error(`bad test instant: ${iso} (${dt.invalidReason})`);
  return dt.toMillis();
}

describe('session calendar', () => {
  it('is open during the Tuesday regular session', () => {
    expect(isMarketOpen(NQ, ct('2026-09-15T09:30'))).toBe(true);
  });

  it('is closed during the daily maintenance break', () => {
    const state = getMarketState(NQ, ct('2026-09-15T16:30'));
    expect(state.state).toBe('MAINTENANCE');
    expect(state.reason).toBe('Daily maintenance');
  });

  it('halts equity index products around the cash close but not metals', () => {
    expect(getMarketState(NQ, ct('2026-09-15T15:20')).state).toBe('MAINTENANCE');
    expect(getMarketState(GC, ct('2026-09-15T15:20')).state).toBe('OPEN');
  });

  it('reopens for the overnight session at 17:00 CT', () => {
    expect(isMarketOpen(NQ, ct('2026-09-15T16:59'))).toBe(false);
    expect(isMarketOpen(NQ, ct('2026-09-15T17:00'))).toBe(true);
    expect(isMarketOpen(NQ, ct('2026-09-15T23:30'))).toBe(true);
    expect(isMarketOpen(NQ, ct('2026-09-16T03:00'))).toBe(true);
  });

  it('is closed over the weekend and opens Sunday evening', () => {
    expect(isMarketOpen(NQ, ct('2026-09-19T10:00'))).toBe(false); // Saturday
    expect(isMarketOpen(NQ, ct('2026-09-20T12:00'))).toBe(false); // Sunday midday
    expect(isMarketOpen(NQ, ct('2026-09-20T17:00'))).toBe(true); // Sunday open
  });

  it('is closed on a full exchange holiday', () => {
    const state = getMarketState(NQ, ct('2026-12-25T10:00'));
    expect(state.state).toBe('CLOSED');
    expect(state.reason).toBe('Christmas Day');
  });

  it('respects an early close', () => {
    expect(isMarketOpen(NQ, ct('2026-11-27T11:00'))).toBe(true);
    const after = getMarketState(NQ, ct('2026-11-27T13:00'));
    expect(after.state).toBe('CLOSED');
    expect(after.reason).toContain('early close');
  });

  it('assigns overnight activity to the NEXT trading date', () => {
    // 18:00 CT Monday belongs to Tuesday's trading day.
    expect(tradingDate(NQ, ct('2026-09-14T18:00'))).toBe('2026-09-15');
    expect(tradingDate(NQ, ct('2026-09-15T09:30'))).toBe('2026-09-15');
    expect(tradingDate(NQ, ct('2026-09-15T02:00'))).toBe('2026-09-15');
    // ...and that is deliberately different from the calendar date.
    expect(exchangeDate(NQ, ct('2026-09-14T18:00'))).toBe('2026-09-14');
  });

  it('bounds the session containing an instant', () => {
    const inside = ct('2026-09-15T09:30');
    expect(sessionStart(NQ, inside)).toBe(ct('2026-09-14T17:00'));
    expect(sessionEnd(NQ, inside)).toBe(ct('2026-09-15T16:00'));
  });

  it('distinguishes regular hours from the overnight session', () => {
    expect(isRegularHours(NQ, ct('2026-09-15T09:30'))).toBe(true);
    expect(isRegularHours(NQ, ct('2026-09-15T03:00'))).toBe(false);
    // Metals keep different regular hours from equity index.
    expect(isRegularHours(GC, ct('2026-09-15T07:30'))).toBe(true);
    expect(isRegularHours(NQ, ct('2026-09-15T07:30'))).toBe(false);
  });

  it('handles DST without an offset constant', () => {
    // The session still opens at 17:00 local on both sides of the change.
    expect(isMarketOpen(NQ, ct('2026-03-03T17:00'))).toBe(true); // Tue, CST
    expect(isMarketOpen(NQ, ct('2026-03-10T17:00'))).toBe(true); // Tue, CDT
  });
});

describe('contract roll calendar', () => {
  it('uses quarterly months for equity index products', () => {
    const c = resolveActiveContract(NQ, ct('2026-09-16T12:00'));
    expect([3, 6, 9, 12]).toContain(c.month);
    expect(c.code).toMatch(/^NQ[HMUZ]\d{2}$/);
  });

  it('rolls NQ from September to December before the September expiry', () => {
    const beforeRoll = resolveActiveContract(NQ, ct('2026-09-05T12:00'));
    expect(beforeRoll.month).toBe(9);
    expect(beforeRoll.code).toBe('NQU26');

    // Sep 2026 expiry is the third Friday, 18 Sep; roll is 8 days earlier.
    const afterRoll = resolveActiveContract(NQ, ct('2026-09-15T12:00'));
    expect(afterRoll.month).toBe(12);
    expect(afterRoll.code).toBe('NQZ26');
  });

  it('places equity index expiry on the third Friday', () => {
    const ltd = lastTradingDay(NQ, 2026, 9);
    expect(ltd.toFormat('yyyy-MM-dd')).toBe('2026-09-18');
    expect(ltd.weekday).toBe(5);
  });

  it('uses the gold delivery cycle, not a quarterly one', () => {
    const c = resolveActiveContract(GC, ct('2026-09-16T12:00'));
    expect([2, 4, 6, 8, 10, 12]).toContain(c.month);
  });

  it('lists crude oil every month and expires before the 25th of the prior month', () => {
    const c = resolveActiveContract(CL, ct('2026-09-16T12:00'));
    const ltd = lastTradingDay(CL, 2026, 11);
    // 3 business days before 25 Oct 2026 (a Sunday) -> 21 Oct 2026.
    expect(ltd.toFormat('yyyy-MM-dd')).toBe('2026-10-21');
    expect(c.month).toBeGreaterThanOrEqual(9);
  });

  it('never returns an already-expired contract', () => {
    const now = ct('2026-09-16T12:00');
    for (const root of ['NQ', 'MNQ', 'ES', 'MES', 'GC', 'MGC', 'CL', 'MCL']) {
      const spec = requireInstrument(root);
      const c = resolveActiveContract(spec, now);
      expect(isExpired(c, now), `${root} ${c.code}`).toBe(false);
      expect(c.rollDate).toBeGreaterThan(now);
    }
  });

  it('uses the CME month code alphabet', () => {
    expect(MONTH_CODES[8]).toBe('U'); // September
    expect(MONTH_CODES[11]).toBe('Z'); // December
  });
});

describe('weekly close is not reported as a daily break', () => {
  it('calls Friday 16:30 CT closed, not maintenance', () => {
    // A trader must not be told the market reopens in an hour when it reopens Sunday.
    const state = getMarketState(NQ, ct('2026-09-18T16:30'));
    expect(state.state).toBe('CLOSED');
  });

  it('still calls Tuesday 16:30 CT maintenance', () => {
    expect(getMarketState(NQ, ct('2026-09-15T16:30')).state).toBe('MAINTENANCE');
  });
});
