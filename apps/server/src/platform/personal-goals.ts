/**
 * Personal goals — the customer's OWN goals on their Happy Trader journey
 * (Portal V2 Experience Layer, Progress & Achievements).
 *
 * Authoritative server records owned by `customerIdentityId` (never localStorage,
 * never cross-customer). Two kinds:
 *
 *  - MANUAL  — a personal aim the customer writes and marks done themselves.
 *  - TRACKED — bound to an authoritative metric (lifetime paid trader-share,
 *              funded accounts, evaluations passed). It completes AUTOMATICALLY
 *              when the real figure crosses the target and can NEVER be marked
 *              complete by request: `completePersonalGoal` refuses tracked goals,
 *              and `reconcilePersonalGoals` is the only path that completes them,
 *              deriving the figure from the same authoritative sources that drive
 *              payouts. So a tracked completion cannot be forged.
 *
 * Deliberately NOT gamified: the only expressible metrics reward
 * progress/accomplishment (money paid to you, funded accounts, evaluations
 * passed). Number of trades, streaks, contracts, and risk taken are not metrics
 * here and must never become ones.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accountQualifications, accounts, customerIdentities, personalGoals } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { cumulativeTraderShareMicros } from './achievements.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';

export type GoalKind = 'MANUAL' | 'TRACKED';
export type GoalStatus = 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
export type GoalMetric = 'CUMULATIVE_PAYOUT_MICROS' | 'FUNDED_ACCOUNTS' | 'EVALUATIONS_PASSED';

export const GOAL_METRICS: readonly GoalMetric[] = [
  'CUMULATIVE_PAYOUT_MICROS',
  'FUNDED_ACCOUNTS',
  'EVALUATIONS_PASSED',
] as const;

/** The most "current focus" goals a customer may pin at once. */
export const MAX_PINNED_GOALS = 3;
const MAX_ACTIVE_GOALS = 50; // a sane ceiling; goals are personal, not a feed

export class GoalError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'GoalError';
  }
}

export interface GoalView {
  id: string;
  title: string;
  note: string | null;
  kind: GoalKind;
  metric: GoalMetric | null;
  targetValue: number | null;
  currentValue: number | null; // authoritative progress for TRACKED goals
  status: GoalStatus;
  pinned: boolean;
  completedAt: number | null;
  createdAt: number;
}

// ---- Authoritative metric resolution (never trusts the client) -------------

/** Count of the user's passed evaluations (one immutable qualification per pass). */
async function evaluationsPassed(db: Database, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accountQualifications)
    .innerJoin(accounts, eq(accountQualifications.accountId, accounts.id))
    .where(eq(accounts.userId, userId));
  return Number(row?.n ?? 0);
}

/** Count of the user's funded accounts (qualifications that reached FUNDED). */
async function fundedAccounts(db: Database, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accountQualifications)
    .innerJoin(accounts, eq(accountQualifications.accountId, accounts.id))
    .where(and(eq(accounts.userId, userId), eq(accountQualifications.fundingState, 'FUNDED')));
  return Number(row?.n ?? 0);
}

/** Resolve the current authoritative value for a tracked metric. */
export async function resolveMetricValue(db: Database, userId: string, metric: GoalMetric): Promise<number> {
  switch (metric) {
    case 'CUMULATIVE_PAYOUT_MICROS':
      return cumulativeTraderShareMicros(db, userId);
    case 'FUNDED_ACCOUNTS':
      return fundedAccounts(db, userId);
    case 'EVALUATIONS_PASSED':
      return evaluationsPassed(db, userId);
    default:
      return 0;
  }
}

/** All three authoritative figures at once (for the Progress hero + reconcile). */
export async function resolveAllMetrics(db: Database, userId: string): Promise<Record<GoalMetric, number>> {
  const [payout, funded, evals] = await Promise.all([
    cumulativeTraderShareMicros(db, userId),
    fundedAccounts(db, userId),
    evaluationsPassed(db, userId),
  ]);
  return {
    CUMULATIVE_PAYOUT_MICROS: payout,
    FUNDED_ACCOUNTS: funded,
    EVALUATIONS_PASSED: evals,
  };
}

// ---- Identity resolution ---------------------------------------------------

async function identityIdForUser(db: Database, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: customerIdentities.id })
    .from(customerIdentities)
    .where(eq(customerIdentities.userId, userId));
  return row?.id ?? null;
}

// ---- Validation ------------------------------------------------------------

function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new GoalError('INVALID_TITLE', 'A goal needs a title.');
  // Strip control characters; collapse whitespace. No markup is ever rendered,
  // but we keep the stored value clean and bounded.
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (value.length === 0) throw new GoalError('INVALID_TITLE', 'A goal needs a title.');
  if (value.length > 120) throw new GoalError('INVALID_TITLE', 'Keep the title to 120 characters.');
  return value;
}

function cleanNote(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') throw new GoalError('INVALID_NOTE', 'Note must be text.');
  const value = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  if (value.length === 0) return null;
  if (value.length > 600) throw new GoalError('INVALID_NOTE', 'Keep the note to 600 characters.');
  return value;
}

/** Positive integer target (count, or whole-dollar converted to micros upstream). */
function cleanTarget(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new GoalError('INVALID_TARGET', 'A tracked goal needs a positive whole-number target.');
  }
  if (n > Number.MAX_SAFE_INTEGER) throw new GoalError('INVALID_TARGET', 'Target is too large.');
  return n;
}

// ---- CRUD ------------------------------------------------------------------

export interface CreateGoalInput {
  organizationId: string;
  userId: string;
  title: string;
  note?: string | null;
  kind: GoalKind;
  metric?: GoalMetric | null;
  targetValue?: number | null; // micros for money metrics, a count otherwise
  pinned?: boolean;
  actor?: Actor;
}

export async function createPersonalGoal(db: Database, input: CreateGoalInput): Promise<GoalView> {
  const title = cleanTitle(input.title);
  const note = cleanNote(input.note);
  if (input.kind !== 'MANUAL' && input.kind !== 'TRACKED') {
    throw new GoalError('INVALID_KIND', 'A goal is either manual or tracked.');
  }
  let metric: GoalMetric | null = null;
  let targetValue: number | null = null;
  if (input.kind === 'TRACKED') {
    if (!input.metric || !GOAL_METRICS.includes(input.metric)) {
      throw new GoalError('INVALID_METRIC', 'A tracked goal needs a supported metric.');
    }
    metric = input.metric;
    targetValue = cleanTarget(input.targetValue);
  }

  const identity = await ensureCustomerIdentity(db, { organizationId: input.organizationId, userId: input.userId });

  // Enforce the active ceiling and the pin ceiling server-side.
  const [{ active = 0 } = { active: 0 }] = await db
    .select({ active: sql<number>`count(*)::int` })
    .from(personalGoals)
    .where(and(eq(personalGoals.customerIdentityId, identity.id), eq(personalGoals.status, 'ACTIVE')));
  if (Number(active) >= MAX_ACTIVE_GOALS) {
    throw new GoalError('TOO_MANY_GOALS', 'You have reached the maximum number of active goals.');
  }
  let pinned = input.pinned === true;
  if (pinned && (await pinnedCount(db, identity.id)) >= MAX_PINNED_GOALS) {
    pinned = false; // silently decline the pin rather than fail the creation
  }

  const [row] = await db
    .insert(personalGoals)
    .values({
      organizationId: input.organizationId,
      customerIdentityId: identity.id,
      title,
      note,
      kind: input.kind,
      metric,
      targetValue,
      status: 'ACTIVE',
      pinned,
    })
    .returning();

  await recordAudit(db, {
    organizationId: input.organizationId,
    actor: input.actor ?? { type: 'USER', userId: input.userId },
    subjectType: 'CUSTOMER',
    subjectId: identity.id,
    userId: input.userId,
    action: 'personal_goal.created',
    newState: { goalId: row!.id, kind: row!.kind, metric: row!.metric },
    reason: null,
  });

  // A freshly-created tracked goal may already be satisfied — reconcile it now so
  // the customer sees the true state immediately.
  if (row!.kind === 'TRACKED') {
    await reconcilePersonalGoals(db, input.userId);
    const [fresh] = await db.select().from(personalGoals).where(eq(personalGoals.id, row!.id));
    return toGoalView(fresh!, fresh!.metric ? await resolveMetricValue(db, input.userId, fresh!.metric as GoalMetric) : null);
  }
  return toGoalView(row!, null);
}

async function pinnedCount(db: Database, identityId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(personalGoals)
    .where(and(eq(personalGoals.customerIdentityId, identityId), eq(personalGoals.pinned, true), eq(personalGoals.status, 'ACTIVE')));
  return Number(row?.n ?? 0);
}

/** Load a goal that MUST belong to the caller, or throw NOT_FOUND. */
async function ownedGoal(db: Database, userId: string, goalId: string) {
  const identityId = await identityIdForUser(db, userId);
  if (!identityId) throw new GoalError('NOT_FOUND', 'No such goal.');
  const [row] = await db
    .select()
    .from(personalGoals)
    .where(and(eq(personalGoals.id, goalId), eq(personalGoals.customerIdentityId, identityId)));
  if (!row) throw new GoalError('NOT_FOUND', 'No such goal.');
  return row;
}

export interface UpdateGoalInput {
  title?: string;
  note?: string | null;
  targetValue?: number | null;
  pinned?: boolean;
  actor?: Actor;
}

/**
 * Edit a goal's own fields. Status is NOT editable here (use complete/archive);
 * kind and metric are immutable once set (a tracked goal cannot be re-pointed to
 * a different authoritative metric to dodge its target).
 */
export async function updatePersonalGoal(db: Database, userId: string, goalId: string, input: UpdateGoalInput): Promise<GoalView> {
  const row = await ownedGoal(db, userId, goalId);
  if (row.status === 'ARCHIVED') throw new GoalError('ARCHIVED', 'This goal is archived.');

  const patch: Partial<typeof personalGoals.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = cleanTitle(input.title);
  if (input.note !== undefined) patch.note = cleanNote(input.note);
  if (input.targetValue !== undefined) {
    if (row.kind !== 'TRACKED') throw new GoalError('NOT_TRACKED', 'Only a tracked goal has a target.');
    patch.targetValue = cleanTarget(input.targetValue);
  }
  if (input.pinned !== undefined) {
    if (input.pinned === true && !row.pinned) {
      if (row.status !== 'ACTIVE') throw new GoalError('NOT_ACTIVE', 'Only an active goal can be pinned.');
      if ((await pinnedCount(db, row.customerIdentityId)) >= MAX_PINNED_GOALS) {
        throw new GoalError('TOO_MANY_PINS', `You can pin up to ${MAX_PINNED_GOALS} goals as your current focus.`);
      }
    }
    patch.pinned = input.pinned === true;
  }

  const [updated] = await db.update(personalGoals).set(patch).where(eq(personalGoals.id, row.id)).returning();
  await recordAudit(db, {
    organizationId: row.organizationId,
    actor: input.actor ?? { type: 'USER', userId },
    subjectType: 'CUSTOMER',
    subjectId: row.customerIdentityId,
    userId,
    action: 'personal_goal.updated',
    newState: { goalId: row.id },
    reason: null,
  });

  // Lowering a tracked target may now satisfy it.
  if (updated!.kind === 'TRACKED' && updated!.status === 'ACTIVE') {
    await reconcilePersonalGoals(db, userId);
    const [fresh] = await db.select().from(personalGoals).where(eq(personalGoals.id, row.id));
    return toGoalView(fresh!, fresh!.metric ? await resolveMetricValue(db, userId, fresh!.metric as GoalMetric) : null);
  }
  const current = updated!.kind === 'TRACKED' && updated!.metric ? await resolveMetricValue(db, userId, updated!.metric as GoalMetric) : null;
  return toGoalView(updated!, current);
}

/**
 * Mark a MANUAL goal complete. A TRACKED goal is NEVER completable this way — it
 * completes only via reconcilePersonalGoals from authoritative data, so this
 * refusal is the forge-protection boundary.
 */
export async function completePersonalGoal(db: Database, userId: string, goalId: string, actor?: Actor): Promise<GoalView> {
  const row = await ownedGoal(db, userId, goalId);
  if (row.kind !== 'MANUAL') {
    throw new GoalError('TRACKED_AUTO_ONLY', 'A tracked goal completes automatically when you reach its target.');
  }
  if (row.status === 'COMPLETED') return toGoalView(row, null);
  if (row.status !== 'ACTIVE') throw new GoalError('NOT_ACTIVE', 'Only an active goal can be completed.');
  const [updated] = await db
    .update(personalGoals)
    .set({ status: 'COMPLETED', completedAt: new Date(), pinned: false, updatedAt: new Date() })
    .where(and(eq(personalGoals.id, row.id), eq(personalGoals.status, 'ACTIVE')))
    .returning();
  await recordAudit(db, {
    organizationId: row.organizationId,
    actor: actor ?? { type: 'USER', userId },
    subjectType: 'CUSTOMER',
    subjectId: row.customerIdentityId,
    userId,
    action: 'personal_goal.completed',
    newState: { goalId: row.id, manual: true },
    reason: null,
  });
  return toGoalView(updated ?? row, null);
}

/** Archive (soft-delete) a goal the caller owns. Idempotent. */
export async function archivePersonalGoal(db: Database, userId: string, goalId: string, actor?: Actor): Promise<void> {
  const row = await ownedGoal(db, userId, goalId);
  if (row.status === 'ARCHIVED') return;
  await db
    .update(personalGoals)
    .set({ status: 'ARCHIVED', archivedAt: new Date(), pinned: false, updatedAt: new Date() })
    .where(eq(personalGoals.id, row.id));
  await recordAudit(db, {
    organizationId: row.organizationId,
    actor: actor ?? { type: 'USER', userId },
    subjectType: 'CUSTOMER',
    subjectId: row.customerIdentityId,
    userId,
    action: 'personal_goal.archived',
    newState: { goalId: row.id },
    reason: null,
  });
}

/**
 * Complete every ACTIVE tracked goal whose authoritative metric has reached its
 * target. Deterministic, idempotent, replay-safe: the UPDATE is guarded by
 * `status = 'ACTIVE'`, so a goal is stamped COMPLETED exactly once no matter how
 * many times this runs. Returns the ids newly completed (for the caller/tests).
 */
export async function reconcilePersonalGoals(db: Database, userId: string): Promise<string[]> {
  const identityId = await identityIdForUser(db, userId);
  if (!identityId) return [];
  const active = await db
    .select()
    .from(personalGoals)
    .where(and(eq(personalGoals.customerIdentityId, identityId), eq(personalGoals.status, 'ACTIVE'), eq(personalGoals.kind, 'TRACKED')));
  if (active.length === 0) return [];

  const metrics = await resolveAllMetrics(db, userId);
  const completed: string[] = [];
  for (const goal of active) {
    const metric = goal.metric as GoalMetric | null;
    if (!metric || goal.targetValue == null) continue;
    const current = metrics[metric] ?? 0;
    if (current < goal.targetValue) continue;
    const [row] = await db
      .update(personalGoals)
      .set({ status: 'COMPLETED', completedAt: new Date(), pinned: false, updatedAt: new Date() })
      .where(and(eq(personalGoals.id, goal.id), eq(personalGoals.status, 'ACTIVE')))
      .returning();
    if (row) {
      completed.push(row.id);
      await recordAudit(db, {
        organizationId: goal.organizationId,
        actor: SYSTEM_ACTOR,
        subjectType: 'CUSTOMER',
        subjectId: identityId,
        userId,
        action: 'personal_goal.completed',
        newState: { goalId: row.id, metric, currentValue: current, targetValue: goal.targetValue },
        reason: null,
      });
    }
  }
  return completed;
}

/** List the caller's goals (active + completed + archived), reconciled first. */
export async function listPersonalGoals(db: Database, userId: string): Promise<GoalView[]> {
  await reconcilePersonalGoals(db, userId);
  const identityId = await identityIdForUser(db, userId);
  if (!identityId) return [];
  const rows = await db
    .select()
    .from(personalGoals)
    .where(eq(personalGoals.customerIdentityId, identityId))
    .orderBy(desc(personalGoals.pinned), asc(personalGoals.status), desc(personalGoals.createdAt));
  const metrics = await resolveAllMetrics(db, userId);
  return rows.map((r) =>
    toGoalView(r, r.kind === 'TRACKED' && r.metric ? metrics[r.metric as GoalMetric] ?? 0 : null),
  );
}

function toGoalView(row: typeof personalGoals.$inferSelect, currentValue: number | null): GoalView {
  return {
    id: row.id,
    title: row.title,
    note: row.note ?? null,
    kind: row.kind as GoalKind,
    metric: (row.metric as GoalMetric | null) ?? null,
    targetValue: row.targetValue ?? null,
    currentValue,
    status: row.status as GoalStatus,
    pinned: row.pinned,
    completedAt: row.completedAt ? row.completedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
  };
}
