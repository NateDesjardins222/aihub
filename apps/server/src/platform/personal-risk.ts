/**
 * Trader Personal Risk Controls — durable domain service (Milestone 5).
 *
 * Server-authoritative CRUD for per-account personal controls, plus the loaders
 * the order-path gate uses and the fill-path counter maintenance. Personal
 * controls can only make an account MORE restrictive; firm rules always win.
 *
 * - Ownership is the caller's responsibility (routes resolve it from the JWT);
 *   this service is account-scoped and never trusts a client-supplied user id
 *   for authorization.
 * - LOCKED controls are enforced HERE (tighten-only until the next trading day),
 *   never by the browser.
 * - Concurrency: version CAS; a stale concurrent edit is rejected.
 * - Every change writes an append-only audit event.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, traderRiskControlEvents, traderRiskControls, traderRiskDayState } from '../db/schema.js';
import type {
  PersonalControlMode,
  PersonalControlType,
  PersonalControlValue,
  PersonalControlView,
  PersonalRiskProfileView,
} from '@atlas/contracts';
import { PERSONAL_CONTROL_KIND, PERSONAL_CONTROL_TYPES } from '@atlas/contracts';
import {
  isStricter,
  validateControlValue,
  type PersonalConfig,
  type PersonalControl,
  type PersonalDayState,
} from '../trading/personal-risk.js';
import { recordAudit } from './audit.js';

export class PersonalControlError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'ACCOUNT_NOT_EDITABLE'
      | 'VALIDATION'
      | 'LOCKED'
      | 'STALE_VERSION'
      | 'UNKNOWN_CONTROL',
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PersonalControlError';
  }
}

const EDITABLE_STATUSES = new Set(['ACTIVE', 'PENDING', 'GOAL_REACHED']);

type ControlRow = typeof traderRiskControls.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;

function rowValue(row: ControlRow): PersonalControlValue {
  return {
    valueMicros: row.valueMicros ?? null,
    valueInt: row.valueInt ?? null,
    windowStart: row.windowStart ?? null,
    windowEnd: row.windowEnd ?? null,
    sessions: (row.sessionsJson as string[] | null) ?? null,
  };
}

/** Is a LOCKED control still in force for the account's current trading day? */
function lockActive(row: ControlRow, currentTradeDate: string | null): boolean {
  if (row.mode !== 'LOCKED' || !row.lockedTradingDay) return false;
  if (!currentTradeDate) return true; // day unknown → treat as still locked (safe)
  return row.lockedTradingDay >= currentTradeDate;
}

function toControl(row: ControlRow): PersonalControl {
  return {
    controlType: row.controlType as PersonalControlType,
    enabled: row.enabled,
    mode: row.mode as PersonalControlMode,
    lockedTradingDay: row.lockedTradingDay ?? null,
    ...rowValue(row),
    version: row.version,
  };
}

function toView(row: ControlRow, currentTradeDate: string | null): PersonalControlView {
  return {
    controlType: row.controlType as PersonalControlType,
    kind: PERSONAL_CONTROL_KIND[row.controlType as PersonalControlType],
    enabled: row.enabled,
    mode: row.mode as PersonalControlMode,
    locked: lockActive(row, currentTradeDate),
    lockedTradingDay: row.lockedTradingDay ?? null,
    version: row.version,
    updatedAt: row.updatedAt ? row.updatedAt.getTime() : null,
    ...rowValue(row),
    usage: null,
  };
}

async function loadAccount(db: Database, accountId: string): Promise<AccountRow> {
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!acct) throw new PersonalControlError('ACCOUNT_NOT_FOUND', 'No such account.');
  return acct;
}

/** The runtime config the order-path gate consumes: every stored control. */
export async function loadPersonalConfig(db: Database, accountId: string): Promise<PersonalConfig> {
  const rows = await db.select().from(traderRiskControls).where(eq(traderRiskControls.accountId, accountId));
  const map = new Map<PersonalControlType, PersonalControl>();
  // The lock state is irrelevant to the gate's config (it only affects edits).
  for (const row of rows) map.set(row.controlType as PersonalControlType, toControl(row));
  return map;
}

/** Whether any personal control is enabled — a cheap short-circuit for the gate. */
export async function hasEnabledControls(db: Database, accountId: string): Promise<boolean> {
  const rows = await db
    .select({ enabled: traderRiskControls.enabled })
    .from(traderRiskControls)
    .where(and(eq(traderRiskControls.accountId, accountId), eq(traderRiskControls.enabled, true)));
  return rows.length > 0;
}

/** Today's per-day counters for the gate (null when no trades yet today). */
export async function getDayState(
  db: Database,
  accountId: string,
  tradeDate: string,
): Promise<PersonalDayState | null> {
  const [row] = await db
    .select()
    .from(traderRiskDayState)
    .where(and(eq(traderRiskDayState.accountId, accountId), eq(traderRiskDayState.tradeDate, tradeDate)));
  if (!row) return null;
  return {
    openingTradeCount: row.openingTradeCount,
    contractsOpened: row.contractsOpened,
    consecutiveLosses: row.consecutiveLosses,
    lastLossClosedAtMs: row.lastLossClosedAtMs ?? null,
    dayHighEquityMicros: row.dayHighEquityMicros ?? null,
  };
}

export interface PersonalControlProfileOptions {
  /** Live realized net day P&L (fees included), for usage display. */
  readonly dayPnlMicros?: number | null;
  /** Live equity, for drawdown usage display (never fabricated). */
  readonly equityMicros?: number | null;
  /** Wall clock, for cooldown remaining. Defaults to Date.now(). */
  readonly nowMs?: number;
}

/** The full profile the portal Controls page renders (with live usage). */
export async function getPersonalRiskProfile(
  db: Database,
  accountId: string,
  opts: PersonalControlProfileOptions = {},
): Promise<PersonalRiskProfileView> {
  const acct = await loadAccount(db, accountId);
  const tradingDay = acct.currentTradeDate ?? null;
  const rows = await db.select().from(traderRiskControls).where(eq(traderRiskControls.accountId, accountId));
  const byType = new Map(rows.map((r) => [r.controlType as PersonalControlType, r]));
  const day = tradingDay ? await getDayState(db, accountId, tradingDay) : null;
  const nowMs = opts.nowMs ?? Date.now();
  // Realized net day P&L is authoritative from the account ledger columns
  // (balance updates only on realized fills; dayStart is snapshotted at rollover).
  const realizedDayPnl = (acct.balanceMicros ?? 0) - (acct.dayStartBalanceMicros ?? 0);
  const usageOpts: PersonalControlProfileOptions = {
    dayPnlMicros: opts.dayPnlMicros ?? realizedDayPnl,
    equityMicros: opts.equityMicros ?? null,
    nowMs,
  };

  const controls: PersonalControlView[] = PERSONAL_CONTROL_TYPES.map((type) => {
    const row = byType.get(type);
    const view = row
      ? toView(row, tradingDay)
      : ({
          controlType: type,
          kind: PERSONAL_CONTROL_KIND[type],
          enabled: false,
          mode: 'FLEXIBLE' as PersonalControlMode,
          locked: false,
          lockedTradingDay: null,
          version: 0,
          updatedAt: null,
          valueMicros: null,
          valueInt: null,
          windowStart: null,
          windowEnd: null,
          sessions: null,
          usage: null,
        } satisfies PersonalControlView);
    return { ...view, usage: buildUsage(type, view, day, usageOpts, nowMs) };
  });

  return {
    accountId,
    tradingDay,
    editable: EDITABLE_STATUSES.has(acct.status),
    controls,
  };
}

function buildUsage(
  type: PersonalControlType,
  view: PersonalControlView,
  day: PersonalDayState | null,
  opts: PersonalControlProfileOptions,
  nowMs: number,
): Record<string, unknown> | null {
  if (!view.enabled) return null;
  switch (type) {
    case 'MAX_TRADES':
      return { used: day?.openingTradeCount ?? 0, limit: view.valueInt };
    case 'DAILY_CONTRACT_LIMIT':
      return { used: day?.contractsOpened ?? 0, limit: view.valueInt };
    case 'CONSECUTIVE_LOSS_LOCK':
      return { current: day?.consecutiveLosses ?? 0, limit: view.valueInt };
    case 'DAILY_LOSS_LIMIT':
      return { usedMicros: opts.dayPnlMicros ?? null, limitMicros: view.valueMicros };
    case 'PROFIT_LOCK':
      return {
        progressMicros: opts.dayPnlMicros ?? null,
        thresholdMicros: view.valueMicros,
        triggered: opts.dayPnlMicros != null && view.valueMicros != null && opts.dayPnlMicros >= view.valueMicros,
      };
    case 'DAILY_DRAWDOWN': {
      const dd =
        opts.equityMicros != null && day?.dayHighEquityMicros != null
          ? day.dayHighEquityMicros - opts.equityMicros
          : null;
      return { drawdownMicros: dd, limitMicros: view.valueMicros };
    }
    case 'COOLDOWN': {
      const remaining =
        day?.lastLossClosedAtMs != null && view.valueInt != null
          ? Math.max(0, day.lastLossClosedAtMs + view.valueInt * 60_000 - nowMs)
          : 0;
      return { remainingMs: remaining, minutes: view.valueInt };
    }
    case 'TRADING_WINDOW':
      return { windowStart: view.windowStart, windowEnd: view.windowEnd };
    case 'SESSION_RESTRICTION':
      return { allowed: view.sessions ?? [] };
    default:
      return null;
  }
}

export interface UpsertControlInput {
  readonly accountId: string;
  /** The account owner (persisted for scoping/audit). */
  readonly ownerUserId: string;
  /** Who performed the change (usually the owner; audited). */
  readonly actorUserId: string;
  readonly source?: 'TRADER' | 'OWNER' | 'SYSTEM';
  readonly controlType: PersonalControlType;
  readonly enabled: boolean;
  readonly mode: PersonalControlMode;
  readonly value: PersonalControlValue;
  readonly expectedVersion?: number;
}

function sameValue(type: PersonalControlType, a: PersonalControlValue, b: PersonalControlValue): boolean {
  switch (PERSONAL_CONTROL_KIND[type]) {
    case 'MICROS':
      return (a.valueMicros ?? null) === (b.valueMicros ?? null);
    case 'INT':
      return (a.valueInt ?? null) === (b.valueInt ?? null);
    case 'WINDOW':
      return (a.windowStart ?? null) === (b.windowStart ?? null) && (a.windowEnd ?? null) === (b.windowEnd ?? null);
    case 'SESSIONS': {
      const sa = [...(a.sessions ?? [])].sort();
      const sb = [...(b.sessions ?? [])].sort();
      return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
    }
    default:
      return false;
  }
}

/** Create or update one personal control. Server-authoritative; audited. */
export async function upsertPersonalControl(db: Database, input: UpsertControlInput): Promise<PersonalControlView> {
  if (!PERSONAL_CONTROL_TYPES.includes(input.controlType)) {
    throw new PersonalControlError('UNKNOWN_CONTROL', 'Unknown control.');
  }
  const acct = await loadAccount(db, input.accountId);
  if (!EDITABLE_STATUSES.has(acct.status)) {
    throw new PersonalControlError('ACCOUNT_NOT_EDITABLE', 'This account cannot change risk controls in its current state.', {
      status: acct.status,
    });
  }
  const currentTradeDate = acct.currentTradeDate ?? null;

  // Validate the value whenever one is meaningful (enabling requires validity;
  // a stored value is always kept sane so re-enabling later is safe).
  const valErr = validateControlValue(input.controlType, input.value);
  if (input.enabled && valErr) {
    throw new PersonalControlError('VALIDATION', valErr.message, { field: valErr.field });
  }
  // Even when disabling, reject a structurally impossible value (NaN/negative);
  // an absent value is fine when disabling.
  if (!input.enabled && hasAnyValue(input.controlType, input.value) && valErr) {
    throw new PersonalControlError('VALIDATION', valErr.message, { field: valErr.field });
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(traderRiskControls)
      .where(and(eq(traderRiskControls.accountId, input.accountId), eq(traderRiskControls.controlType, input.controlType)))
      .for('update');

    if (existing && input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw new PersonalControlError('STALE_VERSION', 'This control was changed elsewhere. Reload and try again.', {
        expected: input.expectedVersion,
        actual: existing.version,
      });
    }

    const wasLocked = existing ? lockActive(existing, currentTradeDate) : false;
    if (existing && wasLocked) {
      const prevValue = rowValue(existing);
      // Locked: cannot disable, cannot go FLEXIBLE, cannot loosen the value.
      if (!input.enabled) {
        throw new PersonalControlError('LOCKED', 'This control is locked until the next trading day and cannot be turned off.');
      }
      if (input.mode !== 'LOCKED') {
        throw new PersonalControlError('LOCKED', 'This control is locked until the next trading day and cannot be unlocked.');
      }
      const tighten = isStricter(input.controlType, prevValue, input.value);
      const same = sameValue(input.controlType, prevValue, input.value);
      if (!tighten && !same) {
        throw new PersonalControlError('LOCKED', 'A locked control can only be tightened until the next trading day.');
      }
    }

    // Resolve the mode + lock stamps.
    let mode = input.mode;
    let lockedAt = existing?.lockedAt ?? null;
    let lockedTradingDay = existing?.lockedTradingDay ?? null;
    if (mode === 'LOCKED') {
      if (!wasLocked) {
        // Entering (or re-entering after expiry) LOCKED: stamp today.
        lockedAt = new Date();
        lockedTradingDay = currentTradeDate;
      }
    } else {
      lockedAt = null;
      lockedTradingDay = null;
    }

    const values = {
      valueMicros: input.value.valueMicros ?? null,
      valueInt: input.value.valueInt ?? null,
      windowStart: input.value.windowStart ?? null,
      windowEnd: input.value.windowEnd ?? null,
      sessionsJson: input.value.sessions ?? null,
    };

    let saved: ControlRow;
    if (existing) {
      const [row] = await tx
        .update(traderRiskControls)
        .set({
          enabled: input.enabled,
          mode,
          ...values,
          lockedAt,
          lockedTradingDay,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(traderRiskControls.id, existing.id))
        .returning();
      saved = row!;
    } else {
      const [row] = await tx
        .insert(traderRiskControls)
        .values({
          organizationId: acct.organizationId!,
          accountId: input.accountId,
          userId: input.ownerUserId,
          controlType: input.controlType,
          enabled: input.enabled,
          mode,
          ...values,
          lockedAt,
          lockedTradingDay,
          version: 0,
        })
        .returning();
      saved = row!;
    }

    await tx.insert(traderRiskControlEvents).values({
      organizationId: acct.organizationId!,
      accountId: input.accountId,
      userId: input.ownerUserId,
      controlType: input.controlType,
      action: existing ? 'updated' : 'created',
      oldState: existing ? serialize(existing) : null,
      newState: serialize(saved),
      mode,
      effectiveTradingDay: currentTradeDate,
      actorUserId: input.actorUserId,
      source: input.source ?? 'TRADER',
    });

    return { saved, existing: existing ?? null };
  });

  // Tamper-evident audit AFTER commit (recordAudit takes its own advisory lock;
  // running it inside the outer transaction risks lock contention). Best-effort.
  if (acct.organizationId) {
    await recordAudit(db, {
      organizationId: acct.organizationId,
      actor: { type: 'USER', userId: input.actorUserId },
      subjectType: 'ACCOUNT',
      subjectId: input.accountId,
      accountId: input.accountId,
      userId: input.actorUserId,
      action: 'personal_risk.updated',
      prevState: result.existing
        ? { controlType: input.controlType, enabled: result.existing.enabled, mode: result.existing.mode }
        : null,
      newState: { controlType: input.controlType, enabled: result.saved.enabled, mode: result.saved.mode },
    }).catch(() => undefined);
  }

  return toView(result.saved, currentTradeDate);
}

function hasAnyValue(type: PersonalControlType, v: PersonalControlValue): boolean {
  switch (PERSONAL_CONTROL_KIND[type]) {
    case 'MICROS':
      return v.valueMicros != null;
    case 'INT':
      return v.valueInt != null;
    case 'WINDOW':
      return v.windowStart != null || v.windowEnd != null;
    case 'SESSIONS':
      return (v.sessions?.length ?? 0) > 0;
    default:
      return false;
  }
}

function serialize(row: ControlRow): Record<string, unknown> {
  return {
    enabled: row.enabled,
    mode: row.mode,
    valueMicros: row.valueMicros ?? null,
    valueInt: row.valueInt ?? null,
    windowStart: row.windowStart ?? null,
    windowEnd: row.windowEnd ?? null,
    sessions: row.sessionsJson ?? null,
    lockedTradingDay: row.lockedTradingDay ?? null,
    version: row.version,
  };
}
