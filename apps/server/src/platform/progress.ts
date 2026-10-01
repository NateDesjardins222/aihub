/**
 * Progress read model — the customer's personal Happy Trader journey.
 *
 * A pure READ projection assembled from authoritative sources only. It never
 * writes (apart from the idempotent tracked-goal reconcile it delegates to) and
 * never fabricates: a customer with nothing sees truthful zeros.
 *
 * Sources (all authoritative, see docs/progress/PROGRESS_EVENT_TRUTH_MAP.md):
 *  - member since       → customer_identities.created_at
 *  - lifetime paid      → sum(payout_requests.trader_share_micros WHERE state='PAID')
 *  - funded accounts    → account_qualifications WHERE funding_state='FUNDED'
 *  - evaluations passed → count(account_qualifications)
 *  - milestones         → achievements (idempotent, event-driven, auditable)
 *  - clubs              → CLUB_MILESTONES vs lifetime paid trader-share
 *  - personal goals     → personal_goals (authoritative, owner-scoped)
 *
 * Clubs are cumulative PAID trader-share, NOT simulated P&L, account size,
 * requested/gross payout, or unpaid balance.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { customerIdentities } from '../db/schema.js';
import {
  CLUB_MILESTONES,
  cumulativeTraderShareMicros,
  listAchievementsForUser,
} from './achievements.js';
import { listPersonalGoals, resolveAllMetrics, type GoalView } from './personal-goals.js';

export interface ClubView {
  key: 'TENK_CLUB' | 'FIFTYK_CLUB' | 'HUNDREDK_CLUB';
  thresholdMicros: number;
  achieved: boolean;
  achievedAt: number | null;
  physical: boolean;
}

export interface MilestoneView {
  id: string;
  type: string;
  at: number;
  meta: Record<string, unknown> | null;
}

export interface ProgressView {
  memberSinceMs: number | null;
  hero: {
    lifetimePaidTraderShareMicros: number;
    fundedAccounts: number;
    evaluationsPassed: number;
    achievementsEarned: number;
    currentClub: ClubView['key'] | null;
    nextClub: { key: ClubView['key']; thresholdMicros: number; remainingMicros: number } | null;
  };
  clubs: ClubView[];
  milestones: MilestoneView[];
  goals: GoalView[];
  achievementsPublic: boolean;
}

/** Assemble the full progress view for the caller. Read-only + idempotent. */
export async function progressForUser(db: Database, userId: string): Promise<ProgressView> {
  const [identity] = await db
    .select({ id: customerIdentities.id, createdAt: customerIdentities.createdAt })
    .from(customerIdentities)
    .where(eq(customerIdentities.userId, userId));

  // Authoritative figures.
  const [lifetimePaid, metrics, ach, goals] = await Promise.all([
    cumulativeTraderShareMicros(db, userId),
    resolveAllMetrics(db, userId),
    listAchievementsForUser(db, userId),
    listPersonalGoals(db, userId),
  ]);

  // Map club achievements (if earned) to their earned-at timestamp.
  const achByType = new Map<string, { id: string; earnedAt: number; meta: Record<string, unknown> | null }>();
  for (const a of ach.achievements as Array<{ id: string; type: string; earnedAt: number; meta: Record<string, unknown> | null }>) {
    // Keep the earliest (first) occurrence per type (there is at most one anyway).
    if (!achByType.has(a.type)) achByType.set(a.type, { id: a.id, earnedAt: a.earnedAt, meta: a.meta });
  }

  const clubs: ClubView[] = CLUB_MILESTONES.map((c) => {
    const earned = achByType.get(c.achievement);
    return {
      key: c.certificate,
      thresholdMicros: c.atMicros,
      achieved: lifetimePaid >= c.atMicros,
      achievedAt: earned ? earned.earnedAt : null,
      physical: c.physical,
    };
  });

  const achievedClubs = clubs.filter((c) => c.achieved);
  const currentClub = achievedClubs.length > 0 ? achievedClubs[achievedClubs.length - 1]!.key : null;
  const nextClubRow = clubs.find((c) => !c.achieved) ?? null;
  const nextClub = nextClubRow
    ? {
        key: nextClubRow.key,
        thresholdMicros: nextClubRow.thresholdMicros,
        remainingMicros: Math.max(0, nextClubRow.thresholdMicros - lifetimePaid),
      }
    : null;

  // Milestones: the authoritative achievement records, newest first. These are
  // deterministic, idempotent and auditable (one row per (identity, milestone)).
  const milestones: MilestoneView[] = (ach.achievements as Array<{ id: string; type: string; earnedAt: number; meta: Record<string, unknown> | null }>)
    .map((a) => ({ id: a.id, type: a.type, at: a.earnedAt, meta: a.meta }))
    .sort((x, y) => y.at - x.at);

  return {
    memberSinceMs: identity?.createdAt ? identity.createdAt.getTime() : null,
    hero: {
      lifetimePaidTraderShareMicros: lifetimePaid,
      fundedAccounts: metrics.FUNDED_ACCOUNTS,
      evaluationsPassed: metrics.EVALUATIONS_PASSED,
      achievementsEarned: ach.achievements.length,
      currentClub,
      nextClub,
    },
    clubs,
    milestones,
    goals,
    achievementsPublic: ach.achievementsPublic,
  };
}
