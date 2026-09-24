/**
 * Achievements — restrained, idempotent recognition with per-trader visibility
 * (docs/certificates-achievements-v1.md §3). No XP, no loot, no economy.
 *
 * A deferred subscriber issues achievements on the same authoritative events as
 * certificates, exactly once per (identity, milestone) via a unique dedupe key.
 * Cumulative payout thresholds are computed from the payout ledger's trader-share
 * total. Financial detail is never surfaced publicly unless the trader opts in.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { achievements, customerIdentities, payoutRequests } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';

const M = 1_000_000;

export type AchievementType =
  | 'FUNDED'
  | 'FIRST_PAYOUT'
  | 'PAID_5K'
  | 'PAID_10K'
  | 'PAID_25K'
  | 'FIVE_PAYOUT_CLUB'
  | 'ACCOUNT_COMPLETED'
  // Milestone 6 clubs — the locked $10k/$50k/$100k lifetime trader-share tiers.
  | 'TENK_CLUB'
  | 'FIFTYK_CLUB'
  | 'HUNDREDK_CLUB';

/** Cumulative trader-share payout thresholds (trader share, not gross). */
export const PAYOUT_THRESHOLDS: ReadonlyArray<{ type: AchievementType; atMicros: number }> = [
  { type: 'PAID_5K', atMicros: 5_000 * M },
  { type: 'PAID_10K', atMicros: 10_000 * M },
  { type: 'PAID_25K', atMicros: 25_000 * M },
];

/**
 * Milestone 6 club tiers: lifetime actual trader-share PAID payouts. Crossing a
 * threshold issues the club achievement + club certificate exactly once per
 * customer identity. The certificate prints the LOCKED milestone label value
 * (`milestoneMicros`), not the actual lifetime total. HUNDREDK_CLUB is a physical
 * plaque (manual fulfillment).
 */
export const CLUB_MILESTONES: ReadonlyArray<{
  achievement: AchievementType;
  certificate: 'TENK_CLUB' | 'FIFTYK_CLUB' | 'HUNDREDK_CLUB';
  atMicros: number;
  milestoneMicros: number;
  physical: boolean;
}> = [
  { achievement: 'TENK_CLUB', certificate: 'TENK_CLUB', atMicros: 10_000 * M, milestoneMicros: 10_000 * M, physical: false },
  { achievement: 'FIFTYK_CLUB', certificate: 'FIFTYK_CLUB', atMicros: 50_000 * M, milestoneMicros: 50_000 * M, physical: false },
  { achievement: 'HUNDREDK_CLUB', certificate: 'HUNDREDK_CLUB', atMicros: 100_000 * M, milestoneMicros: 100_000 * M, physical: true },
];

export interface IssueAchievementInput {
  organizationId: string;
  userId: string;
  type: AchievementType;
  dedupeKey: string;
  meta?: Record<string, unknown> | null;
  actor?: Actor;
}

/** Issue an achievement exactly once per (identity, dedupe key). */
export async function issueAchievement(db: Database, input: IssueAchievementInput): Promise<boolean> {
  const identity = await ensureCustomerIdentity(db, {
    organizationId: input.organizationId,
    userId: input.userId,
  });
  const [row] = await db
    .insert(achievements)
    .values({
      organizationId: input.organizationId,
      customerIdentityId: identity.id,
      type: input.type,
      dedupeKey: input.dedupeKey,
      isPublic: false,
      meta: (input.meta ?? null) as object | null,
    })
    .onConflictDoNothing({ target: [achievements.organizationId, achievements.dedupeKey] })
    .returning();
  if (!row) return false; // already earned

  await recordAudit(db, {
    organizationId: input.organizationId,
    actor: input.actor ?? SYSTEM_ACTOR,
    subjectType: 'CUSTOMER',
    subjectId: identity.id,
    userId: input.userId,
    action: 'achievement.issued',
    newState: { achievementId: row.id, type: row.type },
    reason: null,
  });
  await events.publish(db, {
    type: 'achievement.issued',
    organizationId: input.organizationId,
    userId: input.userId,
    payload: { achievementId: row.id, type: row.type },
  });
  return true;
}

/** Cumulative trader-share total across a user's PAID payout requests. */
export async function cumulativeTraderShareMicros(db: Database, userId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${payoutRequests.traderShareMicros}), 0)::bigint` })
    .from(payoutRequests)
    .where(and(eq(payoutRequests.userId, userId), eq(payoutRequests.state, 'PAID')));
  return Number(row?.total ?? 0);
}

/** The whole-account visibility toggle (default off). */
export async function setAchievementsPublic(db: Database, userId: string, isPublic: boolean): Promise<void> {
  await db.update(customerIdentities).set({ achievementsPublic: isPublic }).where(eq(customerIdentities.userId, userId));
}

/** A single achievement's own visibility (owner-scoped). */
export async function setAchievementVisibility(
  db: Database,
  userId: string,
  achievementId: string,
  isPublic: boolean,
): Promise<void> {
  const [identity] = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(eq(customerIdentities.userId, userId));
  if (!identity) return;
  await db
    .update(achievements)
    .set({ isPublic })
    .where(and(eq(achievements.id, achievementId), eq(achievements.customerIdentityId, identity.id)));
}

export async function listAchievementsForUser(db: Database, userId: string) {
  const [identity] = await db
    .select({ id: customerIdentities.id, achievementsPublic: customerIdentities.achievementsPublic })
    .from(customerIdentities)
    .where(eq(customerIdentities.userId, userId));
  if (!identity) return { achievementsPublic: false, achievements: [] as unknown[] };
  const rows = await db
    .select()
    .from(achievements)
    .where(eq(achievements.customerIdentityId, identity.id))
    .orderBy(desc(achievements.earnedAt));
  return {
    achievementsPublic: identity.achievementsPublic ?? false,
    achievements: rows.map((r) => ({
      id: r.id,
      type: r.type,
      isPublic: r.isPublic,
      meta: r.meta ?? null,
      earnedAt: r.earnedAt.getTime(),
    })),
  };
}
