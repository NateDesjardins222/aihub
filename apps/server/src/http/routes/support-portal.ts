/**
 * Customer Support Center routes (Milestone 12). Mounted at /api/v1/support.
 * Authenticated; every route is scoped to the caller's OWN tickets. A customer
 * never sees internal notes, staff-only attachments, or another customer's ticket.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { requireUser } from '../auth-plugin.js';
import { ApiError } from '../errors.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import type { Actor } from '../../platform/actor.js';
import { getSupportConfig, listCategories } from '../../platform/support-config.js';
import {
  addMessage, findRecentDuplicate, getTicketRow, listCustomerTickets, reopenTicket, submitCsat, submitTicket,
} from '../../platform/support-tickets.js';
import { customerTicketView } from '../../platform/support-inbox.js';
import { linkObject } from '../../platform/support-links.js';
import { canAccessAttachment, createAttachment, getAttachment, readAttachmentBytes, signDownloadToken, verifyDownloadToken } from '../../platform/support-attachments.js';
import { customerIdentities, supportKbArticles } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';

function customerActor(request: { user?: { id: string; email?: string } | null; ip?: string }): Actor {
  return { type: 'USER', userId: request.user!.id, label: request.user!.email ?? null, ip: request.ip };
}

export function supportPortalRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    async function ownTicketOr404(userId: string, ticketId: string) {
      const t = await getTicketRow(db, ticketId);
      if (!t || t.customerUserId !== userId) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support request not found.');
      return t;
    }

    app.get('/categories', async () => {
      const org = await defaultOrganizationId(db);
      const cats = await listCategories(db, org);
      return { categories: cats.map((c) => ({ key: c.key, parentKey: c.parentKey, label: c.label })) };
    });

    app.get('/kb', async () => {
      const org = await defaultOrganizationId(db);
      const rows = await db.select({ slug: supportKbArticles.slug, title: supportKbArticles.title, category: supportKbArticles.category, body: supportKbArticles.body }).from(supportKbArticles).where(and(eq(supportKbArticles.organizationId, org), eq(supportKbArticles.published, true))).orderBy(supportKbArticles.sortOrder);
      return { articles: rows };
    });

    app.get('/me/tickets', async (request) => {
      const org = await defaultOrganizationId(db);
      return { tickets: await listCustomerTickets(db, org, request.user!.id) };
    });

    app.post('/duplicate-check', async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({ categoryKey: z.string(), subcategoryKey: z.string().nullable().optional() }).parse(request.body);
      const dup = await findRecentDuplicate(db, org, request.user!.id, b.categoryKey, b.subcategoryKey ?? null);
      return { duplicate: dup };
    });

    // Create a ticket (rate-limited against spam; authoritative priority is staff-set).
    app.post('/tickets', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({
        categoryKey: z.string().min(1).max(48),
        subcategoryKey: z.string().max(48).nullable().optional(),
        subject: z.string().min(3).max(200),
        body: z.string().min(1).max(8000),
        customerUrgency: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).nullable().optional(),
        links: z.array(z.object({ objectType: z.string().max(40), objectId: z.string().max(128) })).max(10).optional(),
        idempotencyKey: z.string().max(80).nullable().optional(),
      }).parse(request.body);
      const [ident] = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(eq(customerIdentities.userId, request.user!.id));
      const actor = customerActor(request);
      const res = await submitTicket(db, {
        organizationId: org, customerUserId: request.user!.id, customerIdentityId: ident?.id ?? null,
        categoryKey: b.categoryKey, subcategoryKey: b.subcategoryKey ?? null, subject: b.subject, body: b.body,
        customerUrgency: b.customerUrgency ?? null, idempotencyKey: b.idempotencyKey ?? null, actor,
      });
      // Auto-link any customer-selected objects, with ownership enforced.
      for (const l of b.links ?? []) {
        await linkObject(db, { ticketId: res.id, objectType: l.objectType, objectId: l.objectId, actor, auto: true, enforceOwnership: true, customerUserId: request.user!.id }).catch(() => undefined);
      }
      return reply.code(201).send(res);
    });

    app.get('/tickets/:id', async (request) => {
      const org = await defaultOrganizationId(db);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const view = await customerTicketView(db, org, request.user!.id, id);
      if (!view) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support request not found.');
      return view;
    });

    app.post('/tickets/:id/messages', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ body: z.string().min(1).max(8000), idempotencyKey: z.string().max(80).nullable().optional() }).parse(request.body);
      await ownTicketOr404(request.user!.id, id);
      const res = await addMessage(db, { ticketId: id, senderType: 'CUSTOMER', visibility: 'CUSTOMER', body: b.body, idempotencyKey: b.idempotencyKey ?? null, actor: customerActor(request) });
      return { id: res.id };
    });

    app.post('/tickets/:id/reopen', async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ reason: z.string().max(1000).optional() }).parse(request.body ?? {});
      await ownTicketOr404(request.user!.id, id);
      await reopenTicket(db, { ticketId: id, actor: customerActor(request), reason: b.reason ?? 'customer reopened', byCustomer: true });
      return { ok: true };
    });

    app.post('/tickets/:id/csat', async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }).parse(request.body);
      await submitCsat(db, { ticketId: id, customerUserId: request.user!.id, rating: b.rating, comment: b.comment });
      return { ok: true };
    });

    // Attachments: base64 payload (keeps the stack simple; a real object store sits
    // behind the storage seam). Type/size validation + executable rejection in the domain.
    app.post('/tickets/:id/attachments', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ filename: z.string().min(1).max(255), contentType: z.string().min(1).max(100), dataBase64: z.string().min(1).max(20_000_000) }).parse(request.body);
      await ownTicketOr404(request.user!.id, id);
      const bytes = Buffer.from(b.dataBase64, 'base64');
      const res = await createAttachment(db, { ticketId: id, uploaderType: 'CUSTOMER', filename: b.filename, contentType: b.contentType, bytes, visibility: 'CUSTOMER', actor: customerActor(request) });
      return { id: res.id, downloadToken: signDownloadToken(res.id) };
    });

    app.get('/attachments/:id/download', async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const q = z.object({ token: z.string().optional() }).parse(request.query ?? {});
      if (!q.token || !verifyDownloadToken(id, q.token)) throw ApiError.forbidden('Invalid or expired download link.');
      const ok = await canAccessAttachment(db, id, { userId: request.user!.id, isStaff: false });
      if (!ok) throw ApiError.forbidden('Not permitted.');
      const a = await getAttachment(db, id);
      const blob = a ? await readAttachmentBytes(a.storageKey) : null;
      if (!a || !blob) throw ApiError.notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found.');
      return reply.header('content-disposition', `attachment; filename="${a.filename}"`).type(a.contentType).send(blob.bytes);
    });

    app.get('/config', async () => {
      const org = await defaultOrganizationId(db);
      const cfg = await getSupportConfig(db, org);
      return { reopenWindowDays: cfg.settings.reopenWindowDays, maxAttachmentBytes: cfg.settings.maxAttachmentBytes, allowedAttachmentTypes: cfg.settings.allowedAttachmentTypes, csatEnabled: cfg.settings.csatEnabled };
    });
  };
}
