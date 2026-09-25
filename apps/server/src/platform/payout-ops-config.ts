/**
 * Payout operations configuration, the treasury submission gate, and the circuit
 * breaker (Milestone 8).
 *
 * These are OPERATIONAL controls, not hidden trader rules. A treasury delay or an
 * open breaker never makes a trader ineligible and never rewrites paid history —
 * it only pauses external SUBMISSION. Real external money movement is disabled
 * until an owner explicitly enables it, and an unconfigured production provider
 * fails closed.
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { payoutCircuitBreakerEvents, payoutOperations, payoutOperationsConfig } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { type Actor, SYSTEM_ACTOR } from './actor.js';
import { resolvePayoutProvider, isProduction } from './payout-provider-registry.js';

export type OpsConfigRow = typeof payoutOperationsConfig.$inferSelect;

/** Read the org's config, creating a safe default (production disabled) if absent. */
export async function getOpsConfig(db: Database, organizationId: string): Promise<OpsConfigRow> {
  const [existing] = await db.select().from(payoutOperationsConfig).where(eq(payoutOperationsConfig.organizationId, organizationId));
  if (existing) return existing;
  const [created] = await db.insert(payoutOperationsConfig)
    .values({ organizationId })
    .onConflictDoNothing({ target: [payoutOperationsConfig.organizationId] })
    .returning();
  if (created) return created;
  const [winner] = await db.select().from(payoutOperationsConfig).where(eq(payoutOperationsConfig.organizationId, organizationId));
  return winner!;
}

export interface UpdateOpsConfigInput {
  productionEnabled?: boolean;
  provider?: string | null;
  reserveThresholdMicros?: number;
  maxSingleAutoMicros?: number | null;
  maxAggregateAutoPerDayMicros?: number | null;
  reconStaleThresholdSeconds?: number;
  actor: Actor;
  expectedVersion?: number;
}

/** Update the config, audited, with optional optimistic concurrency. */
export async function updateOpsConfig(db: Database, organizationId: string, input: UpdateOpsConfigInput): Promise<OpsConfigRow> {
  const current = await getOpsConfig(db, organizationId);
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
    throw new Error('CONFIG_CONFLICT');
  }
  const patch: Partial<OpsConfigRow> = { updatedAt: new Date(), version: current.version + 1 };
  if (input.productionEnabled !== undefined) patch.productionEnabled = input.productionEnabled;
  if (input.provider !== undefined) patch.provider = input.provider;
  if (input.reserveThresholdMicros !== undefined) patch.reserveThresholdMicros = input.reserveThresholdMicros;
  if (input.maxSingleAutoMicros !== undefined) patch.maxSingleAutoMicros = input.maxSingleAutoMicros;
  if (input.maxAggregateAutoPerDayMicros !== undefined) patch.maxAggregateAutoPerDayMicros = input.maxAggregateAutoPerDayMicros;
  if (input.reconStaleThresholdSeconds !== undefined) patch.reconStaleThresholdSeconds = input.reconStaleThresholdSeconds;
  const [updated] = await db.update(payoutOperationsConfig).set(patch).where(eq(payoutOperationsConfig.organizationId, organizationId)).returning();
  await recordAudit(db, {
    organizationId, actor: input.actor, subjectType: 'ACCOUNT', subjectId: organizationId,
    action: 'payout_ops.config_updated', prevState: { version: current.version }, newState: { ...patch, version: current.version + 1 }, reason: null,
  });
  return updated!;
}

// -- circuit breaker ---------------------------------------------------------

export async function openCircuitBreaker(db: Database, organizationId: string, reason: string, actor: Actor): Promise<void> {
  await db.update(payoutOperationsConfig).set({ circuitBreakerOpen: true, updatedAt: new Date(), version: sql`${payoutOperationsConfig.version} + 1` }).where(eq(payoutOperationsConfig.organizationId, organizationId));
  await db.insert(payoutCircuitBreakerEvents).values({ organizationId, action: 'OPEN', reason: reason.slice(0, 300), actorUserId: actorUserId(actor) });
  await recordAudit(db, { organizationId, actor, subjectType: 'ACCOUNT', subjectId: organizationId, action: 'payout_ops.circuit_breaker_opened', newState: { open: true }, reason });
  await events.publish(db, { type: 'payout.circuit_breaker_opened', organizationId, payload: { reason } });
}

export async function closeCircuitBreaker(db: Database, organizationId: string, reason: string, actor: Actor): Promise<void> {
  await db.update(payoutOperationsConfig).set({ circuitBreakerOpen: false, updatedAt: new Date(), version: sql`${payoutOperationsConfig.version} + 1` }).where(eq(payoutOperationsConfig.organizationId, organizationId));
  await db.insert(payoutCircuitBreakerEvents).values({ organizationId, action: 'CLOSE', reason: reason.slice(0, 300), actorUserId: actorUserId(actor) });
  await recordAudit(db, { organizationId, actor, subjectType: 'ACCOUNT', subjectId: organizationId, action: 'payout_ops.circuit_breaker_closed', newState: { open: false }, reason });
  await events.publish(db, { type: 'payout.circuit_breaker_closed', organizationId, payload: { reason } });
}

function actorUserId(actor: Actor): string | null {
  return actor.type === 'USER' || actor.type === 'ADMIN' ? actor.userId ?? null : null;
}

// -- treasury submission gate ------------------------------------------------

export type TreasuryDecision =
  | { ok: true }
  | { ok: false; category: 'TREASURY_REVIEW' | 'PROVIDER_UNAVAILABLE'; reason: string };

/**
 * The server-authoritative gate that decides whether a payout may be SUBMITTED to
 * the provider now. It never denies eligibility — a block means "approved/owed but
 * operationally delayed". Considers the circuit breaker, provider health/config,
 * per-submission and per-day automatic ceilings.
 */
export async function treasuryGate(
  db: Database,
  organizationId: string,
  amountMicros: number,
  config: OpsConfigRow,
): Promise<TreasuryDecision> {
  if (config.circuitBreakerOpen) {
    return { ok: false, category: 'TREASURY_REVIEW', reason: 'The payout circuit breaker is open; external submission is paused.' };
  }
  // A real (non-mock) provider requires production to be explicitly enabled.
  const provider = resolvePayoutProvider(config.provider);
  if (provider.id === 'UNCONFIGURED') {
    return { ok: false, category: 'PROVIDER_UNAVAILABLE', reason: 'No payout provider is configured.' };
  }
  if (!provider.isMock && !config.productionEnabled) {
    return { ok: false, category: 'PROVIDER_UNAVAILABLE', reason: 'Production payouts are not enabled.' };
  }
  if (provider.isMock && isProduction()) {
    return { ok: false, category: 'PROVIDER_UNAVAILABLE', reason: 'The mock provider cannot run in production.' };
  }
  const health = await provider.health();
  if (health.state === 'DOWN') {
    return { ok: false, category: 'PROVIDER_UNAVAILABLE', reason: 'The payout provider is currently unavailable.' };
  }
  if (config.maxSingleAutoMicros != null && amountMicros > config.maxSingleAutoMicros) {
    return { ok: false, category: 'TREASURY_REVIEW', reason: 'This payout exceeds the automatic single-submission ceiling.' };
  }
  if (config.maxAggregateAutoPerDayMicros != null) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await db.select({ n: sql<number>`coalesce(count(*),0)::int` })
      .from(payoutOperations)
      .where(and(
        eq(payoutOperations.organizationId, organizationId),
        gte(payoutOperations.submittedAt, since),
        inArray(payoutOperations.opState, ['SUBMITTED', 'PROCESSING', 'PAID', 'RECONCILED']),
      ));
    void rows; // count is a coarse guard; amount-aggregate handled by ceiling below
    const [agg] = await db.execute(sql`
      SELECT coalesce(sum(pr.trader_share_micros),0)::bigint AS total
      FROM payout_operations po
      JOIN payout_requests pr ON pr.id = po.payout_request_id
      WHERE po.organization_id = ${organizationId}
        AND po.submitted_at >= ${since.toISOString()}::timestamptz
        AND po.op_state IN ('SUBMITTED','PROCESSING','PAID','RECONCILED')
    `) as unknown as Array<{ total: string | number }>;
    const total = Number(agg?.total ?? 0);
    if (total + amountMicros > config.maxAggregateAutoPerDayMicros) {
      return { ok: false, category: 'TREASURY_REVIEW', reason: 'The daily automatic payout ceiling has been reached.' };
    }
  }
  void SYSTEM_ACTOR;
  return { ok: true };
}
