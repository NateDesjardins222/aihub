/**
 * Trader Personal Risk Controls (Milestone 5) — shared contracts.
 *
 * A trader-configured, server-authoritative risk-control system that can only
 * make an account MORE restrictive than the firm rules. These types are shared
 * by the server (domain + gate + API) and the web portal (Controls UI). The
 * browser never enforces any of this — it only renders server-derived state.
 */

/** The ten personal control types. */
export type PersonalControlType =
  | 'DAILY_LOSS_LIMIT'
  | 'MAX_TRADES'
  | 'DAILY_DRAWDOWN'
  | 'MAX_POSITION'
  | 'DAILY_CONTRACT_LIMIT'
  | 'PROFIT_LOCK'
  | 'CONSECUTIVE_LOSS_LOCK'
  | 'COOLDOWN'
  | 'TRADING_WINDOW'
  | 'SESSION_RESTRICTION';

export const PERSONAL_CONTROL_TYPES: readonly PersonalControlType[] = [
  'DAILY_LOSS_LIMIT',
  'MAX_TRADES',
  'DAILY_DRAWDOWN',
  'MAX_POSITION',
  'DAILY_CONTRACT_LIMIT',
  'PROFIT_LOCK',
  'CONSECUTIVE_LOSS_LOCK',
  'COOLDOWN',
  'TRADING_WINDOW',
  'SESSION_RESTRICTION',
];

/** How a control's value is shaped, so the UI and validator agree. */
export type PersonalControlValueKind = 'MICROS' | 'INT' | 'WINDOW' | 'SESSIONS';

export const PERSONAL_CONTROL_KIND: Record<PersonalControlType, PersonalControlValueKind> = {
  DAILY_LOSS_LIMIT: 'MICROS',
  MAX_TRADES: 'INT',
  DAILY_DRAWDOWN: 'MICROS',
  MAX_POSITION: 'INT',
  DAILY_CONTRACT_LIMIT: 'INT',
  PROFIT_LOCK: 'MICROS',
  CONSECUTIVE_LOSS_LOCK: 'INT',
  COOLDOWN: 'INT',
  TRADING_WINDOW: 'WINDOW',
  SESSION_RESTRICTION: 'SESSIONS',
};

/** FLEXIBLE: freely editable. LOCKED: tighten-only until the next trading day. */
export type PersonalControlMode = 'FLEXIBLE' | 'LOCKED';

/** The structured reject codes a personal control can produce on the order path. */
export type PersonalRejectReason =
  | 'PERSONAL_DAILY_LOSS_LIMIT'
  | 'PERSONAL_MAX_TRADES'
  | 'PERSONAL_DAILY_DRAWDOWN'
  | 'PERSONAL_MAX_POSITION'
  | 'PERSONAL_DAILY_CONTRACT_LIMIT'
  | 'PERSONAL_PROFIT_LOCK'
  | 'PERSONAL_CONSECUTIVE_LOSS_LOCK'
  | 'PERSONAL_COOLDOWN'
  | 'PERSONAL_TRADING_WINDOW'
  | 'PERSONAL_SESSION_RESTRICTION';

export const PERSONAL_REJECT_BY_CONTROL: Record<PersonalControlType, PersonalRejectReason> = {
  DAILY_LOSS_LIMIT: 'PERSONAL_DAILY_LOSS_LIMIT',
  MAX_TRADES: 'PERSONAL_MAX_TRADES',
  DAILY_DRAWDOWN: 'PERSONAL_DAILY_DRAWDOWN',
  MAX_POSITION: 'PERSONAL_MAX_POSITION',
  DAILY_CONTRACT_LIMIT: 'PERSONAL_DAILY_CONTRACT_LIMIT',
  PROFIT_LOCK: 'PERSONAL_PROFIT_LOCK',
  CONSECUTIVE_LOSS_LOCK: 'PERSONAL_CONSECUTIVE_LOSS_LOCK',
  COOLDOWN: 'PERSONAL_COOLDOWN',
  TRADING_WINDOW: 'PERSONAL_TRADING_WINDOW',
  SESSION_RESTRICTION: 'PERSONAL_SESSION_RESTRICTION',
};

/** The persisted value of one control (only the fields for its kind are set). */
export interface PersonalControlValue {
  /** Currency magnitude in micro-dollars (MICROS controls). Always positive. */
  readonly valueMicros?: number | null;
  /** Integer magnitude (INT controls): trades, contracts, losses, minutes. */
  readonly valueInt?: number | null;
  /** HH:MM in the instrument exchange timezone (WINDOW control). */
  readonly windowStart?: string | null;
  readonly windowEnd?: string | null;
  /** Allowed session keys (SESSIONS control). */
  readonly sessions?: readonly string[] | null;
}

/** One control as configured, plus its live server-derived usage. */
export interface PersonalControlView extends PersonalControlValue {
  readonly controlType: PersonalControlType;
  readonly kind: PersonalControlValueKind;
  readonly enabled: boolean;
  readonly mode: PersonalControlMode;
  /** True while LOCKED and not yet expired (cannot loosen/disable, may tighten). */
  readonly locked: boolean;
  /** The trading day the lock was set (yyyy-MM-dd); null when flexible. */
  readonly lockedTradingDay: string | null;
  readonly version: number;
  readonly updatedAt: number | null;
  /**
   * Live usage for this control on the current trading day, when applicable.
   * Server-derived; the UI never computes it. Shape depends on control:
   *  - MAX_TRADES: {used, limit}
   *  - DAILY_CONTRACT_LIMIT: {used, limit}
   *  - DAILY_LOSS_LIMIT: {usedMicros, limitMicros}
   *  - DAILY_DRAWDOWN: {usedMicros, limitMicros}
   *  - PROFIT_LOCK: {progressMicros, thresholdMicros, triggered}
   *  - CONSECUTIVE_LOSS_LOCK: {current, limit}
   *  - COOLDOWN: {remainingMs, minutes}
   *  - TRADING_WINDOW: {open, windowStart, windowEnd}
   *  - SESSION_RESTRICTION: {currentSession, allowed}
   */
  readonly usage?: Readonly<Record<string, unknown>> | null;
}

/** The whole personal-risk profile for one account, as the portal sees it. */
export interface PersonalRiskProfileView {
  readonly accountId: string;
  /** The account's current authoritative trading day (yyyy-MM-dd). */
  readonly tradingDay: string | null;
  /** Whether this account may currently have its controls edited. */
  readonly editable: boolean;
  readonly controls: readonly PersonalControlView[];
}

/** A request to create or update one control (from the trader). */
export interface PersonalControlUpdate {
  readonly controlType: PersonalControlType;
  readonly enabled: boolean;
  readonly mode: PersonalControlMode;
  readonly value: PersonalControlValue;
  /** The version the client believed it was editing (optimistic concurrency). */
  readonly expectedVersion?: number;
}

/** Owner/admin read-only projection of a triggered/consumed control. */
export interface PersonalControlUsageRow {
  readonly controlType: PersonalControlType;
  readonly enabled: boolean;
  readonly mode: PersonalControlMode;
  readonly locked: boolean;
  readonly usage: Readonly<Record<string, unknown>> | null;
}
