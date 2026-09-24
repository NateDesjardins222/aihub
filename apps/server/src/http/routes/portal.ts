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
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { accounts, customerIdentities, trades, users } from '../../db/schema.js';
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
import { listCertificatesForUser, ownedCertificateArtifact, validateCertificateDisplayName } from '../../platform/certificates.js';
import { objectStore } from '../../platform/object-store.js';
import {
  createPhysicalCertificateOrder,
  confirmPhysicalCertificatePayment,
  listPhysicalOrdersForUser,
  getPhysicalOrderForUser,
  PhysicalOrderError,
  PHYSICAL_RETAIL_MICROS,
  PHYSICAL_SKU,
} from '../../platform/physical-orders.js';
import { env } from '../../config/env.js';
import {
  listAchievementsForUser,
  setAchievementsPublic,
  setAchievementVisibility,
} from '../../platform/achievements.js';
import { ensureCustomerIdentity } from '../../platform/customer-identity.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import {
  getPersonalRiskProfile,
  upsertPersonalControl,
  PersonalControlError,
} from '../../platform/personal-risk.js';
import type { PersonalControlMode, PersonalControlType, PersonalControlValue } from '@atlas/contracts';
import { PERSONAL_CONTROL_TYPES } from '@atlas/contracts';

function mapPortalError(err: unknown): never {
  if (err instanceof PortalAccountError) {
    if (err.code === 'ACCOUNT_NOT_FOUND') throw ApiError.notFound(err.code, err.message);
    throw ApiError.badRequest(err.code, err.message);
  }
  if (err instanceof ResetError) {
    if (err.code === 'ACCOUNT_NOT_FOUND') throw ApiError.notFound(err.code, err.message);
    throw ApiError.badRequest(err.code, err.message);
  }
  if (err instanceof PersonalControlError) {
    if (err.code === 'ACCOUNT_NOT_FOUND') throw ApiError.notFound(err.code, err.message);
    if (err.code === 'STALE_VERSION') throw ApiError.conflict(err.code, err.message);
    throw ApiError.badRequest(err.code, err.message, err.detail);
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

  // Individual round-trip trades, for the equity-curve → day → trade drilldown.
  // Owner-scoped; a date range narrows to one day when from === to.
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/accounts/:id/trades',
    async (request, reply) => {
      await assertOwned(db, request.user!.id, request.params.id);
      const conds = [eq(trades.accountId, request.params.id)];
      if (request.query.from) conds.push(gte(trades.tradeDate, request.query.from));
      if (request.query.to) conds.push(lte(trades.tradeDate, request.query.to));
      const rows = await db
        .select({
          id: trades.id, symbol: trades.symbol, contractCode: trades.contractCode, side: trades.side, qty: trades.qty,
          entryTime: trades.entryTime, exitTime: trades.exitTime, grossPnlMicros: trades.grossPnlMicros,
          feesMicros: trades.feesMicros, netPnlMicros: trades.netPnlMicros, tradeDate: trades.tradeDate,
        })
        .from(trades)
        .where(and(...conds))
        .orderBy(desc(trades.exitTime))
        .limit(500);
      return reply.send({
        trades: rows.map((r) => ({
          id: r.id, symbol: r.symbol, contractCode: r.contractCode, side: r.side, qty: r.qty,
          entryTimeMs: r.entryTime ? r.entryTime.getTime() : null,
          exitTimeMs: r.exitTime ? r.exitTime.getTime() : null,
          grossPnlMicros: r.grossPnlMicros, feesMicros: r.feesMicros, netPnlMicros: r.netPnlMicros, tradeDate: r.tradeDate,
        })),
      });
    },
  );

  // ---- Personal risk controls (Milestone 5) -------------------------------
  // Read the account's personal controls + live server-derived usage. The
  // browser renders this; it never enforces or computes risk.
  app.get<{ Params: { id: string } }>('/accounts/:id/controls', async (request, reply) => {
    await assertOwned(db, request.user!.id, request.params.id);
    try {
      return reply.send(await getPersonalRiskProfile(db, request.params.id));
    } catch (err) {
      mapPortalError(err);
    }
  });

  // Create or update one control. Server-authoritative: validation, locked-mode
  // (tighten-only until the next trading day) and concurrency are enforced here,
  // never trusting the client. Ownership is resolved from the caller's session.
  app.put<{
    Params: { id: string; controlType: string };
    Body: {
      enabled?: boolean;
      mode?: PersonalControlMode;
      value?: PersonalControlValue;
      expectedVersion?: number;
    };
  }>(
    '/accounts/:id/controls/:controlType',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      await assertOwned(db, request.user!.id, request.params.id);
      const controlType = request.params.controlType as PersonalControlType;
      if (!PERSONAL_CONTROL_TYPES.includes(controlType)) {
        throw ApiError.badRequest('UNKNOWN_CONTROL', 'Unknown control.');
      }
      const mode: PersonalControlMode = request.body?.mode === 'LOCKED' ? 'LOCKED' : 'FLEXIBLE';
      try {
        const view = await upsertPersonalControl(db, {
          accountId: request.params.id,
          ownerUserId: request.user!.id,
          actorUserId: request.user!.id,
          source: 'TRADER',
          controlType,
          enabled: request.body?.enabled === true,
          mode,
          value: request.body?.value ?? {},
          expectedVersion: request.body?.expectedVersion,
        });
        return reply.send(view);
      } catch (err) {
        mapPortalError(err);
      }
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

  // Owner-scoped artifact download. A certificate the caller does not own (or an
  // unrendered one) returns 404 — no IDOR, no enumeration beyond found/not-found.
  const artifactRoute = (kind: 'image' | 'pdf') =>
    app.get<{ Params: { id: string } }>(`/certificates/:id/${kind}`, async (request, reply) => {
      const found = await ownedCertificateArtifact(db, request.user!.id, request.params.id, kind);
      if (!found) throw ApiError.notFound('CERTIFICATE_NOT_FOUND', 'No such certificate artifact.');
      const obj = await objectStore().get(found.storageKey);
      if (!obj) throw ApiError.notFound('ARTIFACT_NOT_FOUND', 'The artifact is not available.');
      return reply
        .header('content-type', found.contentType)
        .header('content-disposition', `attachment; filename="${found.filename}"`)
        .header('cache-control', 'private, max-age=0, no-store')
        .send(obj.data);
    });
  artifactRoute('image');
  artifactRoute('pdf');

  // ---- Physical framed certificate commerce (Milestone 6) -----------------
  const mapPhysicalError = (err: unknown): never => {
    if (err instanceof PhysicalOrderError) {
      const status = err.code === 'CERTIFICATE_NOT_FOUND' || err.code === 'ORDER_NOT_FOUND' ? 404 : err.code === 'MERCH_DISABLED' ? 403 : 400;
      throw new ApiError(status, err.code, err.message);
    }
    throw err;
  };

  // Product descriptor for the "Order Framed Copy" surface.
  app.get('/merch/framed-certificate', async (_request, reply) =>
    reply.send({ enabled: env().MERCH_ENABLED, sku: PHYSICAL_SKU, retailAmountMicros: PHYSICAL_RETAIL_MICROS, currency: 'USD', size: '11x14' }),
  );

  app.post<{ Params: { id: string }; Body: { address?: unknown; idempotencyKey?: string } }>(
    '/certificates/:id/order-framed',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!env().MERCH_ENABLED) throw new ApiError(403, 'MERCH_DISABLED', 'Framed certificate ordering is not enabled.');
      try {
        const order = await createPhysicalCertificateOrder(db, {
          userId: request.user!.id,
          certificateId: request.params.id,
          address: request.body?.address,
          idempotencyKey: request.body?.idempotencyKey ?? null,
        });
        // Production wires a Whop merch checkout here; this build returns the
        // order so a signature-verified payment event (or the non-prod simulate
        // route) confirms it. A browser success never fulfills.
        return reply.code(201).send({ orderId: order.id, status: order.status, retailAmountMicros: order.retailAmountMicros, sku: order.sku });
      } catch (err) {
        return mapPhysicalError(err);
      }
    },
  );

  app.get('/physical-orders', async (request, reply) =>
    reply.send({ orders: await listPhysicalOrdersForUser(db, request.user!.id) }),
  );

  app.get<{ Params: { id: string } }>('/physical-orders/:id', async (request, reply) => {
    const order = await getPhysicalOrderForUser(db, request.user!.id, request.params.id);
    if (!order) throw ApiError.notFound('ORDER_NOT_FOUND', 'No such order.');
    return reply.send(order);
  });

  // Non-production only: stand in for a signature-verified merch payment webhook
  // so the dev/test flow can confirm payment → preflight → submit.
  if (env().NODE_ENV !== 'production') {
    app.post<{ Params: { id: string } }>('/physical-orders/:id/dev/simulate-payment', async (request, reply) => {
      // Must belong to the caller.
      const owned = await getPhysicalOrderForUser(db, request.user!.id, request.params.id);
      if (!owned) throw ApiError.notFound('ORDER_NOT_FOUND', 'No such order.');
      const row = await confirmPhysicalCertificatePayment(db, request.params.id, { receiptId: `dev_${Date.now()}` });
      return reply.send({ id: row.id, status: row.status, failureCode: row.failureCode });
    });
  }

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
    // Clearing the name is allowed (falls back to the derived safe name).
    let value: string | null = null;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      // This is the certificate display name — validate it can render safely and
      // cannot inject markup/script/control characters or an email.
      const check = validateCertificateDisplayName(raw);
      if (!check.ok) throw ApiError.badRequest('INVALID_DISPLAY_NAME', check.reason);
      value = check.value;
    }
    const organizationId = await defaultOrganizationId(db);
    await ensureCustomerIdentity(db, { organizationId, userId: request.user!.id });
    await db
      .update(customerIdentities)
      .set({ preferredDisplayName: value && value.length > 0 ? value : null })
      .where(eq(customerIdentities.userId, request.user!.id));
    return reply.send({ preferredDisplayName: value && value.length > 0 ? value : null });
  });
}
