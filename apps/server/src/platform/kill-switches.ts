/**
 * Platform kill switches (M10-F).
 *
 * Deliberate emergency controls generalizing the payout circuit-breaker pattern.
 * Engaging one requires permission + reason (+ reauth at the route) and writes a
 * CRITICAL audit event and an owner alert. Current state lives in `kill_switches`;
 * the change history lives in `audit_log`.
 *
 * CRITICAL SAFETY: DISABLE_NEW_ORDERS blocks NEW/INCREASING exposure only. The
 * risk-reducing endpoints (cancel, cancel-all, flatten, protect, reverse) are
 * separate routes and are intentionally NOT gated by it.
 */
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { killSwitches } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from './audit.js';
import type { Actor } from './actor.js';

export const KILL_SWITCHES = [
  'DISABLE_NEW_PURCHASES',
  'DISABLE_PROVISIONING',
  'DISABLE_NEW_ORDERS',
  'DISABLE_NEW_PAYOUT_REQUESTS',
  'DISABLE_PAYOUT_SUBMISSION',
  'DISABLE_EXTERNAL_EXECUTION',
  'MAINTENANCE_MODE',
] as const;
export type KillSwitchKey = (typeof KILL_SWITCHES)[number];

export function isKillSwitchKey(v: string): v is KillSwitchKey {
  return (KILL_SWITCHES as readonly string[]).includes(v);
}

export async function listKillSwitches(db: Database): Promise<Array<{ key: string; engaged: boolean; reason: string | null; engagedAt: Date | null; updatedAt: Date }>> {
  const rows = await db.select().from(killSwitches).orderBy(desc(killSwitches.updatedAt));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // Present every known switch, defaulting to not-engaged so the console shows the full set.
  return KILL_SWITCHES.map((key) => {
    const r = byKey.get(key);
    return { key, engaged: r?.engaged ?? false, reason: r?.reason ?? null, engagedAt: r?.engagedAt ?? null, updatedAt: r?.updatedAt ?? new Date(0) };
  });
}

export async function isEngaged(db: Database, key: KillSwitchKey): Promise<boolean> {
  const [row] = await db.select({ engaged: killSwitches.engaged }).from(killSwitches).where(eq(killSwitches.key, key));
  return row?.engaged ?? false;
}

async function upsert(db: Database, key: KillSwitchKey, patch: Record<string, unknown>): Promise<void> {
  const [existing] = await db.select({ id: killSwitches.id }).from(killSwitches).where(eq(killSwitches.key, key));
  if (existing) {
    await db.update(killSwitches).set({ ...patch, updatedAt: new Date() }).where(eq(killSwitches.id, existing.id));
  } else {
    await db.insert(killSwitches).values({ key, ...patch, updatedAt: new Date() } as never);
  }
}

export async function engageKillSwitch(db: Database, key: KillSwitchKey, reason: string, actor: Actor, organizationId: string | null = null): Promise<void> {
  if (!reason || reason.trim().length < 3) throw ApiError.badRequest('REASON_REQUIRED', 'A reason is required to engage a kill switch.');
  await upsert(db, key, { organizationId, engaged: true, reason: reason.trim(), engagedByUserId: actor.userId ?? null, engagedAt: new Date(), releasedByUserId: null, releasedAt: null });
  await recordAudit(db, { organizationId, actor, subjectType: 'ORGANIZATION', subjectId: null, action: 'kill_switch.engaged', newState: { key, engaged: true }, reason: reason.trim() });
}

export async function releaseKillSwitch(db: Database, key: KillSwitchKey, reason: string, actor: Actor, organizationId: string | null = null): Promise<void> {
  await upsert(db, key, { engaged: false, releasedByUserId: actor.userId ?? null, releasedAt: new Date() });
  await recordAudit(db, { organizationId, actor, subjectType: 'ORGANIZATION', subjectId: null, action: 'kill_switch.released', newState: { key, engaged: false }, reason: reason?.trim() || 'released' });
}

/** Throw a 423-style block if the switch is engaged (used at enforcement seams). */
export async function assertNotEngaged(db: Database, key: KillSwitchKey): Promise<void> {
  if (await isEngaged(db, key)) {
    throw new ApiError(423, 'KILL_SWITCH_ENGAGED', `${key} is engaged; this operation is temporarily disabled.`);
  }
}
