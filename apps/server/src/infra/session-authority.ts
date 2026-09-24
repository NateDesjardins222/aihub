/**
 * Exchange session authority (M4-I).
 *
 * ONE server-side authority for "is this market open". No component should guess
 * independently. It is a thin, deterministic layer over the pure calendar logic
 * in `@atlas/instruments` (`getMarketState`), adding exactly what the pure
 * function cannot express:
 *
 *  - UNKNOWN when the answer is genuinely unavailable — a date outside the
 *    hard-coded holiday-calendar coverage. If authoritative status is
 *    unavailable the answer is UNKNOWN, never OPEN.
 *  - HALTED when a trading halt has been explicitly registered for a root (e.g.
 *    a provider status message). The calendar never invents a halt.
 *
 * It takes the evaluation instant explicitly (callers pass the EXCHANGE clock —
 * the timestamp of the latest market observation — for replay/delayed feeds, not
 * wall clock). A `now`-based convenience exists for callers that legitimately
 * want wall clock (owner health surfaces).
 */
import {
  getInstrument,
  getMarketState,
  holidayCalendarCoverage,
} from '@atlas/instruments';
import type { SessionState, SessionStatus } from '@atlas/contracts';

/** A registered, time-bounded trading halt for a root. Cleared when it expires. */
interface Halt {
  readonly reason: string;
  readonly untilMs: number | null;
}

export class SessionAuthority {
  private readonly halts = new Map<string, Halt>();
  private readonly coverage = holidayCalendarCoverage();

  /** Register a trading halt for a root (e.g. from a provider status event). */
  registerHalt(root: string, reason: string, untilMs: number | null = null): void {
    this.halts.set(root.toUpperCase(), { reason, untilMs });
  }

  /** Clear a registered halt for a root. */
  clearHalt(root: string): void {
    this.halts.delete(root.toUpperCase());
  }

  /**
   * The authoritative session status for a root at an instant (exchange epoch ms).
   * Unknown root → UNKNOWN (authoritative:false), never a thrown error, so a
   * caller can gate safely on it.
   */
  status(root: string, epochMs: number): SessionStatus {
    const key = root.toUpperCase();
    const spec = getInstrument(key);
    if (!spec) {
      return {
        root: key,
        exchange: 'UNKNOWN',
        state: 'UNKNOWN',
        reason: `Unknown instrument ${key}`,
        tradingDate: null,
        exchangeLocal: null,
        authoritative: false,
      };
    }

    // A registered, unexpired halt wins over the calendar.
    const halt = this.halts.get(key);
    if (halt && (halt.untilMs === null || epochMs < halt.untilMs)) {
      const view = getMarketState(spec, epochMs);
      return {
        root: key,
        exchange: spec.exchange,
        state: 'HALTED',
        reason: halt.reason,
        tradingDate: view.tradingDate,
        exchangeLocal: view.exchangeLocal || null,
        authoritative: true,
      };
    }

    // Outside the holiday-calendar coverage the calendar silently treats a date
    // as open — which would be a lie. Report UNKNOWN so callers can be safe.
    const isoDate = exchangeDateOf(epochMs, spec.sessionTimezone);
    if (isoDate !== null && (isoDate < this.coverage.from || isoDate > this.coverage.to)) {
      const view = getMarketState(spec, epochMs);
      return {
        root: key,
        exchange: spec.exchange,
        state: 'UNKNOWN',
        reason: `Date ${isoDate} is outside the holiday calendar coverage (${this.coverage.from}..${this.coverage.to})`,
        tradingDate: view.tradingDate,
        exchangeLocal: view.exchangeLocal || null,
        authoritative: false,
      };
    }

    const view = getMarketState(spec, epochMs);
    return {
      root: key,
      exchange: spec.exchange,
      state: view.state as SessionState, // OPEN|CLOSED|MAINTENANCE|PRE_OPEN
      reason: view.reason ?? '',
      tradingDate: view.tradingDate,
      exchangeLocal: view.exchangeLocal || null,
      authoritative: true,
    };
  }

  /** Convenience: status at wall-clock now. Owner/health surfaces only. */
  statusNow(root: string): SessionStatus {
    return this.status(root, Date.now());
  }

  /** True only when the market is authoritatively OPEN. Anything else is false. */
  isOpen(root: string, epochMs: number): boolean {
    return this.status(root, epochMs).state === 'OPEN';
  }
}

/** Exchange-local ISO date (yyyy-MM-dd) for an instant, or null on failure. */
function exchangeDateOf(epochMs: number, timezone: string): string | null {
  try {
    // Intl is available in Node; avoids a Luxon import here.
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date(epochMs)); // en-CA => yyyy-MM-dd
  } catch {
    return null;
  }
}

/** Shared authority. Stateless except for registered halts. */
export const sessionAuthority = new SessionAuthority();
