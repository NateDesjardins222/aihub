/**
 * HTTP surface for Payout Operations (Milestone 8).
 *
 * Owner routes drive the operations console (overview, queues, detail, config,
 * circuit breaker, retry/reconcile/route-review, and a SUPER_ADMIN-only, audited
 * break-glass manual resolution). Portal routes are strictly own-scoped: a trader
 * only ever sees their own destinations (masked), operations and timeline — never
 * a raw provider reference, another customer's data, or a fabricated PAID. The
 * webhook route trusts provider/server evidence only, never a browser.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import {
  accounts, customerIdentities, payoutOperationalChecks, payoutOperations, payoutProviderEvents,
  payoutReconciliationRecords, payoutRequests, payoutSubmissionAttempts, users,
} from '../../db/schema.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { requireRole, requireUser } from '../auth-plugin.js';
import { ApiError } from '../errors.js';
import type { Actor } from '../../platform/actor.js';
import { SYSTEM_ACTOR } from '../../platform/actor.js';
import { recordAudit } from '../../platform/audit.js';
import { identityIdForUser } from '../../platform/enforcement.js';
import {
  addDestination, disableDestination, listDestinations,
} from '../../platform/payout-destinations.js';
import {
  applyProviderPaid, customerSafeFor, getOperationByRequest, ingestProviderEvent, reconcilePayout,
  submitPayable, type ExceptionCategory, type OpState,
} from '../../platform/payout-operations.js';
import {
  getOpsConfig, updateOpsConfig, openCircuitBreaker, closeCircuitBreaker,
} from '../../platform/payout-ops-config.js';
import { ownerOverview, listOperations, slaTimings } from '../../platform/payout-ops-metrics.js';
import { resolvePayoutProvider } from '../../platform/payout-provider-registry.js';

function adminActor(request: { user?: { id: string; email: string } | undefined; ip?: string }): Actor {
  return { type: 'ADMIN', userId: request.user?.id ?? null, label: request.user?.email ?? null, ip: request.ip ?? null };
}

async function organizationOf(userId: string): Promise<string> {
  const { db } = getDb();
  const [row] = await db.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, userId));
  return row?.organizationId ?? (await defaultOrganizationId(db));
}

/** A customer-safe timeline for a payout — only authoritative, non-sensitive events. */
function customerTimeline(op: typeof payoutOperations.$inferSelect): Array<{ at: string; label: string }> {
  const steps: Array<[Date | null, string]> = [
    [op.requestedAt, 'Requested'],
    [op.checksCompletedAt, 'Eligibility confirmed'],
    [op.approvedAt, 'Approved'],
    [op.submittedAt, 'Submitted to provider'],
    [op.providerProcessingAt, 'Provider processing'],
    [op.paidAt, 'Paid'],
  ];
  return steps.filter(([d]) => d != null).map(([d, label]) => ({ at: (d as Date).toISOString(), label }));
}

// ============================================================================
// Owner — /api/v1/admin/payout-ops
// ============================================================================
export function payoutOpsAdminRoutes() {
  return async function register(app: FastifyInstance): Promise<void> {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);
    app.addHook('preHandler', requireRole('SUPPORT'));

    app.get('/overview', async (request) => {
      const org = await organizationOf(request.user!.id);
      return ownerOverview(db, org);
    });

    app.get('/operations', async (request) => {
      const org = await organizationOf(request.user!.id);
      const q = z.object({ state: z.string().max(200).optional() }).parse(request.query ?? {});
      const opStates = q.state ? q.state.split(',').map((s) => s.trim().toUpperCase()) : undefined;
      const rows = await listOperations(db, org, { opStates });
      return {
        operations: rows.map((r) => ({
          payoutRequestId: r.payoutRequestId, accountId: r.accountId, accountPublicId: r.accountPublicId,
          traderEmail: r.traderEmail, opState: r.opState, exceptionCategory: r.exceptionCategory,
          customerSafeCategory: r.customerSafeCategory, fastLane: r.fastLane, provider: r.provider,
          providerPayoutId: r.providerPayoutId, requestedGrossMicros: r.requestedGrossMicros,
          traderShareMicros: r.traderShareMicros, slaBreached: r.slaBreached,
          requestedAt: r.requestedAt, submittedAt: r.submittedAt, paidAt: r.paidAt,
          requestToSubmissionMs: slaTimings(r as never).requestToSubmissionMs,
        })),
      };
    });

    app.get('/config', async (request) => {
      const org = await organizationOf(request.user!.id);
      const config = await getOpsConfig(db, org);
      const provider = resolvePayoutProvider(config.provider);
      const health = await provider.health();
      return { config, providerHealth: { id: provider.id, isMock: provider.isMock, ...health } };
    });

    app.get<{ Params: { id: string } }>('/operations/:id', async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const org = await organizationOf(request.user!.id);
      const op = await getOperationByRequest(db, id);
      if (!op || op.organizationId !== org) throw ApiError.notFound('OPERATION_NOT_FOUND', 'No such payout operation.');
      const [request_] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, id));
      const [checks, attempts, events, recon] = await Promise.all([
        db.select().from(payoutOperationalChecks).where(eq(payoutOperationalChecks.payoutRequestId, id)).orderBy(payoutOperationalChecks.createdAt),
        db.select().from(payoutSubmissionAttempts).where(eq(payoutSubmissionAttempts.payoutRequestId, id)).orderBy(payoutSubmissionAttempts.attemptNumber),
        db.select().from(payoutProviderEvents).where(eq(payoutProviderEvents.payoutRequestId, id)).orderBy(desc(payoutProviderEvents.receivedAt)),
        db.select().from(payoutReconciliationRecords).where(eq(payoutReconciliationRecords.payoutRequestId, id)).orderBy(desc(payoutReconciliationRecords.createdAt)),
      ]);
      return { operation: op, request: request_, checks, attempts, providerEvents: events, reconciliation: recon, timings: slaTimings(op), timeline: customerTimeline(op) };
    });

    // ---- mutations (ADMIN) --------------------------------------------------
    app.patch('/config', { preHandler: requireRole('ADMIN') }, async (request) => {
      const org = await organizationOf(request.user!.id);
      const b = z.object({
        productionEnabled: z.boolean().optional(),
        provider: z.string().max(32).nullable().optional(),
        reserveThresholdMicros: z.number().int().min(0).optional(),
        maxSingleAutoMicros: z.number().int().min(0).nullable().optional(),
        maxAggregateAutoPerDayMicros: z.number().int().min(0).nullable().optional(),
        reconStaleThresholdSeconds: z.number().int().min(30).max(86400).optional(),
        expectedVersion: z.number().int().optional(),
      }).parse(request.body ?? {});
      try {
        const config = await updateOpsConfig(db, org, { ...b, actor: adminActor(request) });
        return { config };
      } catch (e) {
        if ((e as Error).message === 'CONFIG_CONFLICT') throw new ApiError(409, 'CONFIG_CONFLICT', 'The config changed while you were editing it.');
        throw e;
      }
    });

    app.post('/circuit-breaker', { preHandler: requireRole('ADMIN') }, async (request) => {
      const org = await organizationOf(request.user!.id);
      const b = z.object({ action: z.enum(['OPEN', 'CLOSE']), reason: z.string().min(3).max(300) }).parse(request.body);
      if (b.action === 'OPEN') await openCircuitBreaker(db, org, b.reason, adminActor(request));
      else await closeCircuitBreaker(db, org, b.reason, adminActor(request));
      return { ok: true, open: b.action === 'OPEN' };
    });

    app.post<{ Params: { id: string } }>('/operations/:id/retry', { preHandler: requireRole('ADMIN') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const op = await submitPayable(db, id);
      return { opState: op.opState };
    });

    app.post<{ Params: { id: string } }>('/operations/:id/reconcile', { preHandler: requireRole('ADMIN') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const r = await reconcilePayout(db, id, { trigger: 'MANUAL' });
      return r;
    });

    // Break-glass manual resolution — SUPER_ADMIN only, fully audited, requires
    // external evidence. NEVER a casual "Mark Paid" button.
    app.post<{ Params: { id: string } }>('/operations/:id/manual-resolution', { preHandler: requireRole('SUPER_ADMIN') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({
        resolution: z.enum(['MARK_PAID', 'ACKNOWLEDGE_RETURN']),
        reason: z.string().min(10).max(500),
        externalReference: z.string().min(3).max(200),
        amountMicros: z.number().int().positive(),
      }).parse(request.body);
      const org = await organizationOf(request.user!.id);
      const op = await getOperationByRequest(db, id);
      if (!op || op.organizationId !== org) throw ApiError.notFound('OPERATION_NOT_FOUND', 'No such payout operation.');
      await recordAudit(db, {
        organizationId: org, actor: adminActor(request), subjectType: 'ACCOUNT', subjectId: op.accountId, accountId: op.accountId,
        action: 'payout_ops.manual_resolution', newState: { payoutRequestId: id, resolution: b.resolution, externalReference: b.externalReference, amountMicros: b.amountMicros }, reason: b.reason,
      });
      if (b.resolution === 'MARK_PAID') {
        await applyProviderPaid(db, id, { providerPayoutId: `MANUAL:${b.externalReference}`, amountMicros: b.amountMicros });
      }
      const after = await getOperationByRequest(db, id);
      return { opState: after?.opState };
    });
  };
}

// ============================================================================
// Portal — /api/v1/portal/payout-ops (own-scoped, IDOR-safe)
// ============================================================================
export function payoutOpsPortalRoutes() {
  return async function register(app: FastifyInstance): Promise<void> {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    async function myIdentity(userId: string): Promise<string | null> {
      return identityIdForUser(db, userId);
    }

    app.get('/destinations', async (request) => {
      const identityId = await myIdentity(request.user!.id);
      if (!identityId) return { destinations: [], provider: null };
      const org = await organizationOf(request.user!.id);
      const config = await getOpsConfig(db, org);
      const rows = await listDestinations(db, identityId);
      // Never expose the raw provider reference — only the masked display.
      return {
        provider: config.provider,
        providerConfigured: config.provider != null,
        destinations: rows.map((d) => ({
          id: d.id, provider: d.provider, destinationType: d.destinationType, maskedDisplay: d.maskedDisplay,
          status: d.status, ownershipState: d.ownershipState, verifiedAt: d.verifiedAt, createdAt: d.createdAt,
        })),
      };
    });

    app.post('/destinations', async (request) => {
      const identityId = await myIdentity(request.user!.id);
      if (!identityId) throw ApiError.notFound('NOT_FOUND', 'No customer identity.');
      const org = await organizationOf(request.user!.id);
      const config = await getOpsConfig(db, org);
      if (!config.provider) throw ApiError.badRequest('PROVIDER_UNCONFIGURED', 'No payout provider is configured yet.');
      const provider = resolvePayoutProvider(config.provider);
      if (!provider.isMock) throw ApiError.badRequest('PROVIDER_HOSTED_REQUIRED', 'This provider requires its hosted setup flow.');
      // Dev/mock flow: synthesize a provider token (never a real credential).
      const providerRef = `mock_dest_${identityId.slice(0, 8)}_${Date.now()}`;
      const row = await addDestination(db, { organizationId: org, customerIdentityId: identityId, provider: config.provider, providerRef, actor: { type: 'USER', userId: request.user!.id, label: request.user!.email, ip: request.ip } });
      return { id: row.id, status: row.status, maskedDisplay: row.maskedDisplay };
    });

    app.post<{ Params: { id: string } }>('/destinations/:id/disable', async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const identityId = await myIdentity(request.user!.id);
      const [dest] = await db.select().from((await import('../../db/schema.js')).payoutDestinations).where(eq((await import('../../db/schema.js')).payoutDestinations.id, id));
      if (!dest || dest.customerIdentityId !== identityId) throw ApiError.notFound('NOT_FOUND', 'Destination not found.');
      await disableDestination(db, id, { type: 'USER', userId: request.user!.id, label: request.user!.email, ip: request.ip });
      return { ok: true };
    });

    app.get('/operations', async (request) => {
      const identityId = await myIdentity(request.user!.id);
      if (!identityId) return { operations: [] };
      // Own operations only, via the account → user → identity chain.
      const rows = await db.select({
        payoutRequestId: payoutOperations.payoutRequestId, opState: payoutOperations.opState,
        customerSafeCategory: payoutOperations.customerSafeCategory, exceptionCategory: payoutOperations.exceptionCategory,
        requestedAt: payoutOperations.requestedAt, paidAt: payoutOperations.paidAt,
        gross: payoutRequests.requestedGrossMicros, traderShare: payoutRequests.traderShareMicros,
      }).from(payoutOperations)
        .innerJoin(payoutRequests, eq(payoutRequests.id, payoutOperations.payoutRequestId))
        .where(eq(payoutOperations.customerIdentityId, identityId))
        .orderBy(desc(payoutOperations.requestedAt)).limit(50);
      return {
        operations: rows.map((r) => ({
          payoutRequestId: r.payoutRequestId,
          status: r.customerSafeCategory ?? customerSafeFor(r.opState as OpState, r.exceptionCategory as ExceptionCategory),
          requestedAt: r.requestedAt, paidAt: r.paidAt, grossMicros: r.gross, traderShareMicros: r.traderShare,
        })),
      };
    });

    app.get<{ Params: { id: string } }>('/operations/:id/timeline', async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const identityId = await myIdentity(request.user!.id);
      const op = await getOperationByRequest(db, id);
      if (!op || op.customerIdentityId !== identityId) throw ApiError.notFound('NOT_FOUND', 'Not found.');
      return {
        status: op.customerSafeCategory ?? customerSafeFor(op.opState as OpState, op.exceptionCategory as ExceptionCategory),
        timeline: customerTimeline(op),
      };
    });
  };
}

// ============================================================================
// Webhook — /api/v1/webhooks/payout  (no browser auth; provider evidence only)
// ============================================================================
export function payoutWebhookRoutes() {
  return async function register(app: FastifyInstance): Promise<void> {
    const { db } = getDb();
    app.post<{ Params: { provider: string }; Body: unknown }>(
      '/payout/:provider',
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const { provider: providerId } = z.object({ provider: z.string().max(32) }).parse(request.params);
        const provider = resolvePayoutProvider(providerId);
        // Signature verification seam: a real provider verifies request.headers here.
        // The unconfigured/unknown provider yields no normalized event → 202 no-op.
        const normalized = provider.normalizeWebhook(request.body);
        if (!normalized) return reply.code(202).send({ received: true, processed: false });
        const org = await defaultOrganizationId(db);
        const res = await ingestProviderEvent(db, {
          organizationId: org, provider: provider.id, providerEventId: normalized.providerEventId,
          providerPayoutId: normalized.providerPayoutId, normalizedType: normalized.normalizedType,
          eventTs: normalized.eventTs, amountMicros: normalized.amountMicros,
          payload: sanitize(request.body),
        });
        return reply.code(200).send({ received: true, deduped: res.deduped });
      },
    );
  };
}

/** Keep only safe scalar fields off a webhook body — never persist secrets/PII blobs. */
function sanitize(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (['id', 'type', 'payoutId', 'ts', 'status'].includes(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = v;
  }
  return out;
}

void accounts; void customerIdentities; void SYSTEM_ACTOR; void and;
