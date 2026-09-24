/**
 * HTTP surface for the payout engine.
 *
 * Trader routes act on the caller's OWN funded account; owner routes drive the
 * queue and the case. RBAC is enforced server-side: SUPPORT reads the owner
 * views, ADMIN acts on a payout, and a trader can only touch an account they
 * own. Real domain work is delegated to `platform/payouts`; nothing money-moving
 * happens in the handler.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { accounts, users } from '../../db/schema.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { requireRole, requireUser } from '../auth-plugin.js';
import { ApiError } from '../errors.js';
import type { Actor } from '../../platform/actor.js';
import {
  PayoutError,
  approvePayout,
  cancelPayout,
  getPayoutEligibility,
  markPaid,
  markProcessing,
  placeHold,
  rejectPayout,
  removeHold,
  requestPayout,
} from '../../platform/payouts.js';
import { firmExposure, getPayoutCase, listPayouts } from '../../platform/payout-queries.js';

const confirmed = z.object({ confirm: z.literal(true), reason: z.string().min(3).max(500) });

function adminActor(request: { user?: { id: string; email: string } | undefined; ip?: string }): Actor {
  return { type: 'ADMIN', userId: request.user?.id ?? null, label: request.user?.email ?? null, ip: request.ip ?? null };
}
function traderActor(request: { user?: { id: string; email: string } | undefined; ip?: string }): Actor {
  return { type: 'USER', userId: request.user?.id ?? null, label: request.user?.email ?? null, ip: request.ip ?? null };
}

async function organizationOf(userId: string): Promise<string> {
  const { db } = getDb();
  const [row] = await db.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, userId));
  return row?.organizationId ?? (await defaultOrganizationId(db));
}

function mapPayoutError(err: unknown): never {
  if (err instanceof PayoutError) {
    const status = err.code === 'ACCOUNT_NOT_FOUND' || err.code === 'PAYOUT_NOT_FOUND' ? 404 : err.code === 'INVALID_TRANSITION' ? 409 : 400;
    throw new ApiError(status, err.code, err.message, err.reason ? { reason: err.reason } : undefined);
  }
  throw err;
}

/** Confirm the account belongs to the calling trader. */
async function requireOwnAccount(userId: string, accountId: string) {
  const { db } = getDb();
  const [row] = await db.select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
  if (!row) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
  return row;
}

export function payoutRoutes() {
  return async function register(app: FastifyInstance): Promise<void> {
    const { db } = getDb();

    // -- trader: my eligibility + request ------------------------------------

    app.get<{ Params: { accountId: string } }>(
      '/payouts/eligibility/:accountId',
      { preHandler: requireUser },
      async (request) => {
        await requireOwnAccount(request.user!.id, request.params.accountId);
        try {
          const ctx = await getPayoutEligibility(db, request.params.accountId);
          return presentEligibility(ctx);
        } catch (err) {
          return mapPayoutError(err);
        }
      },
    );

    app.post<{ Body: unknown }>(
      '/payouts/requests',
      { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const body = z
          .object({
            accountId: z.string().uuid(),
            amountMicros: z.number().int().positive(),
            idempotencyKey: z.string().min(1).max(200).optional(),
          })
          .parse(request.body);
        await requireOwnAccount(request.user!.id, body.accountId);
        try {
          const row = await requestPayout(db, {
            accountId: body.accountId,
            userId: request.user!.id,
            requestedGrossMicros: body.amountMicros,
            idempotencyKey: body.idempotencyKey ?? null,
            actor: traderActor(request),
          });
          return reply.code(201).send({ id: row.id, state: row.state, requestedGrossMicros: row.requestedGrossMicros });
        } catch (err) {
          return mapPayoutError(err);
        }
      },
    );

    // -- owner: queue, case, exposure ----------------------------------------

    app.get(
      '/admin/payouts',
      { preHandler: requireRole('SUPPORT') },
      async (request) => {
        const q = z
          .object({ state: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), before: z.string().optional() })
          .parse(request.query);
        const organizationId = await organizationOf(request.user!.id);
        return listPayouts(db, organizationId, q);
      },
    );

    app.get(
      '/admin/payouts/exposure',
      { preHandler: requireRole('SUPPORT') },
      async (request) => {
        const organizationId = await organizationOf(request.user!.id);
        return firmExposure(db, organizationId);
      },
    );

    app.get<{ Params: { id: string } }>(
      '/admin/payouts/:id',
      { preHandler: requireRole('SUPPORT') },
      async (request) => {
        const organizationId = await organizationOf(request.user!.id);
        const found = await getPayoutCase(db, organizationId, request.params.id);
        if (!found) throw ApiError.notFound('PAYOUT_NOT_FOUND', 'No such payout.');
        return found;
      },
    );

    // -- owner: actions (ADMIN, reason-required for sensitive) ----------------

    const action = (
      path: string,
      run: (id: string, body: { reason?: string; holdKind?: string }, actor: Actor) => Promise<{ id: string; state: string }>,
      opts: { requireReason?: boolean; role?: 'ADMIN' | 'SUPER_ADMIN' } = {},
    ) => {
      app.post<{ Params: { id: string }; Body: unknown }>(
        `/admin/payouts/:id/${path}`,
        { preHandler: requireRole(opts.role ?? 'ADMIN'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
        async (request, reply) => {
          const organizationId = await organizationOf(request.user!.id);
          const found = await getPayoutCase(db, organizationId, request.params.id);
          if (!found) throw ApiError.notFound('PAYOUT_NOT_FOUND', 'No such payout.');
          const body = opts.requireReason
            ? confirmed.parse(request.body)
            : z.object({ reason: z.string().max(500).optional(), holdKind: z.enum(['RISK', 'FRAUD', 'MANUAL']).optional() }).parse(request.body ?? {});
          try {
            const row = await run(request.params.id, body, adminActor(request));
            return reply.send({ id: row.id, state: row.state });
          } catch (err) {
            return mapPayoutError(err);
          }
        },
      );
    };

    action('approve', (id, body, actor) => approvePayout(db, { payoutRequestId: id, actor, reason: body.reason ?? null }), { requireReason: true });
    action('reject', (id, body, actor) => rejectPayout(db, { payoutRequestId: id, actor, reason: body.reason ?? null }), { requireReason: true });
    action('hold', (id, body, actor) => placeHold(db, { payoutRequestId: id, actor, reason: body.reason ?? null, holdKind: (body.holdKind as 'RISK' | 'FRAUD' | 'MANUAL') ?? 'MANUAL' }), { requireReason: true });
    action('remove-hold', (id, body, actor) => removeHold(db, { payoutRequestId: id, actor, reason: body.reason ?? null }));
    action('cancel', (id, body, actor) => cancelPayout(db, { payoutRequestId: id, actor, reason: body.reason ?? null }), { requireReason: true });
    action('process', (id, _body, actor) => markProcessing(db, { payoutRequestId: id, actor }));
    action('pay', (id, _body, actor) => markPaid(db, { payoutRequestId: id, actor }));
  };
}

function presentEligibility(ctx: Awaited<ReturnType<typeof getPayoutEligibility>>) {
  const e = ctx.eligibility;
  return {
    accountId: ctx.account.id,
    state: e.state,
    reasonCodes: e.reasonCodes,
    grossWithdrawableMicros: e.grossWithdrawableMicros,
    qualifyingWinningDays: e.qualifyingWinningDays,
    requiredWinningDays: ctx.policy.requiredWinningDays,
    bestDayMicros: e.bestDayMicros,
    consistencyRatio: e.consistencyRatio,
    payoutConsistencyThreshold: ctx.policy.payoutConsistencyThreshold,
    bufferEstablished: e.bufferEstablished,
    fundedBufferMicros: ctx.policy.fundedBufferMicros,
    dailyModeUnlocked: e.dailyModeUnlocked,
    minRequestMicros: e.minRequestMicros,
    maxRequestMicros: e.maxRequestMicros,
    profitSplitPercent: ctx.policy.profitSplitPercent,
    model: ctx.policy.model,
    balanceMicros: ctx.account.balanceMicros,
    startingBalanceMicros: ctx.account.startingBalanceMicros,
  };
}
