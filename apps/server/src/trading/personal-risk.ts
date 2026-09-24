/**
 * Personal risk controls — the PURE evaluator, validator, and comparators.
 *
 * Trader-configured controls that can only make an account MORE restrictive than
 * firm rules. This module is pure and deterministic (no DB, no clock of its own):
 * the caller supplies the authoritative day state, day P&L, equity, exchange
 * clock and session. It is evaluated by the engine ONLY when the firm gate
 * (`checkOrder`) already allowed the order, and ONLY against the exposure-
 * INCREASING portion — a reduce / flatten / protective order is never blocked.
 *
 * Semantics are locked in docs/trader-risk-controls-semantics.md.
 */
import type {
  PersonalControlMode,
  PersonalControlType,
  PersonalControlValue,
  RejectReason,
} from '@atlas/contracts';
import { PERSONAL_REJECT_BY_CONTROL } from '@atlas/contracts';
import { increasingQty } from './risk.js';

export interface RiskRejection {
  readonly reason: RejectReason;
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}

/** One control, normalized to its runtime shape. */
export interface PersonalControl extends PersonalControlValue {
  readonly controlType: PersonalControlType;
  readonly enabled: boolean;
  readonly mode: PersonalControlMode;
  readonly lockedTradingDay: string | null;
  readonly version: number;
}

/** The full personal config for one account (only ENABLED controls matter to the gate). */
export type PersonalConfig = ReadonlyMap<PersonalControlType, PersonalControl>;

/** Per-trading-day counters, maintained on the fill path. */
export interface PersonalDayState {
  readonly openingTradeCount: number;
  readonly contractsOpened: number;
  readonly consecutiveLosses: number;
  readonly lastLossClosedAtMs: number | null;
  readonly dayHighEquityMicros: number | null;
}

/** The authoritative live context the gate needs, supplied by the engine. */
export interface PersonalRiskContext {
  readonly positionQty: number;
  readonly side: 'BUY' | 'SELL';
  readonly qty: number;
  /** Realized net trading P&L for the current trading day (fees included). */
  readonly dayPnlMicros: number;
  /** Current account equity, or null when unmarkable (never fabricated). */
  readonly equityMicros: number | null;
  /** Exchange clock (ms) — session/window checks use this, never wall clock. */
  readonly marketNowMs: number;
  /** Wall clock (ms) — cooldown elapsed-time uses this. */
  readonly nowMs: number;
  /** The instrument's exchange timezone (IANA), for the trading-window check. */
  readonly sessionTimezone: string;
  /** Authoritative market-state phase for the instrument (OPEN/CLOSED/...). */
  readonly sessionState: string;
}

const EMPTY_DAY: PersonalDayState = {
  openingTradeCount: 0,
  contractsOpened: 0,
  consecutiveLosses: 0,
  lastLossClosedAtMs: null,
  dayHighEquityMicros: null,
};

/** HH:MM (24h) for an epoch-ms in a timezone, deterministic via Intl. */
export function hhmmInZone(ms: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(ms));
    const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
    // Intl can emit "24" for midnight in some environments; normalize.
    return `${hh === '24' ? '00' : hh}:${mm}`;
  } catch {
    return '00:00';
  }
}

function minutesOf(hhmm: string): number {
  const parts = hhmm.split(':');
  const h = Number.parseInt(parts[0] ?? '0', 10);
  const m = Number.parseInt(parts[1] ?? '0', 10);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** Is `t` (HH:MM) within [start, end)? Supports windows that wrap midnight. */
export function withinWindow(t: string, start: string, end: string): boolean {
  const tt = minutesOf(t);
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === e) return true; // degenerate full-day window
  if (s < e) return tt >= s && tt < e;
  return tt >= s || tt < e; // wraps midnight
}

/**
 * Evaluate personal controls against the exposure-INCREASING portion of an order.
 * Returns a structured rejection, or null to allow. Never blocks a reducing/
 * flattening/protective order (increasing === 0 ⇒ always allowed).
 */
export function evaluatePersonalRisk(
  config: PersonalConfig,
  dayState: PersonalDayState | null,
  ctx: PersonalRiskContext,
): RiskRejection | null {
  const signed = ctx.side === 'BUY' ? ctx.qty : -ctx.qty;
  const increasing = increasingQty(ctx.positionQty, signed);
  if (increasing <= 0) return null; // never strand a position

  const day = dayState ?? EMPTY_DAY;

  // Cheapest, time/session gates first, then counters, then P&L-derived.
  const window = enabled(config, 'TRADING_WINDOW');
  if (window && window.windowStart && window.windowEnd) {
    const t = hhmmInZone(ctx.marketNowMs, ctx.sessionTimezone);
    if (!withinWindow(t, window.windowStart, window.windowEnd)) {
      return reject('TRADING_WINDOW', `Outside your trading window (${window.windowStart}–${window.windowEnd}).`, {
        now: t,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
      });
    }
  }

  const session = enabled(config, 'SESSION_RESTRICTION');
  if (session && Array.isArray(session.sessions) && session.sessions.length > 0) {
    if (!session.sessions.includes(ctx.sessionState)) {
      return reject('SESSION_RESTRICTION', `Trading is restricted to ${session.sessions.join(', ')} (now ${ctx.sessionState}).`, {
        current: ctx.sessionState,
        allowed: session.sessions,
      });
    }
  }

  const cooldown = enabled(config, 'COOLDOWN');
  if (cooldown && cooldown.valueInt && day.lastLossClosedAtMs != null) {
    const untilMs = day.lastLossClosedAtMs + cooldown.valueInt * 60_000;
    if (ctx.nowMs < untilMs) {
      return reject('COOLDOWN', `Loss cooldown active (${cooldown.valueInt} min).`, {
        remainingMs: untilMs - ctx.nowMs,
        minutes: cooldown.valueInt,
      });
    }
  }

  const consec = enabled(config, 'CONSECUTIVE_LOSS_LOCK');
  if (consec && consec.valueInt && day.consecutiveLosses >= consec.valueInt) {
    return reject('CONSECUTIVE_LOSS_LOCK', `Consecutive-loss lock reached (${day.consecutiveLosses}/${consec.valueInt}).`, {
      current: day.consecutiveLosses,
      limit: consec.valueInt,
    });
  }

  const maxTrades = enabled(config, 'MAX_TRADES');
  if (maxTrades && maxTrades.valueInt && day.openingTradeCount >= maxTrades.valueInt) {
    return reject('MAX_TRADES', `Daily trade limit reached (${day.openingTradeCount}/${maxTrades.valueInt}).`, {
      used: day.openingTradeCount,
      limit: maxTrades.valueInt,
    });
  }

  const maxContracts = enabled(config, 'DAILY_CONTRACT_LIMIT');
  if (maxContracts && maxContracts.valueInt && day.contractsOpened + increasing > maxContracts.valueInt) {
    return reject('DAILY_CONTRACT_LIMIT', `Daily contract limit reached (${day.contractsOpened}/${maxContracts.valueInt}).`, {
      used: day.contractsOpened,
      requested: increasing,
      limit: maxContracts.valueInt,
    });
  }

  const maxPosition = enabled(config, 'MAX_POSITION');
  if (maxPosition && maxPosition.valueInt) {
    const projected = Math.abs(ctx.positionQty) + increasing;
    if (projected > maxPosition.valueInt) {
      return reject('MAX_POSITION', `Personal max position is ${maxPosition.valueInt} contracts.`, {
        projected,
        limit: maxPosition.valueInt,
      });
    }
  }

  const profitLock = enabled(config, 'PROFIT_LOCK');
  if (profitLock && profitLock.valueMicros && ctx.dayPnlMicros >= profitLock.valueMicros) {
    return reject('PROFIT_LOCK', 'Daily profit lock reached — new exposure is locked for today.', {
      dayPnlMicros: ctx.dayPnlMicros,
      thresholdMicros: profitLock.valueMicros,
    });
  }

  const dailyLoss = enabled(config, 'DAILY_LOSS_LIMIT');
  if (dailyLoss && dailyLoss.valueMicros && ctx.dayPnlMicros <= -dailyLoss.valueMicros) {
    return reject('DAILY_LOSS_LIMIT', 'Personal daily loss limit reached.', {
      dayPnlMicros: ctx.dayPnlMicros,
      limitMicros: dailyLoss.valueMicros,
    });
  }

  const drawdown = enabled(config, 'DAILY_DRAWDOWN');
  if (drawdown && drawdown.valueMicros && ctx.equityMicros != null && day.dayHighEquityMicros != null) {
    const dd = day.dayHighEquityMicros - ctx.equityMicros;
    if (dd >= drawdown.valueMicros) {
      return reject('DAILY_DRAWDOWN', 'Personal daily drawdown limit reached.', {
        drawdownMicros: dd,
        limitMicros: drawdown.valueMicros,
      });
    }
  }

  return null;
}

function enabled(config: PersonalConfig, type: PersonalControlType): PersonalControl | null {
  const c = config.get(type);
  return c && c.enabled ? c : null;
}

function reject(type: PersonalControlType, message: string, detail: Record<string, unknown>): RiskRejection {
  return { reason: PERSONAL_REJECT_BY_CONTROL[type], message, detail };
}

// ---------------------------------------------------------------------------
// Validation + tighten/loosen comparator (used by the CRUD service)
// ---------------------------------------------------------------------------

const MAX_MICROS = 1_000_000_000 * 1_000_000; // $1e9, safe upper bound
const MAX_INT = 100_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface ValueError {
  readonly field: string;
  readonly message: string;
}

/** Validate a control value for its type. Returns null when valid. */
export function validateControlValue(
  type: PersonalControlType,
  value: PersonalControlValue,
): ValueError | null {
  const posMicros = (v: number | null | undefined, field: string): ValueError | null => {
    if (v == null || !Number.isFinite(v)) return { field, message: 'A positive amount is required.' };
    if (v <= 0) return { field, message: 'Must be greater than zero.' };
    if (v > MAX_MICROS) return { field, message: 'Amount is too large.' };
    if (!Number.isInteger(v)) return { field, message: 'Amount must be a whole number of micro-dollars.' };
    return null;
  };
  const posInt = (v: number | null | undefined, field: string, min = 1): ValueError | null => {
    if (v == null || !Number.isFinite(v)) return { field, message: 'A positive whole number is required.' };
    if (!Number.isInteger(v)) return { field, message: 'Must be a whole number.' };
    if (v < min) return { field, message: `Must be at least ${min}.` };
    if (v > MAX_INT) return { field, message: 'Value is too large.' };
    return null;
  };
  switch (type) {
    case 'DAILY_LOSS_LIMIT':
    case 'DAILY_DRAWDOWN':
    case 'PROFIT_LOCK':
      return posMicros(value.valueMicros, 'valueMicros');
    case 'MAX_TRADES':
    case 'MAX_POSITION':
    case 'DAILY_CONTRACT_LIMIT':
    case 'CONSECUTIVE_LOSS_LOCK':
      return posInt(value.valueInt, 'valueInt');
    case 'COOLDOWN':
      return posInt(value.valueInt, 'valueInt'); // minutes
    case 'TRADING_WINDOW': {
      if (!value.windowStart || !TIME_RE.test(value.windowStart)) return { field: 'windowStart', message: 'Start time must be HH:MM.' };
      if (!value.windowEnd || !TIME_RE.test(value.windowEnd)) return { field: 'windowEnd', message: 'End time must be HH:MM.' };
      if (value.windowStart === value.windowEnd) return { field: 'windowEnd', message: 'Start and end cannot be equal.' };
      return null;
    }
    case 'SESSION_RESTRICTION': {
      const s = value.sessions;
      if (!Array.isArray(s) || s.length === 0) return { field: 'sessions', message: 'Choose at least one session.' };
      const allowed = new Set(['OPEN', 'PRE_OPEN', 'MAINTENANCE', 'CLOSED']);
      for (const x of s) if (!allowed.has(x)) return { field: 'sessions', message: `Unknown session ${x}.` };
      return null;
    }
    default:
      return { field: 'controlType', message: 'Unknown control.' };
  }
}

/**
 * Is `next` strictly MORE restrictive than `prev` for this control? Used to allow
 * tightening a LOCKED control while forbidding loosening. A value that is equal is
 * not "stricter" (locked controls reject a no-op loosen as not-a-tighten only when
 * combined with disable/loosen intent — see the service).
 */
export function isStricter(
  type: PersonalControlType,
  prev: PersonalControlValue,
  next: PersonalControlValue,
): boolean {
  switch (type) {
    // Smaller magnitude = stricter.
    case 'DAILY_LOSS_LIMIT':
    case 'DAILY_DRAWDOWN':
    case 'PROFIT_LOCK':
      return num(next.valueMicros) < num(prev.valueMicros);
    case 'MAX_TRADES':
    case 'MAX_POSITION':
    case 'DAILY_CONTRACT_LIMIT':
    case 'CONSECUTIVE_LOSS_LOCK':
      return num(next.valueInt) < num(prev.valueInt);
    // Longer cooldown = stricter.
    case 'COOLDOWN':
      return num(next.valueInt) > num(prev.valueInt);
    // Narrower window = stricter (later start AND/OR earlier end, at least one).
    case 'TRADING_WINDOW': {
      const ps = minutesOf(prev.windowStart ?? '00:00');
      const pe = minutesOf(prev.windowEnd ?? '00:00');
      const ns = minutesOf(next.windowStart ?? '00:00');
      const ne = minutesOf(next.windowEnd ?? '00:00');
      return (ns >= ps && ne <= pe) && (ns > ps || ne < pe);
    }
    // A strict subset of allowed sessions = stricter.
    case 'SESSION_RESTRICTION': {
      const prevSet = new Set(prev.sessions ?? []);
      const nextArr = next.sessions ?? [];
      const subset = nextArr.every((x) => prevSet.has(x));
      return subset && nextArr.length < prevSet.size;
    }
    default:
      return false;
  }
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
}
