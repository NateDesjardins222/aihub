/**
 * Personal risk controls — the DB reads/writes the ORDER PATH uses (M5-F).
 *
 * Kept in trading/ (not platform/) so the engine depends only on trading-level
 * modules. Pure persistence: no audit, no HTTP. The CRUD/profile service in
 * platform/personal-risk.ts re-exports these for its own reads.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { traderRiskControls, traderRiskDayState } from '../db/schema.js';
import type { PersonalControlType } from '@atlas/contracts';
import type { PersonalConfig, PersonalControl, PersonalDayState } from './personal-risk.js';

type ControlRow = typeof traderRiskControls.$inferSelect;

function toControl(row: ControlRow): PersonalControl {
  return {
    controlType: row.controlType as PersonalControlType,
    enabled: row.enabled,
    mode: row.mode as 'FLEXIBLE' | 'LOCKED',
    lockedTradingDay: row.lockedTradingDay ?? null,
    valueMicros: row.valueMicros ?? null,
    valueInt: row.valueInt ?? null,
    windowStart: row.windowStart ?? null,
    windowEnd: row.windowEnd ?? null,
    sessions: (row.sessionsJson as string[] | null) ?? null,
    version: row.version,
  };
}

/** Every stored control for an account, as the gate's config map. */
export async function loadPersonalConfig(db: Database, accountId: string): Promise<PersonalConfig> {
  const rows = await db.select().from(traderRiskControls).where(eq(traderRiskControls.accountId, accountId));
  const map = new Map<PersonalControlType, PersonalControl>();
  for (const row of rows) map.set(row.controlType as PersonalControlType, toControl(row));
  return map;
}

/** Whether any control is enabled — a cheap short-circuit for the order path. */
export async function hasEnabledControls(db: Database, accountId: string): Promise<boolean> {
  const rows = await db
    .select({ enabled: traderRiskControls.enabled })
    .from(traderRiskControls)
    .where(and(eq(traderRiskControls.accountId, accountId), eq(traderRiskControls.enabled, true)));
  return rows.length > 0;
}

/** Today's per-day counters for the gate (null when no trades yet today). */
export async function getDayState(db: Database, accountId: string, tradeDate: string): Promise<PersonalDayState | null> {
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

/**
 * Fold a fill's effects into the per-(account, tradeDate) counters. Called from
 * inside the engine's match transaction so counters are exactly consistent with
 * the fills. `openingTrades`/`contractsOpened` are the exposure-INCREASING
 * portion the caller measured; `closedTradeNets` are the net P&L of round-trips
 * closed this pass (loss increments the streak + starts cooldown, win resets,
 * breakeven neutral).
 */
export async function applyFillToDayState(
  tx: Database,
  accountId: string,
  tradeDate: string,
  input: { openingTrades: number; contractsOpened: number; closedTradeNets: readonly number[]; nowMs: number },
): Promise<void> {
  const [existing] = await tx
    .select()
    .from(traderRiskDayState)
    .where(and(eq(traderRiskDayState.accountId, accountId), eq(traderRiskDayState.tradeDate, tradeDate)))
    .for('update');

  let consecutive = existing?.consecutiveLosses ?? 0;
  let lastLoss = existing?.lastLossClosedAtMs ?? null;
  let realized = existing?.realizedNetPnlMicros ?? 0;
  for (const net of input.closedTradeNets) {
    realized += net;
    if (net < 0) {
      consecutive += 1;
      lastLoss = input.nowMs;
    } else if (net > 0) {
      consecutive = 0;
    }
  }

  if (existing) {
    await tx
      .update(traderRiskDayState)
      .set({
        openingTradeCount: existing.openingTradeCount + input.openingTrades,
        contractsOpened: existing.contractsOpened + input.contractsOpened,
        consecutiveLosses: consecutive,
        lastLossClosedAtMs: lastLoss,
        realizedNetPnlMicros: realized,
        updatedAt: new Date(),
      })
      .where(eq(traderRiskDayState.id, existing.id));
  } else {
    await tx.insert(traderRiskDayState).values({
      accountId,
      tradeDate,
      openingTradeCount: input.openingTrades,
      contractsOpened: input.contractsOpened,
      consecutiveLosses: consecutive,
      lastLossClosedAtMs: lastLoss,
      realizedNetPnlMicros: realized,
    });
  }
}

/** Advance the intraday high-water equity (never lowered) for daily drawdown. */
export async function updateDayHighEquity(
  db: Database,
  accountId: string,
  tradeDate: string,
  equityMicros: number,
  seedEquityMicros: number,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(traderRiskDayState)
    .where(and(eq(traderRiskDayState.accountId, accountId), eq(traderRiskDayState.tradeDate, tradeDate)));
  if (!existing) {
    await db.insert(traderRiskDayState).values({
      accountId,
      tradeDate,
      dayHighEquityMicros: Math.max(seedEquityMicros, equityMicros),
    });
    return;
  }
  const next = Math.max(existing.dayHighEquityMicros ?? seedEquityMicros, equityMicros);
  if (next !== existing.dayHighEquityMicros) {
    await db
      .update(traderRiskDayState)
      .set({ dayHighEquityMicros: next, updatedAt: new Date() })
      .where(eq(traderRiskDayState.id, existing.id));
  }
}
