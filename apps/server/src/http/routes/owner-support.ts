/**
 * Owner Support operations (Milestone 12). Mounted at /api/v1/admin/ops. Every
 * route is permission-gated; sensitive money remediation is four-eyes + role-gated
 * in the domain. Support investigates and requests; authorized roles approve.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { requireUser } from '../auth-plugin.js';
import { requirePermission, requireAnyPermission, actorFromRequest } from '../owner-plugin.js';
import { ApiError } from '../errors.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { supportCategories, supportKbArticles, supportTemplates } from '../../db/schema.js';
import { getSupportConfig, updateSupportConfig, listCategories, PRIORITIES, TICKET_STATUSES, RESOLUTION_CODES, ROOT_CAUSE_CATEGORIES, REMEDIATION_TYPES, SUPPORT_TEAMS } from '../../platform/support-config.js';
import {
  addMessage, assignTicket, escalateTicket, reopenTicket, resolveTicket, setPriority, setTags, splitTicket, mergeTickets, transitionStatus, getTicketRow,
} from '../../platform/support-tickets.js';
import { listInbox, supportOverview, ticketWorkspace } from '../../platform/support-inbox.js';
import { linkObject, unlinkObject, markEvidence, investigationTimeline } from '../../platform/support-links.js';
import { whatHappened, refundEligibility } from '../../platform/support-diagnostics.js';
import { approveRemediation, denyRemediation, executeRemediation, getRemediation, requestRemediation } from '../../platform/support-remediation.js';
import { createAttachment, canAccessAttachment, getAttachment, readAttachmentBytes } from '../../platform/support-attachments.js';

function hasPerm(request: FastifyRequest, perm: string): boolean {
  return !!request.ownerAccess?.permissions.includes(perm);
}

export function ownerSupportRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);
    const uuid = (v: unknown) => z.object({ id: z.string().uuid() }).parse(v).id;

    app.get('/support/overview', { preHandler: requirePermission('support.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return supportOverview(db, org);
    });

    app.get('/support/inbox', { preHandler: requirePermission('support.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({ view: z.string().optional(), category: z.string().optional(), priority: z.string().optional(), team: z.string().optional(), assigneeUserId: z.string().optional(), status: z.string().optional(), incidentId: z.string().optional(), q: z.string().optional(), cursor: z.string().optional() }).parse(request.query ?? {});
      return listInbox(db, org, { ...q, view: q.view as never, viewerUserId: request.user!.id });
    });

    app.get('/support/config', { preHandler: requirePermission('support.read') }, async () => {
      const org = await defaultOrganizationId(db);
      const cfg = await getSupportConfig(db, org);
      const cats = await listCategories(db, org);
      return { ...cfg, categories: cats, enums: { priorities: PRIORITIES, statuses: TICKET_STATUSES, resolutionCodes: RESOLUTION_CODES, rootCauses: ROOT_CAUSE_CATEGORIES, remediationTypes: REMEDIATION_TYPES, teams: SUPPORT_TEAMS } };
    });
    app.post('/support/config', { preHandler: requirePermission('support.config.manage') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.record(z.string(), z.unknown()).parse(request.body ?? {});
      return updateSupportConfig(db, org, b as never, actorFromRequest(request));
    });

    app.get('/support/templates', { preHandler: requirePermission('support.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return { templates: await db.select().from(supportTemplates).where(and(eq(supportTemplates.organizationId, org), eq(supportTemplates.active, true))) };
    });
    app.post('/support/templates', { preHandler: requirePermission('support.templates.manage') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({ key: z.string().min(1).max(48), name: z.string().min(1).max(120), category: z.string().max(48).optional(), body: z.string().min(1) }).parse(request.body);
      const [row] = await db.insert(supportTemplates).values({ organizationId: org, key: b.key, name: b.name, category: b.category ?? null, body: b.body, updatedByUserId: request.user!.id })
        .onConflictDoUpdate({ target: [supportTemplates.organizationId, supportTemplates.key], set: { name: b.name, body: b.body, category: b.category ?? null, updatedAt: new Date() } }).returning();
      return { id: row!.id };
    });

    app.post('/support/kb', { preHandler: requirePermission('support.config.manage') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({ slug: z.string().min(1).max(80), title: z.string().min(1).max(200), category: z.string().max(48).optional(), body: z.string().min(1), published: z.boolean().optional(), sortOrder: z.number().int().optional() }).parse(request.body);
      const [row] = await db.insert(supportKbArticles).values({ organizationId: org, slug: b.slug, title: b.title, category: b.category ?? null, body: b.body, published: b.published ?? false, sortOrder: b.sortOrder ?? 0, updatedByUserId: request.user!.id })
        .onConflictDoUpdate({ target: [supportKbArticles.organizationId, supportKbArticles.slug], set: { title: b.title, body: b.body, category: b.category ?? null, published: b.published ?? false, updatedAt: new Date() } }).returning();
      return { id: row!.id };
    });

    // -- one ticket ----------------------------------------------------------
    app.get('/support/tickets/:id', { preHandler: requirePermission('support.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const view = await ticketWorkspace(db, org, uuid(request.params));
      if (!view) throw ApiError.notFound('TICKET_NOT_FOUND', 'Ticket not found.');
      return view;
    });

    app.post('/support/tickets/:id/reply', { preHandler: requirePermission('support.respond') }, async (request) => {
      const b = z.object({ body: z.string().min(1).max(8000), idempotencyKey: z.string().max(80).optional() }).parse(request.body);
      const res = await addMessage(db, { ticketId: uuid(request.params), senderType: 'STAFF', visibility: 'CUSTOMER', body: b.body, idempotencyKey: b.idempotencyKey ?? null, actor: actorFromRequest(request) });
      return { id: res.id };
    });
    app.post('/support/tickets/:id/note', { preHandler: requirePermission('support.notes.write') }, async (request) => {
      const b = z.object({ body: z.string().min(1).max(8000), mentions: z.array(z.string()).max(20).optional() }).parse(request.body);
      const res = await addMessage(db, { ticketId: uuid(request.params), senderType: 'STAFF', visibility: 'INTERNAL', body: b.body, mentions: b.mentions, actor: actorFromRequest(request) });
      return { id: res.id };
    });
    app.post('/support/tickets/:id/assign', { preHandler: requirePermission('support.assign') }, async (request) => {
      const b = z.object({ assigneeUserId: z.string().uuid().nullable(), team: z.enum(SUPPORT_TEAMS).nullable().optional() }).parse(request.body);
      await assignTicket(db, { ticketId: uuid(request.params), assigneeUserId: b.assigneeUserId, team: b.team ?? undefined, actor: actorFromRequest(request) });
      return { ok: true };
    });
    app.post('/support/tickets/:id/priority', { preHandler: requirePermission('support.assign') }, async (request) => {
      const b = z.object({ priority: z.enum(PRIORITIES), reason: z.string().max(500).optional() }).parse(request.body);
      await setPriority(db, { ticketId: uuid(request.params), priority: b.priority, actor: actorFromRequest(request), reason: b.reason });
      return { ok: true };
    });
    app.post('/support/tickets/:id/status', { preHandler: requirePermission('support.respond') }, async (request) => {
      const b = z.object({ to: z.enum(TICKET_STATUSES), reason: z.string().max(500).optional(), expectedVersion: z.number().int().optional() }).parse(request.body);
      await transitionStatus(db, { ticketId: uuid(request.params), to: b.to, actor: actorFromRequest(request), reason: b.reason, expectedVersion: b.expectedVersion });
      return { ok: true };
    });
    app.post('/support/tickets/:id/tags', { preHandler: requirePermission('support.respond') }, async (request) => {
      const b = z.object({ tags: z.array(z.string().max(40)).max(20) }).parse(request.body);
      await setTags(db, { ticketId: uuid(request.params), tags: b.tags, actor: actorFromRequest(request) });
      return { ok: true };
    });
    app.post('/support/tickets/:id/escalate', { preHandler: requirePermission('support.escalate') }, async (request) => {
      const b = z.object({ team: z.enum(SUPPORT_TEAMS), priority: z.enum(PRIORITIES).optional(), reason: z.string().min(1).max(500), note: z.string().max(2000).optional() }).parse(request.body);
      await escalateTicket(db, { ticketId: uuid(request.params), team: b.team, priority: b.priority, reason: b.reason, note: b.note, actor: actorFromRequest(request) });
      return { ok: true };
    });
    app.post('/support/tickets/:id/resolve', { preHandler: requirePermission('support.resolve') }, async (request) => {
      const b = z.object({ resolutionCode: z.enum(RESOLUTION_CODES), customerSummary: z.string().min(1).max(4000), internalNotes: z.string().max(4000).optional(), rootCause: z.enum(ROOT_CAUSE_CATEGORIES).optional(), expectedVersion: z.number().int().optional() }).parse(request.body);
      await resolveTicket(db, { ticketId: uuid(request.params), resolutionCode: b.resolutionCode, customerSummary: b.customerSummary, internalNotes: b.internalNotes, rootCause: b.rootCause, actor: actorFromRequest(request), expectedVersion: b.expectedVersion });
      return { ok: true };
    });
    app.post('/support/tickets/:id/reopen', { preHandler: requirePermission('support.resolve') }, async (request) => {
      const b = z.object({ reason: z.string().min(1).max(500) }).parse(request.body);
      await reopenTicket(db, { ticketId: uuid(request.params), actor: actorFromRequest(request), reason: b.reason, byCustomer: false });
      return { ok: true };
    });

    // -- linking / evidence / diagnostics / timeline -------------------------
    app.post('/support/tickets/:id/link', { preHandler: requirePermission('support.respond') }, async (request) => {
      const b = z.object({ objectType: z.string().max(40), objectId: z.string().max(128), label: z.string().max(200).optional() }).parse(request.body);
      return linkObject(db, { ticketId: uuid(request.params), objectType: b.objectType, objectId: b.objectId, label: b.label, actor: actorFromRequest(request) });
    });
    app.post('/support/tickets/:id/unlink', { preHandler: requirePermission('support.respond') }, async (request) => {
      const b = z.object({ linkId: z.string().uuid() }).parse(request.body);
      await unlinkObject(db, { ticketId: uuid(request.params), linkId: b.linkId, actor: actorFromRequest(request) });
      return { ok: true };
    });
    app.post('/support/tickets/:id/evidence', { preHandler: requirePermission('support.evidence.manage') }, async (request) => {
      const b = z.object({ sourceType: z.enum(['ATTACHMENT', 'OBJECT', 'EVENT']), sourceRef: z.string().min(1).max(128), objectType: z.string().max(40).optional(), description: z.string().max(2000).optional() }).parse(request.body);
      return markEvidence(db, { ticketId: uuid(request.params), sourceType: b.sourceType, sourceRef: b.sourceRef, objectType: b.objectType, description: b.description, actor: actorFromRequest(request) });
    });
    app.get('/support/tickets/:id/timeline', { preHandler: requirePermission('support.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      return { timeline: await investigationTimeline(db, org, uuid(request.params)) };
    });
    app.get('/support/diagnostics', { preHandler: requirePermission('support.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({ objectType: z.string().max(40), objectId: z.string().max(128) }).parse(request.query ?? {});
      return whatHappened(db, org, q.objectType, q.objectId);
    });
    app.get('/support/refund-eligibility', { preHandler: requirePermission('support.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({ orderId: z.string().uuid() }).parse(request.query ?? {});
      return refundEligibility(db, org, q.orderId);
    });

    // -- merge / split -------------------------------------------------------
    app.post('/support/tickets/:id/merge', { preHandler: requirePermission('support.respond') }, async (request) => {
      const b = z.object({ secondaryId: z.string().uuid() }).parse(request.body);
      await mergeTickets(db, { primaryId: uuid(request.params), secondaryId: b.secondaryId, actor: actorFromRequest(request) });
      return { ok: true };
    });
    app.post('/support/tickets/:id/split', { preHandler: requirePermission('support.respond') }, async (request) => {
      const b = z.object({ subject: z.string().min(3).max(200), categoryKey: z.string().max(48), body: z.string().min(1).max(8000) }).parse(request.body);
      return splitTicket(db, { fromTicketId: uuid(request.params), subject: b.subject, categoryKey: b.categoryKey, body: b.body, actor: actorFromRequest(request) });
    });

    // -- remediation ---------------------------------------------------------
    app.post('/support/tickets/:id/remediations', { preHandler: requireAnyPermission('support.remediation.request', 'support.refund.request') }, async (request) => {
      const b = z.object({ type: z.enum(REMEDIATION_TYPES), reason: z.string().min(1).max(2000), detail: z.record(z.string(), z.unknown()).optional(), amountMicros: z.number().int().positive().nullable().optional(), idempotencyKey: z.string().max(80).optional() }).parse(request.body);
      const needsRefund = b.type === 'REFUND';
      if (needsRefund && !hasPerm(request, 'support.refund.request')) throw ApiError.forbidden('You do not have permission to request a refund.');
      if (!needsRefund && !hasPerm(request, 'support.remediation.request')) throw ApiError.forbidden('You do not have permission to request remediation.');
      return requestRemediation(db, { ticketId: uuid(request.params), type: b.type, reason: b.reason, detail: b.detail, amountMicros: b.amountMicros ?? null, idempotencyKey: b.idempotencyKey ?? null, actor: actorFromRequest(request) });
    });
    async function remediationGate(request: FastifyRequest): Promise<{ refund: boolean }> {
      const id = z.object({ remediationId: z.string().uuid() }).parse(request.params).remediationId;
      const r = await getRemediation(db, id);
      if (!r) throw ApiError.notFound('REMEDIATION_NOT_FOUND', 'Remediation not found.');
      const refund = r.type === 'REFUND';
      const needed = refund ? 'support.refund.approve' : 'support.remediation.approve';
      if (!hasPerm(request, needed)) throw ApiError.forbidden('You do not have permission to act on this remediation.');
      return { refund };
    }
    app.post('/support/remediations/:remediationId/approve', { preHandler: requireAnyPermission('support.remediation.approve', 'support.refund.approve') }, async (request) => {
      await remediationGate(request);
      const id = z.object({ remediationId: z.string().uuid() }).parse(request.params).remediationId;
      return approveRemediation(db, { remediationId: id, actor: actorFromRequest(request) });
    });
    app.post('/support/remediations/:remediationId/deny', { preHandler: requireAnyPermission('support.remediation.approve', 'support.refund.approve') }, async (request) => {
      await remediationGate(request);
      const id = z.object({ remediationId: z.string().uuid() }).parse(request.params).remediationId;
      const b = z.object({ reason: z.string().min(1).max(1000) }).parse(request.body);
      await denyRemediation(db, { remediationId: id, reason: b.reason, actor: actorFromRequest(request) });
      return { ok: true };
    });
    app.post('/support/remediations/:remediationId/execute', { preHandler: requireAnyPermission('support.remediation.approve', 'support.refund.approve') }, async (request) => {
      await remediationGate(request);
      const id = z.object({ remediationId: z.string().uuid() }).parse(request.params).remediationId;
      return executeRemediation(db, { remediationId: id, actor: actorFromRequest(request) });
    });

    // -- attachments ---------------------------------------------------------
    app.post('/support/tickets/:id/attachments', { preHandler: requirePermission('support.respond') }, async (request) => {
      const b = z.object({ filename: z.string().min(1).max(255), contentType: z.string().min(1).max(100), dataBase64: z.string().min(1).max(20_000_000), visibility: z.enum(['CUSTOMER', 'INTERNAL']).optional() }).parse(request.body);
      const bytes = Buffer.from(b.dataBase64, 'base64');
      return createAttachment(db, { ticketId: uuid(request.params), uploaderType: 'STAFF', filename: b.filename, contentType: b.contentType, bytes, visibility: b.visibility ?? 'INTERNAL', actor: actorFromRequest(request) });
    });
    app.get('/support/attachments/:id/download', { preHandler: requirePermission('support.attachments.read') }, async (request, reply) => {
      const id = uuid(request.params);
      const ok = await canAccessAttachment(db, id, { userId: request.user!.id, isStaff: true });
      if (!ok) throw ApiError.notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found.');
      const a = await getAttachment(db, id);
      const blob = a ? await readAttachmentBytes(a.storageKey) : null;
      if (!a || !blob) throw ApiError.notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found.');
      return reply.header('content-disposition', `attachment; filename="${a.filename}"`).type(a.contentType).send(blob.bytes);
    });

    void getTicketRow;
  };
}
