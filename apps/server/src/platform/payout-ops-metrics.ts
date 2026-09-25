/**
 * Payout-operations SLA instrumentation + observability (Milestone 8).
 *
 * The primary internal metric is P95 clean-request → provider-submitted, targeted
 * under five minutes. Everything here reads authoritative timestamps off
 * payout_operations — nothing is fabricated. A clean fast-lane payout that exceeds
 * the target raises an operational SLA-breach alert; it never accuses the customer
 * or alters eligibility.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { payoutOperations, payoutReconciliationRecords, payoutRequests } from '../db/schema.js';
import { events } from './events.js';
import { systemClock, type Clock } from './clock.js';
import { getOpsConfig } from './payout-ops-config.js';
import { resolvePayoutProvider } from './payout-provider-registry.js';

export const SLA_TARGET_MS = 5 * 60 * 1000;

type OpRow = typeof payoutOperations.$inferSelect;

export interface SlaTimings {
  requestToApprovalMs: number | null;
  requestToSubmissionMs: number | null;
  submissionToAckMs: number | null;
  submissionToPaidMs: number | null;
}

function ms(a: Date | null, b: Date | null): number | null {
  if (!a || !b) return null;
  return b.getTime() - a.getTime();
}

export function slaTimings(op: OpRow): SlaTimings {
  return {
    requestToApprovalMs: ms(op.requestedAt, op.approvedAt),
    requestToSubmissionMs: ms(op.requestedAt, op.submittedAt),
    submissionToAckMs: ms(op.submissionStartedAt, op.submittedAt),
    submissionToPaidMs: ms(op.submittedAt, op.paidAt),
  };
}

/** A clean fast-lane payout whose request→submission exceeded the 5-minute target. */
export function isCleanSlaBreach(op: OpRow, thresholdMs = SLA_TARGET_MS): boolean {
  if (!op.fastLane) return false;
  const t = ms(op.requestedAt, op.submittedAt);
  return t != null && t > thresholdMs;
}

/**
 * Flag an SLA breach on a submitted clean payout if it exceeded the target. Also
 * flags a not-yet-submitted clean fast-lane payout whose age already exceeds the
 * target (still processing but late). Idempotent.
 */
export async function markSlaBreachIfNeeded(db: Database, payoutRequestId: string, clock: Clock = systemClock): Promise<boolean> {
  const [op] = await db.select().from(payoutOperations).where(eq(payoutOperations.payoutRequestId, payoutRequestId));
  if (!op || op.slaBreached || !op.fastLane) return false;
  const submittedMs = ms(op.requestedAt, op.submittedAt);
  const ageMs = clock.now() - op.requestedAt.getTime();
  const stillOpen = ['PAYABLE', 'SUBMITTING', 'AUTOMATED_CHECKS', 'RECEIVED'].includes(op.opState);
  const breached = (submittedMs != null && submittedMs > SLA_TARGET_MS) || (stillOpen && ageMs > SLA_TARGET_MS);
  if (!breached) return false;
  await db.update(payoutOperations).set({ slaBreached: true, updatedAt: new Date() }).where(eq(payoutOperations.id, op.id));
  await events.publish(db, { type: 'payout.sla_breach', organizationId: op.organizationId, accountId: op.accountId, payload: { payoutRequestId, ageMs } });
  return true;
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export interface OwnerOverview {
  requestedToday: number;
  submittedToday: number;
  paidToday: number;
  dollarsRequestedMicros: number;
  dollarsSubmittedMicros: number;
  dollarsPaidMicros: number;
  fastLaneRate: number;
  exceptionRate: number;
  providerFailureRate: number;
  reconciliationMismatchRate: number;
  medianRequestToSubmissionMs: number | null;
  p90RequestToSubmissionMs: number | null;
  p95RequestToSubmissionMs: number | null;
  p99RequestToSubmissionMs: number | null;
  overFiveMinuteCount: number;
  exceptionCount: number;
  failedCount: number;
  returnedCount: number;
  reconciliationMismatchCount: number;
  provider: { id: string; configured: boolean; state: string };
  circuitBreakerOpen: boolean;
}

/** The owner Payout Operations overview — every figure from real data. */
export async function ownerOverview(db: Database, organizationId: string, clock: Clock = systemClock): Promise<OwnerOverview> {
  const dayStart = new Date(clock.now() - 24 * 60 * 60 * 1000);
  const ops = await db.select().from(payoutOperations).where(eq(payoutOperations.organizationId, organizationId));
  const recentOps = ops.filter((o) => o.requestedAt >= dayStart);

  const submissionDurations = ops
    .map((o) => ms(o.requestedAt, o.submittedAt))
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);

  const total = ops.length || 1;
  const fastLaneCount = ops.filter((o) => o.fastLane).length;
  const exceptionCount = ops.filter((o) => o.opState === 'EXCEPTION').length;
  const failedCount = ops.filter((o) => o.opState === 'FAILED').length;
  const returnedCount = ops.filter((o) => o.opState === 'RETURNED').length;
  const overFive = ops.filter((o) => isCleanSlaBreach(o) || o.slaBreached).length;

  const [{ mismatch } = { mismatch: 0 }] = await db
    .select({ mismatch: sql<number>`coalesce(count(*),0)::int` })
    .from(payoutReconciliationRecords)
    .where(and(eq(payoutReconciliationRecords.organizationId, organizationId), sql`${payoutReconciliationRecords.mismatchType} <> 'NONE'`));

  // Dollar figures from the linked requests (trader share).
  const dollars = async (opState: string[]): Promise<{ count: number; micros: number }> => {
    const [row] = await db.execute(sql`
      SELECT count(*)::int AS c, coalesce(sum(pr.trader_share_micros),0)::bigint AS m
      FROM payout_operations po JOIN payout_requests pr ON pr.id = po.payout_request_id
      WHERE po.organization_id = ${organizationId} AND po.requested_at >= ${dayStart}
        AND po.op_state = ANY(${opState})
    `) as unknown as Array<{ c: number; m: string | number }>;
    return { count: Number(row?.c ?? 0), micros: Number(row?.m ?? 0) };
  };
  const requestedDollars = await db.execute(sql`
    SELECT coalesce(sum(pr.requested_gross_micros),0)::bigint AS m
    FROM payout_operations po JOIN payout_requests pr ON pr.id = po.payout_request_id
    WHERE po.organization_id = ${organizationId} AND po.requested_at >= ${dayStart}
  `) as unknown as Array<{ m: string | number }>;
  const submittedDollars = await dollars(['SUBMITTED', 'PROCESSING', 'PAID', 'RECONCILED']);
  const paidDollars = await dollars(['PAID', 'RECONCILED']);

  const config = await getOpsConfig(db, organizationId);
  const provider = resolvePayoutProvider(config.provider);
  const health = await provider.health();

  return {
    requestedToday: recentOps.length,
    submittedToday: submittedDollars.count,
    paidToday: paidDollars.count,
    dollarsRequestedMicros: Number(requestedDollars[0]?.m ?? 0),
    dollarsSubmittedMicros: submittedDollars.micros,
    dollarsPaidMicros: paidDollars.micros,
    fastLaneRate: fastLaneCount / total,
    exceptionRate: exceptionCount / total,
    providerFailureRate: failedCount / total,
    reconciliationMismatchRate: (mismatch ?? 0) / total,
    medianRequestToSubmissionMs: percentile(submissionDurations, 50),
    p90RequestToSubmissionMs: percentile(submissionDurations, 90),
    p95RequestToSubmissionMs: percentile(submissionDurations, 95),
    p99RequestToSubmissionMs: percentile(submissionDurations, 99),
    overFiveMinuteCount: overFive,
    exceptionCount,
    failedCount,
    returnedCount,
    reconciliationMismatchCount: mismatch ?? 0,
    provider: { id: provider.id, configured: health.configured, state: health.state },
    circuitBreakerOpen: config.circuitBreakerOpen,
  };
}

/** The list views for the owner console (fast lane, exceptions, processing, …). */
export async function listOperations(db: Database, organizationId: string, filter: { opStates?: string[]; limit?: number } = {}): Promise<Array<OpRow & { requestedGrossMicros: number; traderShareMicros: number | null; accountPublicId: string | null; traderEmail: string | null }>> {
  const rows = await db.execute(sql`
    SELECT po.*, pr.requested_gross_micros, pr.trader_share_micros, a.public_id AS account_public_id, u.email AS trader_email
    FROM payout_operations po
    JOIN payout_requests pr ON pr.id = po.payout_request_id
    JOIN accounts a ON a.id = po.account_id
    LEFT JOIN users u ON u.id = a.user_id
    WHERE po.organization_id = ${organizationId}
      ${filter.opStates && filter.opStates.length > 0 ? sql`AND po.op_state = ANY(${filter.opStates})` : sql``}
    ORDER BY po.requested_at DESC
    LIMIT ${filter.limit ?? 200}
  `) as unknown as Array<Record<string, unknown>>;
  // Map snake_case rows to a camelCase-ish shape the routes forward.
  return rows.map((r) => ({
    ...(r as unknown as OpRow),
    requestedGrossMicros: Number(r['requested_gross_micros'] ?? 0),
    traderShareMicros: r['trader_share_micros'] == null ? null : Number(r['trader_share_micros']),
    accountPublicId: (r['account_public_id'] as string) ?? null,
    traderEmail: (r['trader_email'] as string) ?? null,
  }));
}

void payoutRequests;
