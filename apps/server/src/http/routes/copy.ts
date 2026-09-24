/**
 * Atlas Native Copy Trading — HTTP surface (/api/v1/copy/*).
 *
 * Every route is the caller's own (requireUser + owner-scoped domain calls);
 * follower ids, quantities and ownership from the client are re-validated
 * server-side (no IDOR). Trades fan out through the existing execution provider.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { ApiError } from '../errors.js';
import { requireUser } from '../auth-plugin.js';
import type { ExecutionProvider } from '../../execution/provider.js';
import {
  CopyGroupError,
  addFollower,
  createGroup,
  disableGroup,
  getGroupView,
  listEligibleAccounts,
  listGroupViews,
  pauseGroup,
  removeFollower,
  renameGroup,
  resumeGroup,
  setLeader,
  setSizingMode,
  updateFollower,
} from '../../platform/copy-groups.js';
import {
  cancelCopyIntent,
  flattenCopyGroup,
  listIntents,
  modifyCopyIntent,
  submitCopyIntent,
} from '../../platform/copy-orchestrator.js';
import { executeResync, groupSyncView } from '../../platform/copy-divergence.js';

const NOT_FOUND_CODES = new Set(['GROUP_NOT_FOUND', 'ACCOUNT_NOT_FOUND']);
function mapCopyError(err: unknown): never {
  if (err instanceof CopyGroupError) {
    if (NOT_FOUND_CODES.has(err.code)) throw ApiError.notFound(err.code, err.message);
    throw ApiError.badRequest(err.code, err.message);
  }
  throw err;
}

const sizingMode = z.enum(['SAME', 'MULTIPLIER', 'FIXED']);
const offset = z.object({ unit: z.enum(['TICKS', 'POINTS', 'DOLLARS']), value: z.number() }).nullable().optional();
const orderSchema = z.object({
  symbol: z.string().min(1).max(12),
  side: z.enum(['BUY', 'SELL']),
  qty: z.number().int().positive(),
  type: z.enum(['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT', 'TRAILING_STOP']),
  limitPrice: z.number().nullable().optional(),
  stopPrice: z.number().nullable().optional(),
  tif: z.enum(['DAY', 'GTC', 'IOC', 'FOK']).optional(),
  trailTicks: z.number().int().nullable().optional(),
  bracket: z.object({ stopLoss: offset, takeProfit: offset, trailingStop: offset }).nullable().optional(),
});

export function copyRoutes(deps: { execution: ExecutionProvider }) {
  return async function register(app: FastifyInstance): Promise<void> {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);
    const uid = (r: { user?: { id: string } }): string => r.user!.id;

    app.get('/eligible-accounts', async (req, reply) => reply.send({ accounts: await listEligibleAccounts(db, uid(req)) }));
    app.get('/groups', async (req, reply) => reply.send({ groups: await listGroupViews(db, uid(req)) }));

    app.post('/groups', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const body = z.object({ name: z.string().min(1).max(80), leaderAccountId: z.string().uuid(), sizingMode: sizingMode.optional() }).parse(req.body);
      try {
        const id = await createGroup(db, { userId: uid(req), name: body.name, leaderAccountId: body.leaderAccountId, sizingMode: body.sizingMode });
        return reply.code(201).send(await getGroupView(db, uid(req), id));
      } catch (err) { mapCopyError(err); }
    });

    app.get<{ Params: { id: string } }>('/groups/:id', async (req, reply) => {
      try { return reply.send(await getGroupView(db, uid(req), req.params.id)); } catch (err) { mapCopyError(err); }
    });

    app.patch<{ Params: { id: string } }>('/groups/:id', async (req, reply) => {
      const body = z.object({ name: z.string().min(1).max(80).optional(), sizingMode: sizingMode.optional() }).parse(req.body);
      try {
        if (body.name !== undefined) await renameGroup(db, uid(req), req.params.id, body.name);
        if (body.sizingMode !== undefined) await setSizingMode(db, uid(req), req.params.id, body.sizingMode);
        return reply.send(await getGroupView(db, uid(req), req.params.id));
      } catch (err) { mapCopyError(err); }
    });

    app.post<{ Params: { id: string } }>('/groups/:id/leader', async (req, reply) => {
      const body = z.object({ leaderAccountId: z.string().uuid() }).parse(req.body);
      try { await setLeader(db, uid(req), req.params.id, body.leaderAccountId); return reply.send(await getGroupView(db, uid(req), req.params.id)); } catch (err) { mapCopyError(err); }
    });

    app.post<{ Params: { id: string } }>('/groups/:id/followers', async (req, reply) => {
      const body = z.object({ accountId: z.string().uuid(), sizingMultiplierMilli: z.number().int().positive().nullable().optional(), sizingFixedQty: z.number().int().positive().nullable().optional() }).parse(req.body);
      try {
        await addFollower(db, { userId: uid(req), groupId: req.params.id, accountId: body.accountId, sizingMultiplierMilli: body.sizingMultiplierMilli ?? null, sizingFixedQty: body.sizingFixedQty ?? null });
        return reply.code(201).send(await getGroupView(db, uid(req), req.params.id));
      } catch (err) { mapCopyError(err); }
    });

    app.patch<{ Params: { id: string; accountId: string } }>('/groups/:id/followers/:accountId', async (req, reply) => {
      const body = z.object({ enabled: z.boolean().optional(), sizingMultiplierMilli: z.number().int().positive().nullable().optional(), sizingFixedQty: z.number().int().positive().nullable().optional() }).parse(req.body);
      try {
        await updateFollower(db, { userId: uid(req), groupId: req.params.id, accountId: req.params.accountId, ...body });
        return reply.send(await getGroupView(db, uid(req), req.params.id));
      } catch (err) { mapCopyError(err); }
    });

    app.delete<{ Params: { id: string; accountId: string } }>('/groups/:id/followers/:accountId', async (req, reply) => {
      try { await removeFollower(db, uid(req), req.params.id, req.params.accountId); return reply.send(await getGroupView(db, uid(req), req.params.id)); } catch (err) { mapCopyError(err); }
    });

    for (const [path, fn] of [['pause', pauseGroup], ['resume', resumeGroup], ['disable', disableGroup]] as const) {
      app.post<{ Params: { id: string } }>(`/groups/:id/${path}`, async (req, reply) => {
        try { await fn(db, uid(req), req.params.id); return reply.send(await getGroupView(db, uid(req), req.params.id)); } catch (err) { mapCopyError(err); }
      });
    }

    app.get<{ Params: { id: string } }>('/groups/:id/sync', async (req, reply) => {
      try { return reply.send(await groupSyncView(db, uid(req), req.params.id)); } catch (err) { mapCopyError(err); }
    });

    app.post<{ Params: { id: string } }>('/groups/:id/resync', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const body = z.object({ idempotencyKey: z.string().min(1).max(100) }).parse(req.body);
      try { return reply.send({ results: await executeResync(db, deps.execution, { userId: uid(req), groupId: req.params.id, idempotencyKey: body.idempotencyKey }) }); } catch (err) { mapCopyError(err); }
    });

    app.post<{ Params: { id: string } }>('/groups/:id/flatten', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      const body = z.object({ idempotencyKey: z.string().min(1).max(100), symbol: z.string().max(12).nullable().optional() }).parse(req.body);
      try { return reply.send(await flattenCopyGroup(db, deps.execution, { userId: uid(req), groupId: req.params.id, idempotencyKey: body.idempotencyKey, symbol: body.symbol ?? null })); } catch (err) { mapCopyError(err); }
    });

    app.post<{ Params: { id: string } }>('/groups/:id/intents', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
      const body = z.object({ idempotencyKey: z.string().min(1).max(100), order: orderSchema }).parse(req.body);
      try { return reply.code(201).send(await submitCopyIntent(db, deps.execution, { userId: uid(req), groupId: req.params.id, idempotencyKey: body.idempotencyKey, order: body.order })); } catch (err) { mapCopyError(err); }
    });

    app.post<{ Params: { id: string; intentId: string } }>('/groups/:id/intents/:intentId/modify', async (req, reply) => {
      const body = z.object({ idempotencyKey: z.string().min(1).max(100), patch: z.object({ qty: z.number().int().positive().optional(), limitPrice: z.number().nullable().optional(), stopPrice: z.number().nullable().optional(), trailTicks: z.number().int().nullable().optional() }) }).parse(req.body);
      try { return reply.send(await modifyCopyIntent(db, deps.execution, { userId: uid(req), groupId: req.params.id, originalIntentId: req.params.intentId, idempotencyKey: body.idempotencyKey, patch: body.patch })); } catch (err) { mapCopyError(err); }
    });

    app.post<{ Params: { id: string; intentId: string } }>('/groups/:id/intents/:intentId/cancel', async (req, reply) => {
      const body = z.object({ idempotencyKey: z.string().min(1).max(100) }).parse(req.body);
      try { return reply.send(await cancelCopyIntent(db, deps.execution, { userId: uid(req), groupId: req.params.id, originalIntentId: req.params.intentId, idempotencyKey: body.idempotencyKey })); } catch (err) { mapCopyError(err); }
    });

    app.get<{ Params: { id: string } }>('/groups/:id/intents', async (req, reply) => {
      try { return reply.send({ intents: await listIntents(db, uid(req), req.params.id) }); } catch (err) { mapCopyError(err); }
    });
  };
}
