/**
 * HTTP surface for enforcement (M7). Owner routes drive the review queue, cases,
 * holds, findings, actions and appeals; trader routes expose only a customer-safe
 * view plus information responses and appeal submission. RBAC is server-enforced:
 * SUPPORT reads, ADMIN investigates/holds/findings-of-no-violation, and SUPER_ADMIN
 * is required to confirm a serious violation, terminate, or override the
 * appeal-independence guard. A trader can only ever touch their own case.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { and } from 'drizzle-orm';
import { customerIdentities, enforcementCases, users } from '../../db/schema.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { requireRole, requireUser } from '../auth-plugin.js';
import { ApiError } from '../errors.js';
import type { Actor } from '../../platform/actor.js';
import { revokeAllSessions } from '../../auth/service.js';
import { setIdentityHold } from '../../platform/customer-identity.js';
import {
  ACTION_TYPES, CASE_STATUSES, FINDING_REASON_CODES, HOLD_CAPABILITIES, HOLD_SCOPES,
  SUPER_ADMIN_ACTIONS, isAdverseFinding,
} from '../../platform/enforcement-core.js';
import {
  EnforcementError, addEvidence, addNote, assignCase, caseDetail, createInformationRequest,
  customerCaseViews, decideAppeal, enforcementSummary, getCase, identityIdForUser, ingestSignal, listCases,
  listHolds, listSignals, openCase, placeHold, recordAction, recordFinding, releaseHold, respondToInformationRequest,
  submitAppeal, transitionCase,
} from '../../platform/enforcement.js';

function actorOf(request: { user?: { id: string; email?: string } | null; ip?: string }): Actor {
  return { type: 'ADMIN', userId: request.user!.id, label: request.user?.email, ip: request.ip };
}

function mapError(err: unknown): never {
  if (err instanceof EnforcementError) {
    const status = err.code === 'CASE_NOT_FOUND' || err.code === 'NOT_FOUND' || err.code === 'HOLD_NOT_FOUND' ? 404
      : err.code === 'VERSION_CONFLICT' || err.code === 'ALREADY_DECIDED' || err.code === 'ALREADY_RESPONDED' ? 409
      : err.code === 'SAME_REVIEWER' ? 403 : 400;
    throw new ApiError(status, err.code, err.message);
  }
  throw err;
}

/** userId that owns a case (via its customer identity). */
async function caseOwnerUserId(db: ReturnType<typeof getDb>['db'], customerIdentityId: string): Promise<string | null> {
  const [row] = await db.select({ userId: customerIdentities.userId }).from(customerIdentities).where(eq(customerIdentities.id, customerIdentityId));
  return row?.userId ?? null;
}

/**
 * Resolve a case the caller owns, by its public reference (HTR-XXXXXX) or its
 * internal id, scoped to the caller's identity. Returns null when it is not
 * theirs — the IDOR guard for the portal, which never trusts a client-supplied
 * identifier to belong to the caller.
 */
async function caseForOwner(db: ReturnType<typeof getDb>['db'], ref: string, customerIdentityId: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  const isRef = /^HTR-[A-Z0-9]{6}$/i.test(ref);
  if (!isUuid && !isRef) return null; // never send garbage to a uuid column
  const column = isRef ? enforcementCases.publicRef : enforcementCases.id;
  const [row] = await db.select().from(enforcementCases)
    .where(and(eq(column, ref), eq(enforcementCases.customerIdentityId, customerIdentityId)));
  return row ?? null;
}

// ============================================================================
// Owner / operator routes — mounted at /api/v1/admin/enforcement
// ============================================================================
export function enforcementAdminRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);
    app.addHook('preHandler', requireRole('SUPPORT'));

    app.get('/summary', async (request) => {
      const org = await defaultOrganizationId(db);
      void request;
      return enforcementSummary(db, org);
    });

    app.get('/cases', async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({ status: z.string().optional(), severity: z.string().optional(), category: z.string().optional(), assignedToUserId: z.string().uuid().optional() }).parse(request.query ?? {});
      return { cases: await listCases(db, org, q) };
    });

    app.get('/signals', async () => {
      const org = await defaultOrganizationId(db);
      return { signals: await listSignals(db, org) };
    });

    app.get('/holds', async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({ status: z.string().optional(), capability: z.string().optional() }).parse(request.query ?? {});
      return { holds: await listHolds(db, org, q) };
    });

    app.get('/cases/:id', async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const detail = await caseDetail(db, id);
      if (!detail) throw ApiError.notFound('CASE_NOT_FOUND', 'Case not found.');
      return detail;
    });

    // ---- mutations (ADMIN) --------------------------------------------------
    app.post('/cases', { preHandler: requireRole('ADMIN') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({
        customerIdentityId: z.string().uuid(),
        category: z.string().min(1),
        accountId: z.string().uuid().optional(),
        reasonCode: z.string().optional(),
        severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
      }).parse(request.body);
      try {
        const row = await openCase(db, { organizationId: org, customerIdentityId: b.customerIdentityId, category: b.category as never, accountId: b.accountId ?? null, reasonCode: b.reasonCode ?? null, severity: b.severity, correlationKey: null, actor: actorOf(request) });
        return { case: row };
      } catch (e) { mapError(e); }
    });

    app.post('/cases/:id/assign', { preHandler: requireRole('ADMIN') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ assigneeUserId: z.string().uuid().nullable() }).parse(request.body);
      try { return { case: await assignCase(db, id, b.assigneeUserId, actorOf(request)) }; } catch (e) { mapError(e); }
    });

    app.post('/cases/:id/transition', { preHandler: requireRole('ADMIN') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ to: z.enum(CASE_STATUSES), reason: z.string().max(500).optional(), expectedVersion: z.number().int().optional() }).parse(request.body);
      try { return { case: await transitionCase(db, { caseId: id, to: b.to, actor: actorOf(request), reason: b.reason ?? null, expectedVersion: b.expectedVersion }) }; } catch (e) { mapError(e); }
    });

    app.post('/cases/:id/note', { preHandler: requireRole('ADMIN') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ body: z.string().min(1).max(8000), visibility: z.enum(['INTERNAL', 'CUSTOMER_SAFE']).optional() }).parse(request.body);
      try { await addNote(db, { caseId: id, authorUserId: request.user!.id, body: b.body, visibility: b.visibility, actor: actorOf(request) }); return { ok: true }; } catch (e) { mapError(e); }
    });

    app.post('/cases/:id/evidence', { preHandler: requireRole('ADMIN') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ type: z.string().min(1).max(40), source: z.string().min(1).max(24), sourceRef: z.string().max(200).optional(), visibility: z.enum(['INTERNAL', 'CUSTOMER_SAFE', 'LEGAL_RESTRICTED']).optional(), integrityHash: z.string().max(64).optional() }).parse(request.body);
      try { const evId = await addEvidence(db, { caseId: id, type: b.type, source: b.source, sourceRef: b.sourceRef ?? null, visibility: b.visibility, integrityHash: b.integrityHash ?? null, createdByUserId: request.user!.id, actor: actorOf(request) }); return { evidenceId: evId }; } catch (e) { mapError(e); }
    });

    app.post('/cases/:id/holds', { preHandler: requireRole('ADMIN') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ scope: z.enum(HOLD_SCOPES), scopeId: z.string().uuid(), capability: z.enum(HOLD_CAPABILITIES), reasonCode: z.string().min(1).max(48), customerSafeCategory: z.string().max(40).optional(), expiresAt: z.string().datetime().optional(), idempotencyKey: z.string().max(200).optional() }).parse(request.body);
      const c = await getCase(db, id);
      if (!c) throw ApiError.notFound('CASE_NOT_FOUND', 'Case not found.');
      const hold = await placeHold(db, { organizationId: org, caseId: id, scope: b.scope, scopeId: b.scopeId, capability: b.capability, reasonCode: b.reasonCode, customerSafeCategory: b.customerSafeCategory ?? c.customerSafeCategory, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null, createdByUserId: request.user!.id, idempotencyKey: b.idempotencyKey, actor: actorOf(request) });
      return { hold };
    });

    app.post('/holds/:id/release', { preHandler: requireRole('ADMIN') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ reason: z.string().max(200).optional() }).parse(request.body ?? {});
      try { const hold = await releaseHold(db, id, { actor: actorOf(request), reason: b.reason ?? null, releasedByUserId: request.user!.id }); return { hold }; } catch (e) { mapError(e); }
    });

    app.post('/cases/:id/finding', { preHandler: requireRole('ADMIN') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ reasonCode: z.enum(FINDING_REASON_CODES), summarySafe: z.string().max(2000).optional(), rationaleInternal: z.string().max(8000).optional(), appealable: z.boolean().optional() }).parse(request.body);
      // Confirming a serious (adverse) violation requires SUPER_ADMIN. NO_VIOLATION is ADMIN.
      if (isAdverseFinding(b.reasonCode) && request.user!.role !== 'SUPER_ADMIN') {
        throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Confirming a violation requires a senior operator.');
      }
      try { const f = await recordFinding(db, { organizationId: (await defaultOrganizationId(db)), caseId: id, reasonCode: b.reasonCode, summarySafe: b.summarySafe ?? null, rationaleInternal: b.rationaleInternal ?? null, appealable: b.appealable, decidedByUserId: request.user!.id, actor: actorOf(request) }); return { finding: f }; } catch (e) { mapError(e); }
    });

    app.post('/cases/:id/action', { preHandler: requireRole('ADMIN') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ actionType: z.enum(ACTION_TYPES), reasonCode: z.string().max(48).optional(), idempotencyKey: z.string().max(200).optional() }).parse(request.body);
      if (SUPER_ADMIN_ACTIONS.has(b.actionType) && request.user!.role !== 'SUPER_ADMIN') {
        throw new ApiError(403, 'INSUFFICIENT_ROLE', 'This action requires a senior operator.');
      }
      const c = await getCase(db, id);
      if (!c) throw ApiError.notFound('CASE_NOT_FOUND', 'Case not found.');
      const ownerUserId = await caseOwnerUserId(db, c.customerIdentityId);
      // Real effects for the actions whose primitives exist.
      if ((b.actionType === 'REVOKE_SESSIONS' || b.actionType === 'FORCE_SESSION_REAUTH') && ownerUserId) {
        await revokeAllSessions(db, ownerUserId);
      }
      if (b.actionType === 'CUSTOMER_TERMINATION' && ownerUserId) {
        await db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, ownerUserId));
        await revokeAllSessions(db, ownerUserId);
        await setIdentityHold(db, { identityId: c.customerIdentityId, status: 'CLOSED', reason: 'Enforcement: customer terminated', actor: actorOf(request) }).catch(() => undefined);
      }
      const res = await recordAction(db, { organizationId: org, caseId: id, actionType: b.actionType, reasonCode: b.reasonCode ?? null, performedByUserId: request.user!.id, actor: actorOf(request), idempotencyKey: b.idempotencyKey });
      return { actionId: res.id, deduped: res.deduped };
    });

    app.post('/cases/:id/info-request', { preHandler: requireRole('ADMIN') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ requestType: z.string().min(1).max(48), messageSafe: z.string().min(1).max(4000), dueAt: z.string().datetime().optional() }).parse(request.body);
      try { const reqId = await createInformationRequest(db, { caseId: id, requestType: b.requestType, messageSafe: b.messageSafe, dueAt: b.dueAt ? new Date(b.dueAt) : null, requestedByUserId: request.user!.id, actor: actorOf(request) }); return { requestId: reqId }; } catch (e) { mapError(e); }
    });

    // ---- appeals (owner side) ----------------------------------------------
    app.post('/appeals/:id/decide', { preHandler: requireRole('ADMIN') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ decision: z.enum(['UPHELD', 'OVERTURNED', 'PARTIALLY_REMEDIATED', 'INFORMATION_REQUESTED']), rationaleInternal: z.string().max(8000).optional(), customerSafeExplanation: z.string().max(2000).optional(), overrideSameReviewer: z.boolean().optional() }).parse(request.body);
      // A same-reviewer override requires SUPER_ADMIN.
      if (b.overrideSameReviewer && request.user!.role !== 'SUPER_ADMIN') {
        throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Overriding reviewer independence requires a senior operator.');
      }
      try {
        await decideAppeal(db, { appealId: id, decision: b.decision, decidedByUserId: request.user!.id, rationaleInternal: b.rationaleInternal ?? null, customerSafeExplanation: b.customerSafeExplanation ?? null, overrideSameReviewer: b.overrideSameReviewer, overrideByUserId: b.overrideSameReviewer ? request.user!.id : null, actor: actorOf(request) });
        return { ok: true };
      } catch (e) { mapError(e); }
    });
  };
}

// ============================================================================
// Trader routes — mounted at /api/v1/portal/enforcement (owner-scoped, IDOR-safe)
// ============================================================================
export function enforcementPortalRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    /** The caller's own customer-safe case views. Never any internal detail. */
    app.get('/cases', async (request) => {
      const identityId = await identityIdForUser(db, request.user!.id);
      if (!identityId) return { cases: [] };
      return { cases: await customerCaseViews(db, identityId) };
    });

    app.post('/info-requests/:id/respond', async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ responseText: z.string().min(1).max(8000) }).parse(request.body);
      const identityId = await identityIdForUser(db, request.user!.id);
      if (!identityId) throw ApiError.notFound('NOT_FOUND', 'Not found.');
      try { await respondToInformationRequest(db, { requestId: id, customerIdentityId: identityId, responseText: b.responseText }); return { ok: true }; } catch (e) { mapError(e); }
    });

    // The customer only ever knows a case by its public reference (HTR-XXXXXX),
    // never its internal id — so the appeal is looked up by (reference, owner).
    // Accepting a UUID too keeps the endpoint robust to either identifier.
    app.post('/cases/:id/appeal', async (request) => {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
      const b = z.object({ statement: z.string().min(1).max(8000) }).parse(request.body);
      const identityId = await identityIdForUser(db, request.user!.id);
      if (!identityId) throw ApiError.notFound('NOT_FOUND', 'Not found.');
      const c = await caseForOwner(db, id, identityId);
      if (!c) throw ApiError.notFound('NOT_FOUND', 'Not found.');
      try { const appeal = await submitAppeal(db, { caseId: c.id, customerIdentityId: identityId, customerStatement: b.statement, actor: { type: 'USER', userId: request.user!.id, label: request.user!.email, ip: request.ip } }); return { appealId: appeal.id, status: appeal.status }; } catch (e) { mapError(e); }
    });

    /** A customer-initiated security report becomes a signal (never accuses the customer). */
    app.post('/report', async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({ kind: z.enum(['CUSTOMER_REPORTED_ACCESS', 'CUSTOMER_REPORTED_PURCHASE', 'CUSTOMER_REPORTED_PAYOUT_CHANGE']), detail: z.string().max(2000).optional() }).parse(request.body);
      const identityId = await identityIdForUser(db, request.user!.id);
      if (!identityId) throw ApiError.notFound('NOT_FOUND', 'Not found.');
      const res = await ingestSignal(db, {
        organizationId: org, source: 'CUSTOMER_REPORT', kind: b.kind, customerIdentityId: identityId,
        dedupeKey: `custreport:${identityId}:${b.kind}:${Date.now()}`, openCaseCategory: 'SECURITY',
        metadata: { detail: (b.detail ?? '').slice(0, 2000) }, actor: { type: 'USER', userId: request.user!.id, label: request.user!.email, ip: request.ip },
      });
      return { received: true, reference: res.caseId ? 'opened' : 'recorded' };
    });
  };
}
