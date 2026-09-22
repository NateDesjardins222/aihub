/**
 * /api/v1/checkout and /api/v1/webhooks/whop
 *
 * The two ends of a purchase:
 *
 *   checkout  — a signed-in trader picks a product; Atlas creates a PENDING
 *               commercial order and hands back a Whop checkout link. Atlas
 *               takes NO payment: the card is entered on Whop's surface.
 *   webhook   — Whop, having taken the payment, sends a signed webhook; Atlas
 *               verifies the signature, then fulfils the order into an
 *               evaluation account through the ordinary commerce machinery.
 *
 * The whole path is inert without `WHOP_WEBHOOK_SECRET`: the webhook refuses
 * every request rather than processing an unsigned one, and checkout reports
 * that payments are not configured instead of pretending. Nothing here charges,
 * refunds or pays anyone.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { commercialOrders, users } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { ApiError } from '../errors.js';
import { requireUser } from '../auth-plugin.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { resolveProfileByKey, ProfileError } from '../../platform/profiles.js';
import { CommerceError, createPendingOrder, fulfillOrder } from '../../platform/commerce.js';
import { parseWhopEvent, verifyWhopSignature, whopConfigured } from '../../platform/whop.js';

async function organizationOf(userId: string): Promise<string> {
  const { db } = getDb();
  const [row] = await db
    .select({ organizationId: users.organizationId })
    .from(users)
    .where(eq(users.id, userId));
  return row?.organizationId ?? (await defaultOrganizationId(db));
}

/**
 * Build a Whop hosted-checkout link for a plan, carrying the Atlas order id as
 * metadata so the webhook can map the payment back. Null when checkout is not
 * configured (no base URL, or the product is not sold through Whop).
 */
function whopCheckoutUrl(planId: string | null): { base: string; make: (orderId: string) => string } | null {
  const base = env().WHOP_CHECKOUT_BASE_URL;
  if (!base || !planId) return null;
  const returnUrl = env().WHOP_CHECKOUT_RETURN_URL;
  return {
    base,
    make: (orderId: string) => {
      const url = new URL(`${base.replace(/\/$/, '')}/${planId}`);
      // Whop echoes checkout metadata back on its webhook.
      url.searchParams.set('metadata[atlasOrderId]', orderId);
      if (returnUrl) url.searchParams.set('redirect_url', returnUrl);
      return url.toString();
    },
  };
}

export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();

  app.post(
    '/',
    { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = z.object({ productKey: z.string().min(1).max(60) }).parse(request.body);
      const organizationId = await organizationOf(request.user!.id);

      let product;
      try {
        product = await resolveProfileByKey(db, organizationId, body.productKey);
      } catch (err) {
        if (err instanceof ProfileError) throw new ApiError(404, err.code, err.message);
        throw err;
      }
      // Only an evaluation is sold. A practice account is free; a funded account
      // is earned, not bought.
      if (product.accountType !== 'EVALUATION') {
        throw ApiError.badRequest('PRODUCT_NOT_PURCHASABLE', 'That product is not sold through checkout.');
      }

      const order = await createPendingOrder(db, {
        organizationId,
        userId: request.user!.id,
        productVersionId: product.versionId,
        source: 'PURCHASE',
        externalProvider: 'whop',
        actor: { type: 'USER', userId: request.user!.id, label: request.user!.email, ip: request.ip },
      });

      const link = whopCheckoutUrl(product.config.whopPlanId);
      if (!link) {
        // The order exists and can be fulfilled later (e.g. by an admin grant or
        // once Whop is configured); we simply cannot hand off a payment yet.
        return reply.code(200).send({
          orderId: order.id,
          configured: false,
          message: 'Payments are not configured. The order was created but cannot be paid yet.',
        });
      }
      return reply.code(201).send({
        orderId: order.id,
        configured: true,
        checkoutUrl: link.make(order.id),
        product: { key: product.profileKey, name: product.profileName },
      });
    },
  );
}

export async function whopWebhookRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();

  // This encapsulated instance keeps the RAW body so the HMAC is computed over
  // the exact bytes Whop signed - a re-serialised object would reorder keys and
  // never match. The parent's JSON parser is inherited, so it is removed first;
  // this replacement is scoped to this plugin, so no other route is affected.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as unknown as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body && (body as string).length > 0 ? JSON.parse(body as string) : {});
    } catch {
      done(new ApiError(400, 'INVALID_JSON', 'The webhook body was not valid JSON.'), undefined);
    }
  });

  app.post(
    '/whop',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const secret = env().WHOP_WEBHOOK_SECRET;
      if (!whopConfigured() || !secret) {
        throw new ApiError(503, 'PAYMENTS_NOT_CONFIGURED', 'Whop payments are not configured.');
      }

      const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
      const signature = request.headers['x-whop-signature'] ?? request.headers['whop-signature'];
      if (!verifyWhopSignature(rawBody, signature, secret)) {
        throw ApiError.unauthorized('Invalid webhook signature.');
      }

      const event = parseWhopEvent(request.body);
      // A webhook we understand but that is not a completed payment (a refund, a
      // dispute, a heartbeat) is acknowledged and ignored - never fulfilled.
      if (!event.isPaymentSuccess) {
        return reply.code(200).send({ ok: true, ignored: true, type: event.type });
      }
      if (!event.atlasOrderId) {
        throw ApiError.badRequest('MISSING_ORDER_REFERENCE', 'The payment carried no Atlas order id.');
      }

      const [order] = await db
        .select()
        .from(commercialOrders)
        .where(eq(commercialOrders.id, event.atlasOrderId));
      if (!order) throw ApiError.notFound('ORDER_NOT_FOUND', 'No such order.');

      try {
        const result = await fulfillOrder(db, order.id, {
          externalReference: event.receiptId,
          actor: { type: 'SERVICE', label: 'whop-webhook', ip: request.ip },
        });
        return reply.code(200).send({
          ok: true,
          orderId: result.orderId,
          accountId: result.accountId,
          reused: result.reused,
        });
      } catch (err) {
        if (err instanceof CommerceError) {
          const status = err.code === 'PRODUCT_NOT_FOUND' ? 404 : 409;
          throw new ApiError(status, err.code, err.message);
        }
        throw err;
      }
    },
  );
}
