/**
 * Customer portal API — /api/v1/portal/*
 *
 * The trader-facing surface beside Atlas. Every route acts on the CALLER'S OWN
 * accounts and identity (requireUser); ownership is enforced server-side, never
 * inferred from the request body. Presentation-only nicknames and archive flags
 * live here; authoritative balances, statuses and terms come from the platform
 * services. Trading itself, and payouts, keep their own routes — the portal reads
 * them, it does not re-implement them.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { accounts, customerIdentities, users } from '../../db/schema.js';
import { ApiError } from '../errors.js';
import { requireUser } from '../auth-plugin.js';
import {
  archiveAccount,
  listPortalAccounts,
  portalAccountDetail,
  setAccountNickname,
  unarchiveAccount,
  PortalAccountError,
} from '../../platform/portal-accounts.js';
import { accountAnalytics } from '../../platform/analytics.js';
import { createResetOrder, resetQuote, ResetError } from '../../platform/account-reset.js';
import { listCertificatesForUser } from '../../platform/certificates.js';
import {
  listAchievementsForUser,
  setAchievementsPublic,
  setAchievementVisibility,
} from '../../platform/achievements.js';
import { ensureCustomerIdentity } from '../../platform/customer-identity.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';

function mapPortalError(err: unknown): never {
  if (err instanceof PortalAccountError) {
    if (err.code === 'ACCOUNT_NOT_FOUND') throw ApiError.notFound(err.code, err.message);
    throw ApiError.badRequest(err.code, err.message);
  }
  if (err instanceof ResetError) {
    if (err.code === 'ACCOUNT_NOT_FOUND') throw ApiError.notFound(err.code, err.message);
    throw ApiError.badRequest(err.code, err.message);
  }
  throw err;
}

/** Confirm the account belongs to the caller; returns its organizationId. */
async function assertOwned(db: ReturnType<typeof getDb>['db'], userId: string, accountId: string): Promise<string> {
  const [row] = await db
    .select({ userId: accounts.userId, organizationId: accounts.organizationId })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!row || row.userId !== userId) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
  return row.organizationId ?? (await defaultOrganizationId(db));
}

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();
  app.addHook('preHandler', requireUser);

  // ---- Accounts -----------------------------------------------------------
  app.get<{ Querystring: { includeArchived?: string } }>('/accounts', async (request, reply) => {
    const includeArchived = request.query.includeArchived === 'true';
    const view = await listPortalAccounts(db, request.user!.id, { includeArchived });
    return reply.send(view);
  });

  app.get<{ Params: { id: string } }>('/accounts/:id', async (request, reply) => {
    try {
      return reply.send(await portalAccountDetail(db, request.user!.id, request.params.id));
    } catch (err) {
      mapPortalError(err);
    }
  });

  app.patch<{ Params: { id: string }; Body: { nickname: string | null } }>(
    '/accounts/:id/nickname',
    async (request, reply) => {
      try {
        const result = await setAccountNickname(db, request.user!.id, request.params.id, request.body?.nickname ?? null);
        return reply.send(result);
      } catch (err) {
        mapPortalError(err);
      }
    },
  );

  app.post<{ Params: { id: string } }>('/accounts/:id/archive', async (request, reply) => {
    try {
      await archiveAccount(db, request.user!.id, request.params.id, { actor: { type: 'USER', userId: request.user!.id, label: request.user!.email } });
      return reply.send({ ok: true });
    } catch (err) {
      mapPortalError(err);
    }
  });

  app.post<{ Params: { id: string } }>('/accounts/:id/unarchive', async (request, reply) => {
    try {
      await unarchiveAccount(db, request.user!.id, request.params.id, { actor: { type: 'USER', userId: request.user!.id, label: request.user!.email } });
      return reply.send({ ok: true });
    } catch (err) {
      mapPortalError(err);
    }
  });

  // ---- Analytics (deep) ---------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; instrument?: string; side?: string } }>(
    '/accounts/:id/analytics',
    async (request, reply) => {
      await assertOwned(db, request.user!.id, request.params.id);
      const side = request.query.side === 'LONG' || request.query.side === 'SHORT' ? request.query.side : null;
      const analytics = await accountAnalytics(db, request.params.id, {
        fromDate: request.query.from ?? null,
        toDate: request.query.to ?? null,
        instrument: request.query.instrument ?? null,
        side,
      });
      if (!analytics) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
      return reply.send(analytics);
    },
  );

  // ---- Reset (re-purchase a failed evaluation) ----------------------------
  app.get<{ Params: { id: string } }>('/accounts/:id/reset-quote', async (request, reply) => {
    try {
      return reply.send(await resetQuote(db, request.user!.id, request.params.id));
    } catch (err) {
      mapPortalError(err);
    }
  });

  app.post<{ Params: { id: string } }>(
    '/accounts/:id/reset',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const organizationId = await assertOwned(db, request.user!.id, request.params.id);
        const order = await createResetOrder(db, {
          organizationId,
          userId: request.user!.id,
          failedAccountId: request.params.id,
          actor: { type: 'USER', userId: request.user!.id, label: request.user!.email },
        });
        // The trader pays this order through the existing checkout surface; a
        // verified server-side payment event then provisions the replacement.
        return reply.send(order);
      } catch (err) {
        mapPortalError(err);
      }
    },
  );

  // ---- Atlas handoff ------------------------------------------------------
  app.get<{ Params: { id: string } }>('/accounts/:id/handoff', async (request, reply) => {
    const [row] = await db
      .select({ userId: accounts.userId, publicId: accounts.publicId, status: accounts.status, accountType: accounts.accountType })
      .from(accounts)
      .where(eq(accounts.id, request.params.id));
    if (!row || row.userId !== request.user!.id) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
    // The terminal opens on an account by its public id; the portal deep-links.
    return reply.send({ publicId: row.publicId, terminalPath: `/?account=${row.publicId}`, tradable: row.status === 'ACTIVE' });
  });

  // ---- Certificates -------------------------------------------------------
  app.get('/certificates', async (request, reply) => {
    return reply.send({ certificates: await listCertificatesForUser(db, request.user!.id) });
  });

  // ---- Achievements -------------------------------------------------------
  app.get('/achievements', async (request, reply) => {
    return reply.send(await listAchievementsForUser(db, request.user!.id));
  });

  app.patch<{ Body: { isPublic: boolean } }>('/achievements/visibility', async (request, reply) => {
    // Ensure the identity spine exists so the toggle persists for a trader who
    // has not been through onboarding yet.
    const organizationId = await defaultOrganizationId(db);
    await ensureCustomerIdentity(db, { organizationId, userId: request.user!.id });
    await setAchievementsPublic(db, request.user!.id, request.body?.isPublic === true);
    return reply.send({ ok: true });
  });

  app.patch<{ Params: { id: string }; Body: { isPublic: boolean } }>(
    '/achievements/:id/visibility',
    async (request, reply) => {
      await setAchievementVisibility(db, request.user!.id, request.params.id, request.body?.isPublic === true);
      return reply.send({ ok: true });
    },
  );

  // ---- Profile (public display identity, presentation-only) ---------------
  app.get('/profile', async (request, reply) => {
    const [ident] = await db
      .select({ preferredDisplayName: customerIdentities.preferredDisplayName, achievementsPublic: customerIdentities.achievementsPublic })
      .from(customerIdentities)
      .where(eq(customerIdentities.userId, request.user!.id));
    const [user] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, request.user!.id));
    return reply.send({
      preferredDisplayName: ident?.preferredDisplayName ?? null,
      achievementsPublic: ident?.achievementsPublic ?? false,
      displayName: user?.displayName ?? null,
    });
  });

  app.patch<{ Body: { preferredDisplayName: string | null } }>('/profile', async (request, reply) => {
    const raw = request.body?.preferredDisplayName;
    const value = typeof raw === 'string' ? raw.trim().slice(0, 80) : null;
    // A public display name is presentation-only and must never carry an email.
    if (value && value.includes('@')) throw ApiError.badRequest('INVALID_DISPLAY_NAME', 'A public display name cannot contain an email address.');
    const organizationId = await defaultOrganizationId(db);
    await ensureCustomerIdentity(db, { organizationId, userId: request.user!.id });
    await db
      .update(customerIdentities)
      .set({ preferredDisplayName: value && value.length > 0 ? value : null })
      .where(eq(customerIdentities.userId, request.user!.id));
    return reply.send({ preferredDisplayName: value && value.length > 0 ? value : null });
  });
}
