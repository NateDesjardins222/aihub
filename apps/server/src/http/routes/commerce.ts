/**
 * /api/v1/checkout and /api/v1/webhooks/whop
 *
 * The two ends of a purchase:
 *
 *   checkout — a signed-in trader picks a product; Atlas creates a PENDING
 *              commercial order, asks Whop (sandbox) for a checkout SESSION that
 *              carries the Atlas order id as metadata, and returns the session
 *              id for the EMBEDDED checkout to render. Atlas takes no payment;
 *              the card is entered inside Whop's embedded iframe, never here.
 *   webhook  — Whop, having taken the (sandbox) payment, sends a Standard
 *              Webhooks-signed event; Atlas verifies the signature over the raw
 *              body, then fulfils the order into an evaluation account through
 *              the one authoritative commerce path.
 *
 * The whole path is inert without `WHOP_WEBHOOK_SECRET` and `WHOP_SANDBOX=true`:
 * the webhook refuses every request, and checkout reports not-configured rather
 * than pretending. Nothing here charges, refunds or pays anyone, and there is
 * no production Whop host in the build.
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
import { parseWhopEvent, verifyStandardWebhook, whopConfigured } from '../../platform/whop.js';
import { WhopApiError, whopClientFromEnv, type WhopClient } from '../../platform/whop-client.js';

async function organizationOf(userId: string): Promise<string> {
  const { db } = getDb();
  const [row] = await db
    .select({ organizationId: users.organizationId })
    .from(users)
    .where(eq(users.id, userId));
  return row?.organizationId ?? (await defaultOrganizationId(db));
}

export function checkoutRoutes(deps: { whopClient?: () => WhopClient | null } = {}) {
  const resolveClient = deps.whopClient ?? whopClientFromEnv;

  return async function register(app: FastifyInstance): Promise<void> {
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
        // Only an evaluation is sold. A practice account is free; a funded
        // account is earned, not bought.
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

        const client = resolveClient();
        const planId = product.config.whopPlanId;
        // Not set up yet: the order exists and can be fulfilled later (an admin
        // grant, or once the sandbox is configured), but no session can be made.
        if (!client || !planId) {
          return reply.code(200).send({
            orderId: order.id,
            configured: false,
            message: 'Checkout is not configured (needs WHOP_SANDBOX, a company API key, and a product whopPlanId).',
          });
        }

        try {
          const session = await client.createCheckoutSession({
            planId,
            metadata: { atlasOrderId: order.id },
            redirectUrl: env().WHOP_CHECKOUT_RETURN_URL ?? null,
          });
          // Record the session on the order for traceability; the webhook maps
          // back by metadata, not by this, so it is informational.
          await db
            .update(commercialOrders)
            .set({ externalReference: session.id })
            .where(eq(commercialOrders.id, order.id));
          return reply.code(201).send({
            orderId: order.id,
            configured: true,
            environment: client.environment, // 'sandbox'
            sessionId: session.id,
            planId: session.planId,
            returnUrl: env().WHOP_CHECKOUT_RETURN_URL ?? null,
            product: { key: product.profileKey, name: product.profileName },
          });
        } catch (err) {
          if (err instanceof WhopApiError) {
            throw new ApiError(502, 'CHECKOUT_SESSION_FAILED', 'Could not start checkout with the provider.');
          }
          throw err;
        }
      },
    );
  };
}

export async function whopWebhookRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();

  // This encapsulated instance keeps the RAW body so the Standard Webhooks HMAC
  // is computed over the exact bytes Whop signed - a re-serialised object would
  // reorder keys and never match. The parent's JSON parser is inherited, so it
  // is removed first; this replacement is scoped to this plugin.
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
      const verification = verifyStandardWebhook(rawBody, request.headers, secret);
      if (!verification.ok) {
        throw ApiError.unauthorized(`Invalid webhook signature: ${verification.reason}.`);
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
