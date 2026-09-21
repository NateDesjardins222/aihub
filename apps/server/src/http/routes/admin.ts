/**
 * /api/v1/admin
 *
 * The operator's side of Atlas. Nothing here is reachable from the trading
 * terminal, and nothing here trusts the client: every figure is read from the
 * database or the execution engine, and every capability is checked against
 * the caller's CURRENT role in the database rather than the role their token
 * happened to carry when it was issued.
 *
 * Three rules shape the whole file:
 *
 *   1. Read is SUPPORT, mutate is ADMIN, change what a product or a person is
 *      allowed to be is SUPER_ADMIN.
 *   2. Every destructive action takes an explicit `confirm` and a `reason`,
 *      and both end up in the audit log.
 *   3. An administrator sees their own organisation. Tenancy is not a filter
 *      the caller supplies.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireInstrument } from '@atlas/instruments';
import { getDb } from '../../db/client.js';
import {
  accountLifecycles,
  accountProfileVersions,
  accountProfiles,
  accounts,
  auditLog,
  domainEvents,
  executions,
  orders,
  positions,
  riskEvents,
  trades,
  users,
} from '../../db/schema.js';
import { ApiError } from '../errors.js';
import { requireRole, requireUser } from '../auth-plugin.js';
import type { TradingEngine } from '../../trading/engine.js';
import type { MarketDataService } from '../../marketdata/service.js';
import { loadAccountAndTemplate, ruleConfigFor } from '../../trading/account-rules.js';
import {
  ProvisioningError,
  defaultOrganizationId,
  ensurePracticeAccount,
  provisionAccount,
} from '../../platform/provisioning.js';
import { hashPassword } from '../../auth/password.js';
import {
  AccountActionError,
  activateAccount,
  archiveAccount,
  disableAccount,
  enableAccount,
  lockAccount,
  resetAccount,
  unlockAccount,
} from '../../platform/account-service.js';
import { accountAudit, recordAudit, verifyAuditChain } from '../../platform/audit.js';
import { events } from '../../platform/events.js';
import {
  discardDraft,
  getDraft,
  listProfileVersions,
  listProfiles,
  publishDraft,
  publishProfileVersion,
  saveDraft,
  setProfileStatus,
  ProfileError,
} from '../../platform/profiles.js';
import type { Actor } from '../../platform/actor.js';
import { listOpenProjections, valuePositions, valueProjection } from '../../platform/projection.js';

interface AdminDeps {
  readonly engine: TradingEngine;
  /** The market feed, for the System page's honest health reporting. */
  readonly market: MarketDataService;
}

const OPEN_ORDER_STATUSES = ['PENDING', 'ACCEPTED', 'WORKING', 'PARTIALLY_FILLED'];

/** A destructive action says what it is doing and why, or it does not happen. */
const confirmedSchema = z.object({
  confirm: z.literal(true, { message: 'This action must be confirmed.' }),
  reason: z.string().min(3).max(500),
});

const provisionSchema = z.object({
  userId: z.string().uuid(),
  profileKey: z.string().min(1).max(60).optional(),
  profileVersionId: z.string().uuid().optional(),
  displayName: z.string().min(1).max(80).optional(),
  startingBalanceMicros: z.number().int().positive().optional(),
  ruleOverrides: z.record(z.string(), z.unknown()).nullable().optional(),
  instrumentLimits: z.record(z.string(), z.unknown()).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  activate: z.boolean().optional(),
  idempotencyKey: z.string().min(1).max(120).optional(),
});

function actorFor(request: { user?: { id: string; email: string; role: string }; ip?: string }): Actor {
  return {
    type: 'ADMIN',
    userId: request.user?.id ?? null,
    label: request.user?.email ?? null,
    ip: request.ip ?? null,
  };
}

/**
 * Keyset pagination cursor: the (createdAt, id) of the last row on a page.
 *
 * Keyset, not OFFSET: page 50 of a firm's traders costs the same as page 1,
 * because the database seeks straight to the cursor on the composite index
 * rather than counting past everything before it. The cursor is opaque to the
 * client - it hands back exactly what the server gave it.
 */
function encodeCursor(createdAtText: string, id: string): string {
  return Buffer.from(`${createdAtText}|${id}`).toString('base64url');
}

function decodeCursor(raw: string | undefined): { createdAt: string; id: string } | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.lastIndexOf('|');
    if (sep < 0) return null;
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    // The timestamp is Postgres's own microsecond-precision text, so paging
    // never truncates it to milliseconds and skips rows sharing a batch insert.
    if (!createdAt || !/^[0-9a-f-]{36}$/.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** Everything an admin route does is scoped to their own organisation. */
async function organizationOf(userId: string): Promise<string> {
  const { db } = getDb();
  const [row] = await db
    .select({ organizationId: users.organizationId })
    .from(users)
    .where(eq(users.id, userId));
  return row?.organizationId ?? (await defaultOrganizationId(db));
}

function mapActionError(err: unknown): never {
  if (err instanceof AccountActionError) {
    const status = err.code === 'ACCOUNT_NOT_FOUND' ? 404 : 409;
    throw new ApiError(status, err.code, err.message);
  }
  if (err instanceof ProvisioningError) {
    const status =
      err.code === 'USER_NOT_FOUND' || err.code === 'PROFILE_NOT_FOUND'
        ? 404
        : err.code === 'IDEMPOTENCY_CONFLICT'
          ? 409
          : 400;
    throw new ApiError(status, err.code, err.message);
  }
  if (err instanceof ProfileError) throw new ApiError(400, err.code, err.message);
  throw err;
}

export function adminRoutes(deps: AdminDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const { db } = getDb();

    // Reading the operator console is SUPPORT and above. Individual routes
    // raise the bar where they mutate something.
    app.addHook('preHandler', requireUser);
    app.addHook('preHandler', requireRole('SUPPORT'));

    // ---------------------------------------------------------------- overview
    app.get('/overview', async (request, reply) => {
      const organizationId = await organizationOf(request.user!.id);
      const scope = eq(accounts.organizationId, organizationId);

      const [userCounts] = await db
        .select({
          total: sql<number>`count(*)::int`,
          active: sql<number>`count(*) filter (where ${users.status} = 'ACTIVE')::int`,
        })
        .from(users)
        .where(eq(users.organizationId, organizationId));

      const statusRows = await db
        .select({ status: accounts.status, count: sql<number>`count(*)::int` })
        .from(accounts)
        .where(scope)
        .groupBy(accounts.status);

      const [money] = await db
        .select({
          accounts: sql<number>`count(*)::int`,
          balance: sql<number>`coalesce(sum(${accounts.balanceMicros}), 0)::bigint`,
          realized: sql<number>`coalesce(sum(${accounts.realizedPnlMicros}), 0)::bigint`,
          fees: sql<number>`coalesce(sum(${accounts.feesMicros}), 0)::bigint`,
          starting: sql<number>`coalesce(sum(${accounts.startingBalanceMicros}), 0)::bigint`,
        })
        .from(accounts)
        .where(scope);

      const [openPositions] = await db
        .select({
          positions: sql<number>`count(*)::int`,
          contracts: sql<number>`coalesce(sum(abs(${positions.qty})), 0)::int`,
        })
        .from(positions)
        .innerJoin(accounts, eq(positions.accountId, accounts.id))
        .where(and(scope, sql`${positions.qty} <> 0`));

      const [workingOrders] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .innerJoin(accounts, eq(orders.accountId, accounts.id))
        .where(and(scope, inArray(orders.status, OPEN_ORDER_STATUSES)));

      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [volume] = await db
        .select({
          fills: sql<number>`count(*)::int`,
          contracts: sql<number>`coalesce(sum(${executions.qty}), 0)::int`,
        })
        .from(executions)
        .innerJoin(accounts, eq(executions.accountId, accounts.id))
        .where(and(scope, gte(executions.execTime, dayAgo)));

      const [tradeStats] = await db
        .select({
          trades: sql<number>`count(*)::int`,
          net: sql<number>`coalesce(sum(${trades.netPnlMicros}), 0)::bigint`,
        })
        .from(trades)
        .innerJoin(accounts, eq(trades.accountId, accounts.id))
        .where(scope);

      const activity = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.organizationId, organizationId))
        .orderBy(desc(auditLog.createdAt))
        .limit(25);

      const byStatus: Record<string, number> = {};
      for (const row of statusRows) byStatus[row.status] = row.count;

      return reply.send({
        users: { total: userCounts?.total ?? 0, active: userCounts?.active ?? 0 },
        accounts: {
          total: money?.accounts ?? 0,
          byStatus,
          active: byStatus['ACTIVE'] ?? 0,
          passed: byStatus['PASSED'] ?? 0,
          failed: byStatus['FAILED'] ?? 0,
        },
        exposure: {
          openPositions: openPositions?.positions ?? 0,
          openContracts: openPositions?.contracts ?? 0,
          workingOrders: workingOrders?.count ?? 0,
        },
        volume: { fills24h: volume?.fills ?? 0, contracts24h: volume?.contracts ?? 0 },
        money: {
          balanceMicros: Number(money?.balance ?? 0),
          startingBalanceMicros: Number(money?.starting ?? 0),
          realizedPnlMicros: Number(money?.realized ?? 0),
          feesMicros: Number(money?.fees ?? 0),
          /** Simulated, like everything else here. */
          netPnlMicros: Number(tradeStats?.net ?? 0),
          closedTrades: tradeStats?.trades ?? 0,
        },
        activity: activity.map(presentAudit),
      });
    });

    // ------------------------------------------------------------------- users
    app.get('/users', async (request, reply) => {
      const query = z
        .object({
          q: z.string().max(120).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().max(200).optional(),
        })
        .parse(request.query);
      const organizationId = await organizationOf(request.user!.id);

      const term = query.q?.trim();
      const after = decodeCursor(query.cursor);
      const conditions = [eq(users.organizationId, organizationId)];
      if (term) {
        conditions.push(
          or(ilike(users.email, `%${term}%`), ilike(users.displayName, `%${term}%`))!,
        );
      }
      if (after) {
        conditions.push(
          sql`(${users.createdAt}, ${users.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
        );
      }

      // One more than asked, to know whether a next page exists without a count.
      const rows = await db
        .select({
          user: users,
          /* Postgres's own full-precision timestamp text, for a lossless cursor. */
          sortTs: sql<string>`${users.createdAt}::text`,
          /*
           * Written with explicit identifiers rather than interpolated
           * columns. A column interpolated into a sub-select renders
           * unqualified - "id" rather than "users"."id" - and binds to the
           * SUBQUERY's table, which silently counts nothing.
           */
          accounts: sql<number>`(
            select count(*)::int from "accounts" a where a.user_id = "users"."id"
          )`,
        })
        .from(users)
        .where(and(...conditions))
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(query.limit + 1);

      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return reply.send({
        users: page.map((row) => ({ ...presentUser(row.user), accountCount: row.accounts })),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.sortTs, last.user.id) : null,
      });
    });

    app.get<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
      const organizationId = await organizationOf(request.user!.id);
      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, request.params.id), eq(users.organizationId, organizationId)));
      if (!user) throw ApiError.notFound('USER_NOT_FOUND', 'No such user.');

      const owned = await db
        .select({ account: accounts, profile: accountProfiles, version: accountProfileVersions })
        .from(accounts)
        .leftJoin(accountProfileVersions, eq(accounts.profileVersionId, accountProfileVersions.id))
        .leftJoin(accountProfiles, eq(accountProfileVersions.profileId, accountProfiles.id))
        .where(eq(accounts.userId, user.id))
        .orderBy(desc(accounts.createdAt));

      const activity = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.userId, user.id))
        .orderBy(desc(auditLog.createdAt))
        .limit(50);

      const recentTrades = await db
        .select({ trade: trades, publicId: accounts.publicId })
        .from(trades)
        .innerJoin(accounts, eq(trades.accountId, accounts.id))
        .where(eq(accounts.userId, user.id))
        .orderBy(desc(trades.exitTime))
        .limit(50);

      return reply.send({
        user: presentUser(user),
        accounts: owned.map((row) => presentAccountRow(row.account, row.profile, row.version)),
        activity: activity.map(presentAudit),
        trades: recentTrades.map((row) => ({
          accountPublicId: row.publicId,
          symbol: row.trade.symbol,
          side: row.trade.side,
          qty: row.trade.qty,
          netPnlMicros: row.trade.netPnlMicros,
          exitTime: row.trade.exitTime.getTime(),
          tradeDate: row.trade.tradeDate,
        })),
      });
    });

    /**
     * Create a trader.
     *
     * An operator onboarding someone directly - the other route in is
     * self-service registration. The password is chosen by the caller and
     * never stored in the clear; the practice account comes through the same
     * provisioning service registration uses, so a hand-made user and a
     * self-registered one are indistinguishable afterwards.
     */
    app.post(
      '/users',
      { preHandler: requireRole('ADMIN'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const body = z
          .object({
            email: z.string().email().max(254),
            displayName: z.string().min(1).max(60),
            password: z.string().min(12).max(200),
            role: z.enum(['TRADER', 'SUPPORT']).default('TRADER'),
            withPracticeAccount: z.boolean().default(true),
          })
          .parse(request.body);
        const organizationId = await organizationOf(request.user!.id);
        const email = body.email.trim().toLowerCase();

        const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
        if (existing) throw ApiError.conflict('EMAIL_TAKEN', 'That email is already registered.');

        const [created] = await db
          .insert(users)
          .values({
            email,
            displayName: body.displayName,
            passwordHash: await hashPassword(body.password),
            role: body.role,
            organizationId,
          })
          .returning();

        await recordAudit(db, {
          organizationId,
          actor: actorFor(request),
          subjectType: 'USER',
          subjectId: created!.id,
          userId: created!.id,
          action: 'admin.user.created',
          newState: { email, displayName: body.displayName, role: body.role },
        });
        await events.publish(db, {
          type: 'user.created',
          organizationId,
          userId: created!.id,
          payload: { email, createdBy: request.user!.email },
        });

        if (body.withPracticeAccount) await ensurePracticeAccount(db, created!.id, organizationId);

        return reply.code(201).send({ user: presentUser(created!) });
      },
    );

    app.post<{ Params: { id: string } }>(
      '/users/:id/disable',
      { preHandler: requireRole('ADMIN'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const body = confirmedSchema.parse(request.body);
        const organizationId = await organizationOf(request.user!.id);
        const [user] = await db
          .select()
          .from(users)
          .where(and(eq(users.id, request.params.id), eq(users.organizationId, organizationId)));
        if (!user) throw ApiError.notFound('USER_NOT_FOUND', 'No such user.');

        await db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, user.id));
        await recordUserChange(organizationId, actorFor(request), user, 'user.disabled', body.reason, {
          status: 'DISABLED',
        });
        return reply.send({ user: { ...presentUser(user), status: 'DISABLED' } });
      },
    );

    app.post<{ Params: { id: string } }>(
      '/users/:id/enable',
      { preHandler: requireRole('ADMIN'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const body = confirmedSchema.parse(request.body);
        const organizationId = await organizationOf(request.user!.id);
        const [user] = await db
          .select()
          .from(users)
          .where(and(eq(users.id, request.params.id), eq(users.organizationId, organizationId)));
        if (!user) throw ApiError.notFound('USER_NOT_FOUND', 'No such user.');

        await db.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, user.id));
        await recordUserChange(organizationId, actorFor(request), user, 'user.enabled', body.reason, {
          status: 'ACTIVE',
        });
        return reply.send({ user: { ...presentUser(user), status: 'ACTIVE' } });
      },
    );

    app.post<{ Params: { id: string } }>(
      '/users/:id/role',
      { preHandler: requireRole('SUPER_ADMIN'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const body = confirmedSchema
          .extend({ role: z.enum(['TRADER', 'SUPPORT', 'ADMIN', 'SUPER_ADMIN']) })
          .parse(request.body);
        const organizationId = await organizationOf(request.user!.id);
        const [user] = await db
          .select()
          .from(users)
          .where(and(eq(users.id, request.params.id), eq(users.organizationId, organizationId)));
        if (!user) throw ApiError.notFound('USER_NOT_FOUND', 'No such user.');

        await db
          .update(users)
          // isAdmin is kept in step for tokens that predate roles.
          .set({ role: body.role, isAdmin: body.role === 'ADMIN' || body.role === 'SUPER_ADMIN' })
          .where(eq(users.id, user.id));
        await recordUserChange(
          organizationId,
          actorFor(request),
          user,
          'user.role_changed',
          body.reason,
          { role: body.role },
        );
        return reply.send({ user: { ...presentUser(user), role: body.role } });
      },
    );

    // ---------------------------------------------------------------- accounts
    app.get('/accounts', async (request, reply) => {
      const query = z
        .object({
          q: z.string().max(120).optional(),
          status: z.string().max(20).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().max(200).optional(),
        })
        .parse(request.query);
      const organizationId = await organizationOf(request.user!.id);
      const term = query.q?.trim();
      const after = decodeCursor(query.cursor);

      const filters = [eq(accounts.organizationId, organizationId)];
      if (query.status) filters.push(eq(accounts.status, query.status));
      if (term) {
        filters.push(
          or(
            ilike(accounts.publicId, `%${term}%`),
            ilike(accounts.name, `%${term}%`),
            ilike(users.email, `%${term}%`),
          )!,
        );
      }
      if (after) {
        filters.push(
          sql`(${accounts.createdAt}, ${accounts.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
        );
      }

      const rows = await db
        .select({
          account: accounts,
          user: users,
          profile: accountProfiles,
          version: accountProfileVersions,
          sortTs: sql<string>`${accounts.createdAt}::text`,
          openContracts: sql<number>`(
            select coalesce(sum(abs(p.qty)), 0)::int from "positions" p
            where p.account_id = "accounts"."id" and p.qty <> 0
          )`,
          lastTradedAt: sql<string | null>`(
            select max(e.exec_time) from "executions" e where e.account_id = "accounts"."id"
          )`,
        })
        .from(accounts)
        .innerJoin(users, eq(accounts.userId, users.id))
        .leftJoin(accountProfileVersions, eq(accounts.profileVersionId, accountProfileVersions.id))
        .leftJoin(accountProfiles, eq(accountProfileVersions.profileId, accountProfiles.id))
        .where(and(...filters))
        .orderBy(desc(accounts.createdAt), desc(accounts.id))
        .limit(query.limit + 1);

      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return reply.send({
        accounts: page.map((row) => ({
          ...presentAccountRow(row.account, row.profile, row.version),
          owner: { id: row.user.id, email: row.user.email, displayName: row.user.displayName },
          openContracts: row.openContracts,
          lastTradedAt: row.lastTradedAt ? new Date(row.lastTradedAt).getTime() : null,
        })),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.sortTs, last.account.id) : null,
      });
    });

    app.get<{ Params: { id: string } }>('/accounts/:id', async (request, reply) => {
      const organizationId = await organizationOf(request.user!.id);
      const [row] = await db
        .select({
          account: accounts,
          user: users,
          profile: accountProfiles,
          version: accountProfileVersions,
        })
        .from(accounts)
        .innerJoin(users, eq(accounts.userId, users.id))
        .leftJoin(accountProfileVersions, eq(accounts.profileVersionId, accountProfileVersions.id))
        .leftJoin(accountProfiles, eq(accountProfileVersions.profileId, accountProfiles.id))
        .where(
          and(eq(accounts.id, request.params.id), eq(accounts.organizationId, organizationId)),
        );
      if (!row) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');

      const loaded = await loadAccountAndTemplate(db, row.account.id);
      const config = loaded ? ruleConfigFor(loaded.account, loaded.template) : null;

      const [lives, recentOrders, fills, held, violations, closed, audit] = await Promise.all([
        db
          .select()
          .from(accountLifecycles)
          .where(eq(accountLifecycles.accountId, row.account.id))
          .orderBy(desc(accountLifecycles.seq)),
        db
          .select()
          .from(orders)
          .where(eq(orders.accountId, row.account.id))
          .orderBy(desc(orders.createdAt))
          .limit(50),
        db
          .select()
          .from(executions)
          .where(eq(executions.accountId, row.account.id))
          .orderBy(desc(executions.execTime))
          .limit(50),
        db.select().from(positions).where(eq(positions.accountId, row.account.id)),
        db
          .select()
          .from(riskEvents)
          .where(eq(riskEvents.accountId, row.account.id))
          .orderBy(desc(riskEvents.createdAt))
          .limit(50),
        db
          .select()
          .from(trades)
          .where(eq(trades.accountId, row.account.id))
          .orderBy(desc(trades.exitTime))
          .limit(50),
        accountAudit(db, row.account.id, 100),
      ]);

      return reply.send({
        account: presentAccountRow(row.account, row.profile, row.version),
        owner: { id: row.user.id, email: row.user.email, displayName: row.user.displayName },
        rules: config,
        lifecycles: lives.map((life) => ({
          id: life.id,
          seq: life.seq,
          startingBalanceMicros: life.startingBalanceMicros,
          startedAt: life.startedAt.getTime(),
          endedAt: life.endedAt?.getTime() ?? null,
          endReason: life.endReason,
          finalBalanceMicros: life.finalBalanceMicros,
          finalStatus: life.finalStatus,
        })),
        orders: recentOrders.map(presentAdminOrder),
        fills: fills.map((fill) => ({
          id: fill.id,
          orderId: fill.orderId,
          symbol: fill.symbol,
          side: fill.side,
          qty: fill.qty,
          price: priceOf(fill.symbol, fill.priceTicks),
          feesMicros: fill.feesMicros,
          realizedPnlMicros: fill.realizedPnlMicros,
          execTime: fill.execTime.getTime(),
        })),
        positions: held.map((position) => ({
          symbol: position.symbol,
          side: position.side,
          qty: position.qty,
          costBasisMicros: position.costBasisMicros,
          realizedPnlMicros: position.realizedPnlMicros,
          openedAt: position.openedAt?.getTime() ?? null,
        })),
        violations: violations.map((violation) => ({
          id: violation.id,
          rule: violation.rule,
          reasonCode: violation.reasonCode,
          detail: violation.detail,
          at: violation.createdAt.getTime(),
        })),
        trades: closed.map((trade) => ({
          id: trade.id,
          symbol: trade.symbol,
          side: trade.side,
          qty: trade.qty,
          netPnlMicros: trade.netPnlMicros,
          entryTime: trade.entryTime.getTime(),
          exitTime: trade.exitTime.getTime(),
          tradeDate: trade.tradeDate,
        })),
        audit: audit.map(presentAudit),
      });
    });

    /**
     * The live view.
     *
     * Straight from the execution engine's own valuation, which is the same
     * figure the trader's terminal is pushed. An administrator and a trader
     * looking at the same account at the same moment see the same number
     * because it is literally the same number.
     */
    app.get<{ Params: { id: string } }>('/accounts/:id/live', async (request, reply) => {
      const organizationId = await organizationOf(request.user!.id);
      const [account] = await db
        .select()
        .from(accounts)
        .where(
          and(eq(accounts.id, request.params.id), eq(accounts.organizationId, organizationId)),
        );
      if (!account) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');

      const valuation = await deps.engine.valuation(account.id);
      const working = await db
        .select()
        .from(orders)
        .where(and(eq(orders.accountId, account.id), inArray(orders.status, OPEN_ORDER_STATUSES)))
        .orderBy(desc(orders.createdAt));
      const fills = await db
        .select()
        .from(executions)
        .where(eq(executions.accountId, account.id))
        .orderBy(desc(executions.execTime))
        .limit(20);
      const violations = await db
        .select()
        .from(riskEvents)
        .where(eq(riskEvents.accountId, account.id))
        .orderBy(desc(riskEvents.createdAt))
        .limit(20);

      return reply.send({
        accountId: account.id,
        publicId: account.publicId,
        status: account.status,
        valuation,
        workingOrders: working.map(presentAdminOrder),
        recentFills: fills.map((fill) => ({
          id: fill.id,
          symbol: fill.symbol,
          side: fill.side,
          qty: fill.qty,
          price: priceOf(fill.symbol, fill.priceTicks),
          realizedPnlMicros: fill.realizedPnlMicros,
          execTime: fill.execTime.getTime(),
        })),
        recentViolations: violations.map((violation) => ({
          rule: violation.rule,
          reasonCode: violation.reasonCode,
          at: violation.createdAt.getTime(),
        })),
      });
    });

    // ------------------------------------------------------------- provisioning
    app.post(
      '/accounts',
      { preHandler: requireRole('ADMIN'), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const body = provisionSchema.parse(request.body);
        if (!body.profileKey && !body.profileVersionId) {
          throw ApiError.badRequest('PROFILE_REQUIRED', 'Name the product to provision from.');
        }
        const organizationId = await organizationOf(request.user!.id);
        try {
          const result = await provisionAccount(db, {
            ...body,
            organizationId,
            actor: actorFor(request),
          });
          return reply.code(result.reused ? 200 : 201).send({
            accountId: result.accountId,
            publicId: result.publicId,
            product: { key: result.profile.profileKey, version: result.profile.version },
            reused: result.reused,
          });
        } catch (err) {
          mapActionError(err);
        }
      },
    );

    // ------------------------------------------------------------------ actions
    const action = (
      path: string,
      run: (accountId: string, actor: Actor, reason: string) => Promise<unknown>,
    ): void => {
      app.post<{ Params: { id: string } }>(
        path,
        {
          preHandler: requireRole('ADMIN'),
          config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
        },
        async (request, reply) => {
          const body = confirmedSchema.parse(request.body);
          const organizationId = await organizationOf(request.user!.id);
          const [account] = await db
            .select({ id: accounts.id })
            .from(accounts)
            .where(
              and(
                eq(accounts.id, request.params.id),
                eq(accounts.organizationId, organizationId),
              ),
            );
          if (!account) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
          try {
            const result = await run(account.id, actorFor(request), body.reason);
            return reply.send({ ok: true, result });
          } catch (err) {
            mapActionError(err);
          }
        },
      );
    };

    action('/accounts/:id/activate', (id, actor, reason) => activateAccount(db, id, actor, reason));
    action('/accounts/:id/lock', (id, actor, reason) =>
      lockAccount(db, id, actor, reason, deps.engine),
    );
    action('/accounts/:id/unlock', (id, actor, reason) => unlockAccount(db, id, actor, reason));
    action('/accounts/:id/disable', (id, actor, reason) =>
      disableAccount(db, id, actor, reason, deps.engine),
    );
    action('/accounts/:id/enable', (id, actor, reason) => enableAccount(db, id, actor, reason));
    action('/accounts/:id/archive', (id, actor, reason) =>
      archiveAccount(db, id, actor, reason, deps.engine),
    );
    action('/accounts/:id/reset', async (id, actor, reason) => {
      const result = await resetAccount(db, id, { actor, reason, execution: deps.engine });
      return {
        lifecycleId: result.lifecycleId,
        lifecycleSeq: result.lifecycleSeq,
        previousLifecycleId: result.previousLifecycleId,
        balanceMicros: result.account.balanceMicros,
      };
    });

    // ----------------------------------------------------------------- products
    app.get('/profiles', async (request, reply) => {
      const organizationId = await organizationOf(request.user!.id);
      const rows = await listProfiles(db, organizationId);
      return reply.send({
        profiles: rows.map((row) => ({
          id: row.profile.id,
          key: row.profile.key,
          name: row.profile.name,
          accountType: row.profile.accountType,
          status: row.profile.status,
          description: row.profile.description,
          latestVersion: row.latest
            ? { id: row.latest.id, version: row.latest.version, config: row.latest.config }
            : null,
        })),
      });
    });

    app.post(
      '/profiles',
      { preHandler: requireRole('SUPER_ADMIN'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const body = z
          .object({
            key: z
              .string()
              .min(1)
              .max(60)
              .regex(/^[a-z0-9-]+$/, 'Use lower case letters, numbers and hyphens.'),
            name: z.string().min(1).max(120),
            accountType: z.string().min(1).max(20),
            description: z.string().max(500).nullable().optional(),
            notes: z.string().max(500).nullable().optional(),
            config: z.unknown(),
          })
          .parse(request.body);
        const organizationId = await organizationOf(request.user!.id);
        try {
          const published = await publishProfileVersion(db, {
            organizationId,
            key: body.key,
            name: body.name,
            accountType: body.accountType,
            description: body.description ?? null,
            notes: body.notes ?? null,
            config: body.config,
            createdByUserId: request.user!.id,
          });
          await recordProfilePublication(organizationId, actorFor(request), published);
          return reply.code(201).send({
            profileId: published.profileId,
            key: published.profileKey,
            version: published.version,
          });
        } catch (err) {
          mapActionError(err);
        }
      },
    );

    /*
     * One product, in full: its identity, every published version (the version
     * history, newest first), and the working draft if one exists. This is what
     * the editor loads. The full config of each version travels with it so the
     * client can show a field-level change preview - the diff is presentation,
     * not a thing the server needs a separate endpoint for.
     */
    app.get<{ Params: { key: string } }>('/profiles/:key', async (request, reply) => {
      const organizationId = await organizationOf(request.user!.id);
      const [profile] = await db
        .select()
        .from(accountProfiles)
        .where(
          and(
            eq(accountProfiles.organizationId, organizationId),
            eq(accountProfiles.key, request.params.key),
          ),
        );

      const draft = await getDraft(db, organizationId, request.params.key);
      if (!profile) {
        // A brand-new product exists only as a draft until its first publish.
        if (!draft) throw ApiError.notFound('PROFILE_NOT_FOUND', 'No such product.');
        return reply.send({ profile: null, versions: [], draft: presentDraft(draft) });
      }

      const versions = await listProfileVersions(db, profile.id);
      return reply.send({
        profile: {
          id: profile.id,
          key: profile.key,
          name: profile.name,
          accountType: profile.accountType,
          status: profile.status,
          description: profile.description,
          createdAt: profile.createdAt.getTime(),
          updatedAt: profile.updatedAt.getTime(),
        },
        versions: versions.map((v) => ({
          id: v.id,
          version: v.version,
          config: v.config,
          notes: v.notes,
          createdByUserId: v.createdByUserId,
          publishedAt: v.publishedAt.getTime(),
        })),
        draft: draft ? presentDraft(draft) : null,
      });
    });

    // ------------------------------------------------------------- product draft
    const draftBody = z.object({
      name: z.string().min(1).max(120),
      accountType: z.string().min(1).max(20),
      description: z.string().max(500).nullable().optional(),
      notes: z.string().max(500).nullable().optional(),
      config: z.unknown(),
    });

    app.put<{ Params: { key: string } }>(
      '/profiles/:key/draft',
      { preHandler: requireRole('SUPER_ADMIN'), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const key = z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-z0-9-]+$/, 'Use lower case letters, numbers and hyphens.')
          .parse(request.params.key);
        const body = draftBody.parse(request.body);
        const organizationId = await organizationOf(request.user!.id);
        try {
          const saved = await saveDraft(db, {
            organizationId,
            key,
            name: body.name,
            accountType: body.accountType,
            description: body.description ?? null,
            notes: body.notes ?? null,
            config: body.config,
            updatedByUserId: request.user!.id,
          });
          return reply.send({ draft: presentDraft(saved) });
        } catch (err) {
          mapActionError(err);
        }
      },
    );

    app.delete<{ Params: { key: string } }>(
      '/profiles/:key/draft',
      { preHandler: requireRole('SUPER_ADMIN') },
      async (request, reply) => {
        const organizationId = await organizationOf(request.user!.id);
        const removed = await discardDraft(db, organizationId, request.params.key);
        return reply.send({ discarded: removed });
      },
    );

    app.post<{ Params: { key: string } }>(
      '/profiles/:key/publish',
      { preHandler: requireRole('SUPER_ADMIN'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const organizationId = await organizationOf(request.user!.id);
        try {
          const published = await publishDraft(db, organizationId, request.params.key, request.user!.id);
          await recordProfilePublication(organizationId, actorFor(request), published);
          return reply.code(201).send({
            profileId: published.profileId,
            key: published.profileKey,
            version: published.version,
          });
        } catch (err) {
          mapActionError(err);
        }
      },
    );

    // ------------------------------------------------------ activate / deactivate
    app.patch<{ Params: { key: string } }>(
      '/profiles/:key/status',
      { preHandler: requireRole('SUPER_ADMIN') },
      async (request, reply) => {
        const body = z
          .object({ status: z.enum(['ACTIVE', 'RETIRED']), reason: z.string().min(3).max(500) })
          .parse(request.body);
        const organizationId = await organizationOf(request.user!.id);
        const [profile] = await db
          .select()
          .from(accountProfiles)
          .where(
            and(
              eq(accountProfiles.organizationId, organizationId),
              eq(accountProfiles.key, request.params.key),
            ),
          );
        if (!profile) throw ApiError.notFound('PROFILE_NOT_FOUND', 'No such product.');
        if (profile.status === body.status) {
          return reply.send({ profileId: profile.id, key: profile.key, status: profile.status });
        }
        const updated = await setProfileStatus(db, organizationId, profile.id, body.status);
        await recordAudit(db, {
          organizationId,
          actor: actorFor(request),
          subjectType: 'PROFILE',
          subjectId: profile.id,
          action: body.status === 'RETIRED' ? 'profile.retired' : 'profile.reactivated',
          prevState: { status: profile.status },
          newState: { status: body.status },
          reason: body.reason,
        });
        return reply.send({ profileId: updated!.id, key: updated!.key, status: updated!.status });
      },
    );

    // -------------------------------------------------------------------- audit
    app.get('/audit', async (request, reply) => {
      const query = z
        .object({
          accountId: z.string().uuid().optional(),
          userId: z.string().uuid().optional(),
          action: z.string().max(60).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(request.query);
      const organizationId = await organizationOf(request.user!.id);

      const filters = [eq(auditLog.organizationId, organizationId)];
      if (query.accountId) filters.push(eq(auditLog.accountId, query.accountId));
      if (query.userId) filters.push(eq(auditLog.userId, query.userId));
      if (query.action) filters.push(eq(auditLog.action, query.action));

      const rows = await db
        .select()
        .from(auditLog)
        .where(and(...filters))
        .orderBy(desc(auditLog.createdAt))
        .limit(query.limit);
      return reply.send({ entries: rows.map(presentAudit) });
    });

    /** Has anything been rewritten behind the application's back? */
    app.get('/audit/verify', async (request, reply) => {
      const organizationId = await organizationOf(request.user!.id);
      const verification = await verifyAuditChain(db, organizationId, { limit: 20_000 });
      return reply.send(verification);
    });

    app.get('/events', async (request, reply) => {
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
        .parse(request.query);
      const organizationId = await organizationOf(request.user!.id);
      const rows = await db
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.organizationId, organizationId))
        .orderBy(desc(domainEvents.occurredAt))
        .limit(query.limit);
      return reply.send({
        events: rows.map((row) => ({
          id: row.id,
          type: row.type,
          accountId: row.accountId,
          userId: row.userId,
          payload: row.payload,
          occurredAt: row.occurredAt.getTime(),
          deliveredAt: row.deliveredAt?.getTime() ?? null,
        })),
      });
    });

    /*
     * Firm-wide trading surveillance.
     *
     * Open positions are read from the durable account projection and marked at
     * read time - never per-account reconstruction. The projection stores signed
     * quantity and cost basis; the mark is applied here from the same market the
     * trader's terminal uses, so owner and trader see one truth. A position that
     * cannot be marked reads unknown, never a fabricated zero - the class of
     * money bug the diagnostics milestone spent itself catching. Only accounts
     * that actually hold a position are scanned, so the cost is bounded by open
     * exposure, not by the account count.
     */
    app.get('/trading', async (request, reply) => {
      const organizationId = await organizationOf(request.user!.id);

      // Read the operational projection, not a per-account reconstruction. Marks
      // are applied to the stored positions at read time, so unrealized P&L is
      // current while the read stays a projection scan. Unknown stays unknown.
      const open = await listOpenProjections(db, organizationId, 300);
      const openPositions = open.flatMap(({ projection, publicId, email }) =>
        valuePositions(projection, deps.market).map((p) => ({
          accountId: projection.accountId,
          accountPublicId: publicId,
          trader: email,
          symbol: p.symbol,
          side: p.side,
          qty: p.qty,
          avgEntryPrice: p.avgEntryPrice,
          markPrice: p.markPrice,
          unrealizedPnlMicros: p.unrealizedPnlMicros,
          openedAt: p.openedAt,
        })),
      );

      const workingRows = await db
        .select({ order: orders, publicId: accounts.publicId, accountId: accounts.id, email: users.email })
        .from(orders)
        .innerJoin(accounts, eq(orders.accountId, accounts.id))
        .innerJoin(users, eq(accounts.userId, users.id))
        .where(and(eq(accounts.organizationId, organizationId), inArray(orders.status, OPEN_ORDER_STATUSES)))
        .orderBy(desc(orders.createdAt))
        .limit(100);

      const fillRows = await db
        .select({ fill: executions, publicId: accounts.publicId, accountId: accounts.id, email: users.email })
        .from(executions)
        .innerJoin(accounts, eq(executions.accountId, accounts.id))
        .innerJoin(users, eq(accounts.userId, users.id))
        .where(eq(accounts.organizationId, organizationId))
        .orderBy(desc(executions.execTime))
        .limit(100);

      return reply.send({
        openPositions,
        openContracts: openPositions.reduce((sum, p) => sum + p.qty, 0),
        workingOrders: workingRows.map((row) => ({
          ...presentAdminOrder(row.order),
          accountId: row.accountId,
          accountPublicId: row.publicId,
          trader: row.email,
        })),
        recentFills: fillRows.map((row) => ({
          id: row.fill.id,
          accountId: row.accountId,
          accountPublicId: row.publicId,
          trader: row.email,
          symbol: row.fill.symbol,
          side: row.fill.side,
          qty: row.fill.qty,
          price: priceOf(row.fill.symbol, row.fill.priceTicks),
          realizedPnlMicros: row.fill.realizedPnlMicros,
          feesMicros: row.fill.feesMicros ?? null,
          execTime: row.fill.execTime.getTime(),
        })),
      });
    });

    /*
     * Risk: where should the operator look first?
     *
     * Every ordering here is a plain, stated fact - no opaque score. Accounts
     * with open exposure are read from the durable projection and valued with
     * current marks (the only truthful source of unrealized P&L and remaining
     * drawdown, applied at read time); held and recently-failed accounts come
     * straight from their lifecycle status. An account that is flat is not
     * "near its limit" - it has no open risk to be near it with - so the
     * ranked lists are over accounts that can actually move right now.
     */
    app.get('/risk', async (request, reply) => {
      const organizationId = await organizationOf(request.user!.id);

      // Ranked from the operational projection, valued with current marks - the
      // same truth the trader sees, without reconstructing every account.
      const open = await listOpenProjections(db, organizationId, 300);
      const valued = open.map(({ projection, publicId, email }) => {
        const v = valueProjection(projection, deps.market);
        return {
          accountId: projection.accountId,
          accountPublicId: publicId,
          trader: email,
          openPnlMicros: v.unrealizedPnlMicros,
          remainingDrawdownMicros: v.remainingLossMicros,
          openContracts: v.openContracts,
          equityMicros: v.equityMicros,
        };
      });

      const nearestLossLimit = [...valued]
        .filter((v) => v.remainingDrawdownMicros !== null)
        .sort((a, b) => (a.remainingDrawdownMicros ?? 0) - (b.remainingDrawdownMicros ?? 0))
        .slice(0, 15);
      const largestUnrealizedLoss = [...valued]
        .filter((v) => (v.openPnlMicros ?? 0) < 0)
        .sort((a, b) => (a.openPnlMicros ?? 0) - (b.openPnlMicros ?? 0))
        .slice(0, 15);

      const held = await db
        .select({ account: accounts, email: users.email })
        .from(accounts)
        .innerJoin(users, eq(accounts.userId, users.id))
        .where(and(eq(accounts.organizationId, organizationId), eq(accounts.status, 'LOCKED')))
        .orderBy(desc(accounts.updatedAt))
        .limit(50);

      const failed = await db
        .select({ account: accounts, email: users.email })
        .from(accounts)
        .innerJoin(users, eq(accounts.userId, users.id))
        .where(and(eq(accounts.organizationId, organizationId), eq(accounts.status, 'FAILED')))
        .orderBy(desc(accounts.updatedAt))
        .limit(15);

      const brief = (row: { account: AccountRow; email: string }) => ({
        accountId: row.account.id,
        accountPublicId: row.account.publicId,
        name: row.account.name,
        trader: row.email,
        balanceMicros: row.account.balanceMicros,
        failedReason: row.account.failedReason,
        updatedAt: row.account.updatedAt?.getTime() ?? null,
      });

      return reply.send({
        nearestLossLimit,
        largestUnrealizedLoss,
        onHold: held.map(brief),
        recentFailures: failed.map(brief),
      });
    });

    /*
     * System health, told honestly.
     *
     * Green means green. A 200 from this endpoint proves the API is up and the
     * database answered - it says nothing about the market feed, which is
     * reported from the provider's own connection state and the age of its last
     * print. A delayed provider is DELAYED, a stale one DEGRADED, a
     * disconnected one OFFLINE - never a green tick because an HTTP call
     * happened to return.
     */
    app.get('/system', async (request, reply) => {
      const organizationId = await organizationOf(request.user!.id);

      let dbState: 'HEALTHY' | 'OFFLINE' = 'HEALTHY';
      try {
        await db.execute(sql`select 1`);
      } catch {
        dbState = 'OFFLINE';
      }

      const connection = deps.market.getConnectionStatus();
      const quote = deps.market.getQuote('NQ');
      const freshness = deps.market.freshness('NQ');
      let marketState: 'HEALTHY' | 'DELAYED' | 'DEGRADED' | 'OFFLINE';
      if (connection.state !== 'CONNECTED') {
        marketState = connection.state === 'RECONNECTING' ? 'DEGRADED' : 'OFFLINE';
      } else if (freshness.blocksOrderEntry) {
        marketState = 'DEGRADED';
      } else if (connection.mode === 'DELAYED') {
        marketState = 'DELAYED';
      } else {
        marketState = 'HEALTHY';
      }

      let auditState: 'HEALTHY' | 'FAILED' = 'HEALTHY';
      try {
        const verification = await verifyAuditChain(db, organizationId, { limit: 5_000 });
        if (!verification.ok) auditState = 'FAILED';
      } catch {
        auditState = 'FAILED';
      }

      return reply.send({
        api: { state: 'HEALTHY' },
        database: { state: dbState },
        marketData: {
          state: marketState,
          provider: connection.providerId ?? null,
          mode: connection.mode,
          delaySeconds: connection.delaySeconds ?? null,
          connection: connection.state,
          lastQuoteExchangeTs: quote?.exchangeTs ?? null,
          ageMs: freshness.ageMs ?? null,
          blocksOrderEntry: freshness.blocksOrderEntry === true,
        },
        audit: { state: auditState },
        build: {
          nodeEnv: process.env.NODE_ENV ?? 'development',
          version: process.env.ATLAS_BUILD ?? null,
          at: Date.now(),
        },
      });
    });
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

type UserRow = typeof users.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;
type ProfileRow = typeof accountProfiles.$inferSelect;
type VersionRow = typeof accountProfileVersions.$inferSelect;
type AuditRow = typeof auditLog.$inferSelect;
type OrderRow = typeof orders.$inferSelect;

function presentUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.getTime(),
    lastLoginAt: user.lastLoginAt?.getTime() ?? null,
  };
}

function presentAccountRow(
  account: AccountRow,
  profile: ProfileRow | null,
  version: VersionRow | null,
) {
  return {
    id: account.id,
    publicId: account.publicId,
    name: account.name,
    accountType: account.accountType,
    status: account.status,
    product:
      profile && version
        ? { key: profile.key, name: profile.name, version: version.version }
        : null,
    startingBalanceMicros: account.startingBalanceMicros,
    balanceMicros: account.balanceMicros,
    realizedPnlMicros: account.realizedPnlMicros,
    feesMicros: account.feesMicros,
    highWaterMarkMicros: account.highWaterMarkMicros,
    drawdownFloorMicros: account.drawdownFloorMicros,
    tradingDaysCount: account.tradingDaysCount,
    failedReason: account.failedReason,
    externalMetadata: account.externalMetadata ?? null,
    instrumentLimits: account.instrumentLimits ?? null,
    activatedAt: account.activatedAt?.getTime() ?? null,
    createdAt: account.createdAt.getTime(),
  };
}

function presentDraft(draft: {
  id: string;
  profileId: string | null;
  key: string;
  name: string;
  accountType: string;
  description: string | null;
  config: unknown;
  notes: string | null;
  baseVersion: number | null;
  updatedByUserId: string | null;
  updatedAt: Date;
}) {
  return {
    id: draft.id,
    profileId: draft.profileId,
    key: draft.key,
    name: draft.name,
    accountType: draft.accountType,
    description: draft.description,
    config: draft.config,
    notes: draft.notes,
    baseVersion: draft.baseVersion,
    updatedByUserId: draft.updatedByUserId,
    updatedAt: draft.updatedAt.getTime(),
  };
}

function presentAudit(row: AuditRow) {
  return {
    id: row.id,
    action: row.action,
    actor: { type: row.actorType, userId: row.actorUserId, label: row.actorLabel },
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    accountId: row.accountId,
    userId: row.userId,
    prevState: row.prevState,
    newState: row.newState,
    reason: row.reason,
    at: row.createdAt.getTime(),
  };
}

function presentAdminOrder(order: OrderRow) {
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    qty: order.qty,
    filledQty: order.filledQty,
    status: order.status,
    limitPrice: order.limitTicks === null ? null : priceOf(order.symbol, order.limitTicks),
    stopPrice: order.stopTicks === null ? null : priceOf(order.symbol, order.stopTicks),
    rejectReason: order.rejectReason,
    createdAt: order.createdAt.getTime(),
  };
}

/** Ticks are the storage unit; an operator reads prices. */
function priceOf(symbol: string, ticks: number): number | null {
  try {
    const spec = requireInstrument(symbol);
    return (ticks * spec.tickSizeScaled) / 10 ** spec.pricePrecision;
  } catch {
    return null;
  }
}

async function recordUserChange(
  organizationId: string,
  actor: Actor,
  user: UserRow,
  action: string,
  reason: string,
  newState: Record<string, unknown>,
): Promise<void> {
  const { db } = getDb();
  await recordAudit(db, {
    organizationId,
    actor,
    subjectType: 'USER',
    subjectId: user.id,
    userId: user.id,
    action,
    prevState: { status: user.status, role: user.role },
    newState,
    reason,
  });
  if (action === 'user.disabled' || action === 'user.enabled') {
    await events.publish(db, {
      type: action === 'user.disabled' ? 'user.disabled' : 'user.enabled',
      organizationId,
      userId: user.id,
      payload: { email: user.email },
    });
  }
}

async function recordProfilePublication(
  organizationId: string,
  actor: Actor,
  published: { profileId: string; profileKey: string; version: number },
): Promise<void> {
  const { db } = getDb();
  await recordAudit(db, {
    organizationId,
    actor,
    subjectType: 'PROFILE',
    subjectId: published.profileId,
    action: 'profile.version_published',
    newState: { key: published.profileKey, version: published.version },
  });
  await events.publish(db, {
    type: 'profile.version_published',
    organizationId,
    payload: { key: published.profileKey, version: published.version },
  });
}
