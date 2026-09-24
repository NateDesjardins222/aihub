/**
 * /api/v1/admin/customers — the owner Customer/Commerce console API.
 *
 * SUPPORT reads; ADMIN takes the controlled actions (retry provisioning, require
 * reverification, resolve identity review, place/release hold, resend
 * notification), each requiring a reason and audited by the delegated service.
 * Every read and action is org-scoped. Real work is delegated to the platform
 * services; nothing money- or state-moving happens in the handler.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { requireRole } from '../auth-plugin.js';
import { ApiError } from '../errors.js';
import type { Actor } from '../../platform/actor.js';
import {
  customerDetail,
  disputeQueue,
  exceptionCounts,
  identityReviewQueue,
  notificationFailureQueue,
  orphanedEntitlementQueue,
  provisioningExceptionQueue,
  reconciliation,
  refundReviewQueue,
  searchCustomers,
  unprocessedCommerceEventQueue,
} from '../../platform/owner-customer.js';
import { fulfillPurchaseGated } from '../../platform/commerce-fulfillment.js';
import { requireReverification, ownerDecideReview } from '../../platform/identity-verification.js';
import { setIdentityHold } from '../../platform/customer-identity.js';
import { resendNotification } from '../../platform/notifications.js';

function adminActor(request: { user?: { id: string; email: string } | undefined; ip?: string }): Actor {
  return { type: 'ADMIN', userId: request.user?.id ?? null, label: request.user?.email ?? null, ip: request.ip ?? null };
}

async function orgOf(userId: string): Promise<string> {
  const { db } = getDb();
  const [row] = await db.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, userId));
  return row?.organizationId ?? (await defaultOrganizationId(db));
}

const reasonBody = z.object({ reason: z.string().min(3).max(500) });

export async function customerConsoleRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();

  // -- reads (SUPPORT+) ------------------------------------------------------
  app.get('/customers', { preHandler: requireRole('SUPPORT') }, async (request) => {
    const { q, limit } = z
      .object({ q: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).optional() })
      .parse(request.query ?? {});
    const organizationId = await orgOf(request.user!.id);
    return { customers: await searchCustomers(db, organizationId, q ?? '', limit ?? 50) };
  });

  app.get('/customers/exceptions', { preHandler: requireRole('SUPPORT') }, async (request) => {
    const organizationId = await orgOf(request.user!.id);
    return { counts: await exceptionCounts(db, organizationId) };
  });

  app.get('/customers/reconciliation', { preHandler: requireRole('SUPPORT') }, async (request) => {
    const organizationId = await orgOf(request.user!.id);
    return { reconciliation: await reconciliation(db, organizationId) };
  });

  const queue = (
    path: string,
    fn: (db: ReturnType<typeof getDb>['db'], org: string) => Promise<unknown>,
  ): void => {
    app.get(`/customers/queues/${path}`, { preHandler: requireRole('SUPPORT') }, async (request) => {
      const organizationId = await orgOf(request.user!.id);
      return { rows: await fn(db, organizationId) };
    });
  };
  queue('identity-review', (d, o) => identityReviewQueue(d, o));
  queue('provisioning', (d, o) => provisioningExceptionQueue(d, o));
  queue('commerce-events', (d, o) => unprocessedCommerceEventQueue(d, o));
  queue('disputes', (d, o) => disputeQueue(d, o));
  queue('refunds', (d, o) => refundReviewQueue(d, o));
  queue('notifications', (d, o) => notificationFailureQueue(d, o));
  queue('orphaned-entitlements', (d, o) => orphanedEntitlementQueue(d, o));

  app.get('/customers/:id', { preHandler: requireRole('SUPPORT') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const organizationId = await orgOf(request.user!.id);
    const detail = await customerDetail(db, organizationId, id);
    if (!detail) throw ApiError.notFound('CUSTOMER_NOT_FOUND', 'No such customer in this organization.');
    return detail;
  });

  // -- actions (ADMIN, reason required) --------------------------------------

  app.post(
    '/customers/orders/:id/retry-provisioning',
    { preHandler: requireRole('ADMIN'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      reasonBody.parse(request.body ?? {});
      const result = await fulfillPurchaseGated(db, id, { actor: adminActor(request) });
      return { orderId: id, result };
    },
  );

  app.post(
    '/customers/:id/require-reverification',
    { preHandler: requireRole('ADMIN'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { reason } = reasonBody.parse(request.body ?? {});
      await requireReverification(db, { identityId: id, reason, actor: adminActor(request) });
      return { ok: true };
    },
  );

  app.post(
    '/customers/:id/review-decision',
    { preHandler: requireRole('ADMIN'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { reason, decision } = z
        .object({ reason: z.string().min(3).max(500), decision: z.enum(['IDENTITY_VERIFIED', 'REJECTED']) })
        .parse(request.body ?? {});
      await ownerDecideReview(db, { identityId: id, decision, reason, actor: adminActor(request) });
      return { ok: true };
    },
  );

  app.post(
    '/customers/:id/hold',
    { preHandler: requireRole('ADMIN'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { reason, status } = z
        .object({ reason: z.string().min(3).max(500), status: z.enum(['ACTIVE', 'HOLD', 'CLOSED']) })
        .parse(request.body ?? {});
      await setIdentityHold(db, { identityId: id, status, reason, actor: adminActor(request) });
      return { ok: true };
    },
  );

  app.post(
    '/customers/notifications/:id/resend',
    { preHandler: requireRole('ADMIN'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      reasonBody.parse(request.body ?? {});
      const result = await resendNotification(db, id);
      return result;
    },
  );
}
