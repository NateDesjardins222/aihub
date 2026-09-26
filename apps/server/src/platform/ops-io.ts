/**
 * Owner OS operational I/O surfaces (M10-I): jobs/queues, webhooks, provider
 * control, market-data integrity, execution quality. Read-oriented aggregations
 * over the authoritative tables, plus one SAFE idempotent job retry. Truthful:
 * provider/market states never claim more than is actually known.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  commerceEvents, executions, externalExecutionEvents, orders, outboxEvents,
  payoutProviderEvents, providerConnectionEvents,
} from '../db/schema.js';
import { resolveRithmicConnection } from '../infra/rithmic-config.js';
import { providerSafetySummary, type ProviderMode } from '../config/provider-safety.js';
import { recordAudit } from './audit.js';
import type { Actor } from './actor.js';
import { ApiError } from '../http/errors.js';

const LAUNCH_INSTRUMENTS = ['NQ', 'MNQ', 'ES', 'MES', 'GC', 'MGC', 'CL', 'MCL'];

// ---------------------------------------------------------------------------
// Jobs / queues (the transactional outbox is the job/DLQ primitive)
// ---------------------------------------------------------------------------

export async function jobsSummary(db: Database): Promise<{ queued: number; delivered: number; deadLetter: number; retrying: number }> {
  const [row] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${outboxEvents.deliveredAt} is null and ${outboxEvents.deadLetter} = false)::int`,
      delivered: sql<number>`count(*) filter (where ${outboxEvents.deliveredAt} is not null)::int`,
      deadLetter: sql<number>`count(*) filter (where ${outboxEvents.deadLetter} = true)::int`,
      retrying: sql<number>`count(*) filter (where ${outboxEvents.deliveredAt} is null and ${outboxEvents.attempts} > 0 and ${outboxEvents.deadLetter} = false)::int`,
    })
    .from(outboxEvents);
  return { queued: Number(row?.queued ?? 0), delivered: Number(row?.delivered ?? 0), deadLetter: Number(row?.deadLetter ?? 0), retrying: Number(row?.retrying ?? 0) };
}

export async function listJobs(db: Database, opts: { state?: 'queued' | 'dead' | 'delivered'; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 100, 500);
  let where;
  if (opts.state === 'dead') where = eq(outboxEvents.deadLetter, true);
  else if (opts.state === 'delivered') where = sql`${outboxEvents.deliveredAt} is not null`;
  else if (opts.state === 'queued') where = and(sql`${outboxEvents.deliveredAt} is null`, eq(outboxEvents.deadLetter, false));
  const q = db.select({ id: outboxEvents.id, aggregateType: outboxEvents.aggregateType, type: outboxEvents.type, attempts: outboxEvents.attempts, availableAt: outboxEvents.availableAt, deliveredAt: outboxEvents.deliveredAt, deadLetter: outboxEvents.deadLetter, lastError: outboxEvents.lastError, createdAt: outboxEvents.createdAt }).from(outboxEvents);
  const rows = await (where ? q.where(where) : q).orderBy(desc(outboxEvents.createdAt)).limit(limit);
  return rows;
}

/** Safe retry: re-arm a dead-letter/failed job for the idempotent worker to pick up. */
export async function retryJob(db: Database, id: string, actor: Actor): Promise<void> {
  const [row] = await db.select({ id: outboxEvents.id, deliveredAt: outboxEvents.deliveredAt }).from(outboxEvents).where(eq(outboxEvents.id, id));
  if (!row) throw ApiError.notFound('JOB_NOT_FOUND', 'Job not found.');
  if (row.deliveredAt) throw ApiError.badRequest('ALREADY_DELIVERED', 'This job already succeeded; nothing to retry.');
  await db.update(outboxEvents).set({ deadLetter: false, availableAt: new Date(), lastError: null }).where(eq(outboxEvents.id, id));
  await recordAudit(db, { organizationId: null, actor, subjectType: 'ORGANIZATION', subjectId: null, action: 'job.retry', newState: { jobId: id }, reason: 'operator re-armed job' });
}

// ---------------------------------------------------------------------------
// Webhooks (inbound provider events; handlers are idempotent)
// ---------------------------------------------------------------------------

export async function webhooksSummary(db: Database, organizationId: string) {
  const [commerce] = await db
    .select({ total: sql<number>`count(*)::int`, processed: sql<number>`count(*) filter (where ${commerceEvents.status} = 'PROCESSED')::int`, failed: sql<number>`count(*) filter (where ${commerceEvents.status} = 'FAILED')::int` })
    .from(commerceEvents)
    .where(eq(commerceEvents.organizationId, organizationId));
  const [payout] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(payoutProviderEvents)
    .where(eq(payoutProviderEvents.organizationId, organizationId));
  return {
    commerce: { total: Number(commerce?.total ?? 0), processed: Number(commerce?.processed ?? 0), failed: Number(commerce?.failed ?? 0) },
    payout: { total: Number(payout?.total ?? 0) },
  };
}

export async function listWebhooks(db: Database, organizationId: string, limit = 100) {
  const rows = await db
    .select({ id: commerceEvents.id, provider: commerceEvents.provider, kind: commerceEvents.kind, status: commerceEvents.status, signatureOk: commerceEvents.signatureOk, createdAt: commerceEvents.createdAt })
    .from(commerceEvents)
    .where(eq(commerceEvents.organizationId, organizationId))
    .orderBy(desc(commerceEvents.createdAt))
    .limit(Math.min(limit, 500));
  return rows;
}

// ---------------------------------------------------------------------------
// Provider control (truthful; never fakes connectivity)
// ---------------------------------------------------------------------------

export async function providerStatuses(
  db: Database,
): Promise<
  Array<{
    provider: string;
    configured: boolean;
    verified: boolean;
    note: string;
    /** Phase 4: REAL / MOCK / UNAVAILABLE / DELIBERATE — never "healthy while silently mocked". */
    mode: ProviderMode | 'DELIBERATE';
    /** Phase 4: false only for the one unsafe state — a MOCK selected in production. */
    safeForProduction: boolean;
  }>
> {
  const r = resolveRithmicConnection();
  const recentRithmic = await db.select({ event: providerConnectionEvents.event, createdAt: providerConnectionEvents.createdAt }).from(providerConnectionEvents).where(eq(providerConnectionEvents.provider, 'RITHMIC')).orderBy(desc(providerConnectionEvents.createdAt)).limit(1);
  // The env-derived safety posture for the mock-capable capabilities. This is the
  // authoritative source the owner reads: a production server with no commerce or
  // identity config shows UNAVAILABLE (fail closed), never a "configured" mock.
  const safety = new Map(providerSafetySummary().map((s) => [s.capability, s]));
  const commerce = safety.get('COMMERCE')!;
  const identity = safety.get('IDENTITY')!;
  const email = safety.get('EMAIL')!;
  const sms = safety.get('SMS')!;
  return [
    {
      provider: 'RITHMIC',
      configured: r.ok,
      verified: false, // live acceptance (auth/market/route/exec) not confirmed in this environment
      note: r.ok ? `configured (${r.connection.environment}); live acceptance NOT verified${recentRithmic[0] ? `; last event ${recentRithmic[0].event}` : ''}` : `not configured (${r.missing.join(', ')})`,
      mode: 'DELIBERATE',
      safeForProduction: true,
    },
    {
      provider: 'COMMERCE',
      configured: commerce.mode === 'REAL',
      verified: false,
      note: `Whop commerce — ${commerce.detail}`,
      mode: commerce.mode,
      safeForProduction: commerce.safeForProduction,
    },
    {
      provider: 'IDENTITY',
      configured: identity.mode === 'REAL',
      verified: false,
      note: `Stripe Identity / KYC — ${identity.detail}`,
      mode: identity.mode,
      safeForProduction: identity.safeForProduction,
    },
    {
      provider: 'PAYOUT',
      configured: false,
      verified: false,
      note: 'no real payout rail; registry + treasury gate fail closed (no PAID via mock in production)',
      mode: 'UNAVAILABLE',
      safeForProduction: true,
    },
    {
      provider: 'EMAIL',
      configured: email.mode === 'REAL',
      verified: false,
      note: `Resend email — ${email.detail}`,
      mode: email.mode,
      safeForProduction: email.safeForProduction,
    },
    {
      provider: 'SMS_PUSH',
      configured: sms.mode === 'REAL',
      verified: false,
      note: `Twilio SMS — ${sms.detail}`,
      mode: sms.mode,
      safeForProduction: sms.safeForProduction,
    },
  ];
}

// ---------------------------------------------------------------------------
// Market data integrity (truthful; session-aware note)
// ---------------------------------------------------------------------------

export function marketDataIntegrity(): { instruments: Array<{ symbol: string; status: string; note: string }>; note: string } {
  return {
    instruments: LAUNCH_INSTRUMENTS.map((symbol) => ({ symbol, status: 'NOT_VERIFIED', note: 'requires a live provider feed + open session to verify freshness' })),
    note: 'Live freshness is only meaningful against a running provider feed during an expected-open session; market-closed is not a stale-feed failure.',
  };
}

// ---------------------------------------------------------------------------
// Execution quality (counts from canonical Atlas data)
// ---------------------------------------------------------------------------

export async function executionQuality(db: Database, sinceHours = 720): Promise<{ orders: Record<string, number>; executions: number; externalReports: number }> {
  const since = new Date(Date.now() - sinceHours * 3_600_000);
  const orderRows = await db.select({ status: orders.status, n: sql<number>`count(*)::int` }).from(orders).where(gte(orders.createdAt, since)).groupBy(orders.status);
  const [ex] = await db.select({ n: sql<number>`count(*)::int` }).from(executions).where(gte(executions.createdAt, since));
  const [ext] = await db.select({ n: sql<number>`count(*)::int` }).from(externalExecutionEvents);
  return {
    orders: Object.fromEntries(orderRows.map((r) => [r.status, r.n])),
    executions: Number(ex?.n ?? 0),
    externalReports: Number(ext?.n ?? 0),
  };
}
