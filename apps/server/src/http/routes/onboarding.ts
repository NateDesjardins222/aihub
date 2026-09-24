/**
 * /api/v1/onboarding — the customer-facing onboarding surface.
 *
 * Every route acts on the CALLER'S OWN customer identity (requireUser). It drives
 * the same authoritative domain services the owner console and webhooks use, so a
 * customer can complete identity + contact + agreements and reach a satisfied
 * provisioning gate. The dev-only simulate-payment endpoint stands in for the
 * provider webhook in mock mode; it routes a genuinely signed server-side event
 * through the real path, so the browser still cannot provision by itself.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { accountProfiles, users } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { requireUser } from '../auth-plugin.js';
import { ApiError } from '../errors.js';
import type { Actor } from '../../platform/actor.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { resolveProfileByKey } from '../../platform/profiles.js';
import {
  ensureCustomerIdentity,
  getIdentityByUser,
} from '../../platform/customer-identity.js';
import {
  ContactVerificationError,
  confirmContactVerification,
  primaryContactsVerified,
  startContactVerification,
} from '../../platform/contact-verification.js';
import {
  IdentityVerificationError,
  resolveIdentityVerification,
  startIdentityVerification,
} from '../../platform/identity-verification.js';
import {
  acceptAgreements,
  currentAgreementVersions,
  outstandingAgreements,
} from '../../platform/agreements.js';
import { evaluateProvisioningGate } from '../../platform/provisioning-gate.js';
import { simulateProviderPayment } from '../../platform/commerce-fulfillment.js';

function userActor(request: { user?: { id: string; email: string } | undefined; ip?: string }): Actor {
  return { type: 'USER', userId: request.user?.id ?? null, label: request.user?.email ?? null, ip: request.ip ?? null };
}

async function orgOf(userId: string): Promise<string> {
  const { db } = getDb();
  const [row] = await db.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, userId));
  return row?.organizationId ?? (await defaultOrganizationId(db));
}

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();

  // The current onboarding state for the signed-in customer.
  app.get('/state', { preHandler: requireUser }, async (request) => {
    const userId = request.user!.id;
    const organizationId = await orgOf(userId);
    const identity = await ensureCustomerIdentity(db, { organizationId, userId, actor: userActor(request) });
    const contacts = await primaryContactsVerified(db, identity.id);
    const outstanding = await outstandingAgreements(db, organizationId, identity.id);
    const gate = await evaluateProvisioningGate(db, organizationId, userId);
    return {
      identity: {
        id: identity.id,
        identityStatus: identity.identityStatus,
        legalName: identity.legalName,
        country: identity.country,
      },
      contacts,
      outstandingAgreements: outstanding,
      gate,
    };
  });

  app.post(
    '/contact/start',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const body = z.object({ channel: z.enum(['EMAIL', 'SMS']), value: z.string().min(3).max(254) }).parse(request.body);
      const userId = request.user!.id;
      const organizationId = await orgOf(userId);
      const identity = await ensureCustomerIdentity(db, { organizationId, userId, actor: userActor(request) });
      try {
        const result = await startContactVerification(db, {
          identityId: identity.id,
          channel: body.channel,
          value: body.value,
          actor: userActor(request),
        });
        // devCode is present only in non-production; the client surfaces it for
        // local testing and it is never returned in production.
        return { challengeId: result.challengeId, expiresAt: result.expiresAt, devCode: result.devCode ?? null };
      } catch (err) {
        if (err instanceof ContactVerificationError) throw ApiError.badRequest(err.code, err.message);
        throw err;
      }
    },
  );

  app.post(
    '/contact/confirm',
    { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const body = z.object({ challengeId: z.string().uuid(), code: z.string().min(4).max(12) }).parse(request.body);
      try {
        const result = await confirmContactVerification(db, { challengeId: body.challengeId, code: body.code, actor: userActor(request) });
        return result;
      } catch (err) {
        if (err instanceof ContactVerificationError) {
          const status = err.code === 'CHALLENGE_NOT_FOUND' ? 404 : 400;
          throw new ApiError(status, err.code, err.message);
        }
        throw err;
      }
    },
  );

  app.post(
    '/identity/start',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const body = z
        .object({
          legalName: z.string().min(1).max(200),
          dob: z.string().max(20).optional(),
          country: z.string().length(2).optional(),
        })
        .parse(request.body);
      const userId = request.user!.id;
      const organizationId = await orgOf(userId);
      const identity = await ensureCustomerIdentity(db, { organizationId, userId });
      try {
        const result = await startIdentityVerification(db, {
          identityId: identity.id,
          legalName: body.legalName,
          dob: body.dob ?? null,
          country: body.country ?? null,
          email: request.user!.email,
          actor: userActor(request),
        });
        return result;
      } catch (err) {
        if (err instanceof IdentityVerificationError) {
          const status = err.code === 'PROVIDER_UNCONFIGURED' ? 503 : 400;
          throw new ApiError(status, err.code, err.message);
        }
        throw err;
      }
    },
  );

  /*
   * Apply the provider's current decision. In production this is driven by the
   * provider's webhook; the mock provider resolves deterministically, so the
   * onboarding UI calls this to advance the mock verification.
   */
  app.post(
    '/identity/resolve',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = request.user!.id;
      const organizationId = await orgOf(userId);
      const identity = await getIdentityByUser(db, organizationId, userId);
      if (!identity) throw ApiError.notFound('IDENTITY_NOT_FOUND', 'No identity to resolve.');
      try {
        return await resolveIdentityVerification(db, { identityId: identity.id, actor: userActor(request) });
      } catch (err) {
        if (err instanceof IdentityVerificationError) {
          const status = err.code === 'PROVIDER_UNCONFIGURED' ? 503 : err.code === 'NO_VERIFICATION' ? 400 : 400;
          throw new ApiError(status, err.code, err.message);
        }
        throw err;
      }
    },
  );

  app.get('/agreements', { preHandler: requireUser }, async (request) => {
    const userId = request.user!.id;
    const organizationId = await orgOf(userId);
    const identity = await ensureCustomerIdentity(db, { organizationId, userId });
    const current = (await currentAgreementVersions(db, organizationId)).filter((v) => v.isRequired);
    const outstanding = await outstandingAgreements(db, organizationId, identity.id);
    return {
      current: current.map((v) => ({ id: v.id, agreementType: v.agreementType, version: v.version, title: v.title, body: v.body, contentHash: v.contentHash })),
      outstanding,
    };
  });

  app.post(
    '/agreements/accept',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const body = z.object({ versionIds: z.array(z.string().uuid()).min(1).max(20) }).parse(request.body);
      const userId = request.user!.id;
      const organizationId = await orgOf(userId);
      const identity = await ensureCustomerIdentity(db, { organizationId, userId });
      const result = await acceptAgreements(db, {
        organizationId,
        identityId: identity.id,
        userId,
        versionIds: body.versionIds,
        sessionMeta: { ip: request.ip, userAgent: request.headers['user-agent'] ?? null },
        actor: userActor(request),
      });
      return result;
    },
  );

  // The sellable evaluation products (the locked catalog), from immutable config.
  app.get('/products', { preHandler: requireUser }, async (request) => {
    const userId = request.user!.id;
    const organizationId = await orgOf(userId);
    const rows = await db
      .select({ key: accountProfiles.key })
      .from(accountProfiles)
      .where(and(eq(accountProfiles.organizationId, organizationId), eq(accountProfiles.accountType, 'EVALUATION'), eq(accountProfiles.status, 'ACTIVE')));
    const products = [];
    for (const { key } of rows) {
      const resolved = await resolveProfileByKey(db, organizationId, key).catch(() => null);
      const price = resolved?.config.display?.priceMicros;
      if (!resolved || price == null) continue; // only priced, sellable products
      products.push({
        key,
        name: resolved.profileName,
        startingBalanceMicros: resolved.config.display?.startingBalanceMicros ?? null,
        priceMicros: price,
        whopPlanId: resolved.config.whopPlanId,
      });
    }
    products.sort((a, b) => a.priceMicros - b.priceMicros);
    return { products };
  });

  // DEV/MOCK ONLY: stand in for the provider webhook so the mock checkout flow
  // completes. NOT registered in production; the browser still never provisions
  // itself — this routes a signed server-side event through the real path.
  if (env().NODE_ENV !== 'production') {
    app.post(
      '/dev/simulate-payment',
      { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (request) => {
        const body = z.object({ orderId: z.string().uuid() }).parse(request.body);
        const userId = request.user!.id;
        const organizationId = await orgOf(userId);
        // The order must belong to the caller (no cross-customer simulation).
        const result = await simulateProviderPayment(db, {
          organizationId,
          orderId: body.orderId,
          actor: { type: 'SERVICE', label: 'mock-checkout-sim', ip: request.ip },
        });
        return result;
      },
    );
  }
}
