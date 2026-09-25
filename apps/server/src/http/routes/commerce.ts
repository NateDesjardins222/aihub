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
import { CommerceError, createPendingOrder, markOrderCompleted } from '../../platform/commerce.js';
import { holdBlocking } from '../../platform/enforcement-holds.js';
import { identityIdForUser } from '../../platform/enforcement.js';
import { WhopApiError, whopClientFromEnv, type WhopClient } from '../../platform/whop-client.js';
import {
  MockCommerceProvider,
  WhopCommerceProvider,
  type CommerceProvider,
  type RawCommerceEvent,
} from '../../platform/commerce-provider.js';
import {
  markCommerceEventFailed,
  markCommerceEventIgnored,
  markCommerceEventProcessed,
  markCommerceEventRejected,
  recordCommerceEvent,
} from '../../platform/commerce-events.js';
import { fulfillPurchaseGated, orderAccountId } from '../../platform/commerce-fulfillment.js';
import { handleDispute, handleRefund } from '../../platform/commerce-refund.js';

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

        // Firm enforcement hold (M7): block a purchase pre-checkout when the
        // customer is under a PURCHASE hold, so we never take payment we would
        // then have to unwind.
        const purchaseIdentityId = await identityIdForUser(db, request.user!.id);
        if (purchaseIdentityId && (await holdBlocking(db, { customerIdentityId: purchaseIdentityId }, 'PURCHASE'))) {
          throw ApiError.badRequest('ENFORCEMENT_HOLD', 'Purchasing is temporarily unavailable on your account while a review is in progress.');
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

/**
 * The shared, provider-neutral webhook handler. It NEVER trusts the browser: the
 * only way to authorise entitlement/provisioning is a signature-verified,
 * server-side commerce event routed through here. Every event is recorded and
 * deduped in `commerce_events` before any provisioning work, so a replay is
 * harmless; a bad signature is a 401 and the order is untouched.
 */
async function handleCommerceWebhook(
  db: ReturnType<typeof getDb>['db'],
  provider: CommerceProvider,
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
): Promise<unknown> {
  if (!provider.isConfigured()) {
    throw new ApiError(503, 'PAYMENTS_NOT_CONFIGURED', `${provider.name} payments are not configured.`);
  }
  const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
  const raw: RawCommerceEvent = { rawBody, headers: request.headers };
  const organizationId = await defaultOrganizationId(db);
  const actor = { type: 'SERVICE' as const, label: `${provider.name.toLowerCase()}-webhook`, ip: request.ip };

  const outcome = await recordCommerceEvent(db, { organizationId, provider, raw, actor });

  // A bad signature or stale timestamp: recorded REJECTED, and a 401. The order
  // (if any) is never touched.
  if (outcome.kind === 'REJECTED') {
    throw ApiError.unauthorized(`Invalid webhook signature: ${outcome.reason}.`);
  }

  // A replay/duplicate: the work already happened (or is in flight). Ack 200 and
  // return the already-provisioned account when we can resolve it — idempotent.
  if (outcome.kind === 'DUPLICATE') {
    const n = provider.normalizeEvent(raw);
    const accountId = n.atlasOrderId ? await orderAccountId(db, n.atlasOrderId).catch(() => null) : null;
    return reply.code(200).send({ ok: true, duplicate: true, orderId: n.atlasOrderId, accountId });
  }

  const n = outcome.normalized;
  const eventId = outcome.row.id;

  const loadOrder = async (id: string | null) => {
    if (!id) return null;
    const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, id));
    return order ?? null;
  };

  switch (n.kind) {
    case 'PAYMENT_SUCCEEDED': {
      if (!n.atlasOrderId) {
        await markCommerceEventRejected(db, eventId, 'UNKNOWN_ORDER');
        throw ApiError.badRequest('MISSING_ORDER_REFERENCE', 'The payment carried no Atlas order id.');
      }
      const order = await loadOrder(n.atlasOrderId);
      if (!order) {
        await markCommerceEventRejected(db, eventId, 'UNKNOWN_ORDER');
        throw ApiError.notFound('ORDER_NOT_FOUND', 'No such order.');
      }
      try {
        // Money success is recorded first (durable), then provisioning is gated —
        // so a blocked purchase parks recoverably rather than being lost.
        await markOrderCompleted(db, order.id, { externalReference: n.receiptId, actor });
        const result = await fulfillPurchaseGated(db, order.id, { actor });
        await markCommerceEventProcessed(db, eventId, { atlasOrderId: order.id });
        if (result.status === 'PROVISIONED') {
          return reply.code(200).send({ ok: true, status: result.status, orderId: order.id, accountId: result.accountId, reused: result.reused });
        }
        // Blocked/failed: money kept, provisioning deferred. NOT an HTTP error —
        // the payment was accepted; the customer/owner see the recoverable state.
        return reply.code(200).send({
          ok: true,
          status: result.status,
          orderId: order.id,
          ...(result.status === 'PROVISION_BLOCKED' ? { blockedReasons: result.blockedReasons } : {}),
        });
      } catch (err) {
        await markCommerceEventFailed(db, eventId, String(err), { atlasOrderId: order.id });
        if (err instanceof CommerceError) {
          const status = err.code === 'PRODUCT_NOT_FOUND' ? 404 : 409;
          throw new ApiError(status, err.code, err.message);
        }
        throw err;
      }
    }
    case 'REFUND': {
      const order = await loadOrder(n.atlasOrderId);
      if (!order) {
        await markCommerceEventIgnored(db, eventId);
        return reply.code(200).send({ ok: true, ignored: true, kind: n.kind });
      }
      await handleRefund(db, { order, actor });
      await markCommerceEventProcessed(db, eventId, { atlasOrderId: order.id });
      return reply.code(200).send({ ok: true, status: 'REFUNDED', orderId: order.id });
    }
    case 'DISPUTE_OPENED':
    case 'DISPUTE_CLOSED': {
      const order = await loadOrder(n.atlasOrderId);
      if (!order) {
        await markCommerceEventIgnored(db, eventId);
        return reply.code(200).send({ ok: true, ignored: true, kind: n.kind });
      }
      await handleDispute(db, { order, opened: n.kind === 'DISPUTE_OPENED', actor });
      await markCommerceEventProcessed(db, eventId, { atlasOrderId: order.id });
      return reply.code(200).send({ ok: true, status: n.kind, orderId: order.id });
    }
    default: {
      // A non-payment event we do not act on (payment.failed, heartbeat, unknown).
      await markCommerceEventIgnored(db, eventId);
      return reply.code(200).send({ ok: true, ignored: true, kind: n.kind });
    }
  }
}

/** Install a raw-body JSON parser scoped to a webhook plugin. */
function useRawBody(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as unknown as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body && (body as string).length > 0 ? JSON.parse(body as string) : {});
    } catch {
      done(new ApiError(400, 'INVALID_JSON', 'The webhook body was not valid JSON.'), undefined);
    }
  });
}

/**
 * The ONLY source the onboarding "Account Ready" screen trusts: the server's own
 * view of the order. The browser polls this after checkout; it never infers
 * readiness from a checkout success callback. IDOR-guarded to the order's owner.
 */
export async function commerceStatusRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();
  app.get(
    '/orders/:id/status',
    { preHandler: requireUser, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, id));
      if (!order || order.userId !== request.user!.id) {
        throw ApiError.notFound('ORDER_NOT_FOUND', 'No such order.');
      }
      const accountId = order.status === 'PROVISIONED' ? await orderAccountId(db, order.id) : null;
      return reply.send({
        orderId: order.id,
        status: order.status, // PENDING｜COMPLETED｜PROVISIONED｜PROVISION_BLOCKED｜PROVISION_FAILED｜REFUNDED
        accountId,
        provisionNote: order.provisionNote ?? null,
      });
    },
  );
}

export async function whopWebhookRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();
  useRawBody(app);
  const provider = new WhopCommerceProvider();

  app.post(
    '/whop',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    (request, reply) => handleCommerceWebhook(db, provider, request, reply),
  );

  // A MOCK server-side event endpoint, NON-PRODUCTION ONLY, so the browser
  // acceptance harness and tests can post a genuinely signature-verified event
  // (with the mock secret) — proving provisioning happens only from a verified
  // server-side event, never from a browser success screen. It is not a real
  // money path and never active in production.
  if (env().NODE_ENV !== 'production') {
    const mock = new MockCommerceProvider();
    app.post(
      '/mock',
      { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
      (request, reply) => handleCommerceWebhook(db, mock, request, reply),
    );
  }
}
