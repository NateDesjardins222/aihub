/**
 * /api/v1/orders, /positions, /trades, /executions
 *
 * A thin, validating shell over the engine. It converts human decimal prices
 * into integer ticks at the boundary and converts nothing back the other way
 * without the instrument's own specification. It makes no trading decisions.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { orderModifySchema, orderRequestSchema } from '@atlas/contracts';
import {
  getInstrument,
  microsToTicks,
  priceToTicks,
  requireInstrument,
  ticksPerPoint,
  ticksToPrice,
  MICROS,
} from '@atlas/instruments';
import { normalizeEnvironment, unrealizedPnlMicros } from '@atlas/core';
import { ApiError } from '../errors.js';
import { requireUser } from '../auth-plugin.js';
import { getDb } from '../../db/client.js';
import { assertNotEngaged } from '../../platform/kill-switches.js';
import {
  accounts,
  dailyAccountStats,
  executions,
  orders,
  positions,
  ruleTemplates,
  trades,
  userDrawings,
  userPreferences,
} from '../../db/schema.js';
import { OrderRejectedError, type TradingEngine } from '../../trading/engine.js';
import type { ExecutionProvider } from '../../execution/provider.js';
import { toEnginePosition, unscaleTicks } from '../../trading/mapping.js';
import { offsetToTicks, toTicks } from '../../trading/order-levels.js';
import {
  dailyStats,
  loadAccountAndTemplate,
  normalizeRuleConfig,
  ruleConfigFor,
} from '../../trading/account-rules.js';
import type { MarketDataService } from '../../marketdata/service.js';

const REJECTION_STATUS = 422;

interface Deps {
  readonly engine: TradingEngine;
  readonly market: MarketDataService;
  /**
   * The execution venue. Order flow (submit/cancel/modify/flatten/reverse) routes
   * through this seam, not the concrete engine, so a future live provider slots
   * in without rewriting these routes. Engine-specific concerns that are not a
   * venue's job - marking, valuation, rule enforcement, bracket protection -
   * still use `engine` directly.
   */
  readonly execution: ExecutionProvider;
}

/** Verify the account belongs to the caller before anything else happens. */
async function assertOwnership(userId: string, accountId: string): Promise<void> {
  const { db } = getDb();
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
  if (!row) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
}

function mapRejection(err: unknown): never {
  if (err instanceof OrderRejectedError) {
    throw new ApiError(REJECTION_STATUS, err.reason, err.message, err.detail);
  }
  throw err;
}

export function tradingRoutes(deps: Deps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    // -- orders -----------------------------------------------------------

    app.post(
      '/orders',
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (request, reply) => {
        // M10-F kill switches: block NEW/increasing exposure when engaged, before
        // anything else. The risk-reducing endpoints (cancel, cancel-all, flatten,
        // protect, reverse) are separate routes and are intentionally NOT gated.
        await assertNotEngaged(db, 'MAINTENANCE_MODE');
        await assertNotEngaged(db, 'DISABLE_NEW_ORDERS');

        const body = orderRequestSchema.parse(request.body);
        await assertOwnership(request.user!.id, body.accountId);

        const spec = getInstrument(body.symbol);
        if (!spec) throw ApiError.notFound('UNKNOWN_INSTRUMENT', `No instrument ${body.symbol}.`);

        try {
          const change = await deps.execution.submitOrder({
            accountId: body.accountId,
            userId: request.user!.id,
            clientOrderId: body.clientOrderId,
            symbol: spec.root,
            side: body.side,
            qty: body.qty,
            type: body.type,
            limitTicks: toTicks(spec, body.limitPrice),
            stopTicks: toTicks(spec, body.stopPrice),
            tif: body.tif,
            trailTicks: body.trailTicks ?? null,
            bracket: body.bracket
              ? {
                  stopLossTicks: offsetToTicks(spec, body.bracket.stopLoss, body.qty),
                  takeProfitTicks: offsetToTicks(spec, body.bracket.takeProfit, body.qty),
                  trailingStopTicks: offsetToTicks(spec, body.bracket.trailingStop, body.qty),
                }
              : null,
          });
          return reply.code(201).send(change);
        } catch (err) {
          mapRejection(err);
        }
      },
    );

    app.patch<{ Params: { id: string } }>('/orders/:id', async (request, reply) => {
      const body = orderModifySchema.parse(request.body);
      const query = z.object({ accountId: z.string().uuid() }).parse(request.query);
      await assertOwnership(request.user!.id, query.accountId);

      const [row] = await db
        .select({ symbol: orders.symbol })
        .from(orders)
        .where(and(eq(orders.id, request.params.id), eq(orders.accountId, query.accountId)));
      if (!row) throw ApiError.notFound('ORDER_NOT_FOUND', 'No such order.');
      const spec = requireInstrument(row.symbol);

      try {
        const change = await deps.execution.modifyOrder(
          query.accountId,
          request.params.id,
          {
            ...(body.qty !== undefined ? { qty: body.qty } : {}),
            ...(body.limitPrice !== undefined ? { limitTicks: toTicks(spec, body.limitPrice) } : {}),
            ...(body.stopPrice !== undefined ? { stopTicks: toTicks(spec, body.stopPrice) } : {}),
            ...(body.trailTicks !== undefined ? { trailTicks: body.trailTicks ?? null } : {}),
          },
          body.expectedVersion,
        );
        return reply.send(change);
      } catch (err) {
        mapRejection(err);
      }
    });

    app.delete<{ Params: { id: string } }>('/orders/:id', async (request, reply) => {
      const query = z.object({ accountId: z.string().uuid() }).parse(request.query);
      await assertOwnership(request.user!.id, query.accountId);
      try {
        return reply.send(await deps.execution.cancelOrder(query.accountId, request.params.id));
      } catch (err) {
        mapRejection(err);
      }
    });

    app.post('/orders/cancel-all', async (request, reply) => {
      const body = z
        .object({ accountId: z.string().uuid(), symbol: z.string().max(12).optional() })
        .parse(request.body);
      await assertOwnership(request.user!.id, body.accountId);
      return reply.send(await deps.execution.cancelAll(body.accountId, body.symbol));
    });

    app.get('/orders', async (request, reply) => {
      const query = z
        .object({
          accountId: z.string().uuid(),
          open: z.coerce.boolean().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        })
        .parse(request.query);
      await assertOwnership(request.user!.id, query.accountId);

      const where = query.open
        ? and(
            eq(orders.accountId, query.accountId),
            inArray(orders.status, ['WORKING', 'PARTIALLY_FILLED', 'CANCEL_PENDING']),
          )
        : eq(orders.accountId, query.accountId);

      const rows = await db
        .select()
        .from(orders)
        .where(where)
        .orderBy(desc(orders.createdAt))
        .limit(query.limit);

      return reply.send({
        orders: rows.map((row) => {
          const spec = requireInstrument(row.symbol);
          return {
            ...row,
            limitPrice: row.limitTicks === null ? null : ticksToPrice(spec, row.limitTicks),
            stopPrice: row.stopTicks === null ? null : ticksToPrice(spec, row.stopTicks),
            avgFillPrice:
              row.filledQty === 0
                ? null
                : ticksToPrice(spec, row.fillNotionalMicros / (row.filledQty * spec.tickValueMicros)),
            remainingQty: Math.max(0, row.qty - row.filledQty),
            createdAt: row.createdAt.getTime(),
            updatedAt: row.updatedAt.getTime(),
          };
        }),
      });
    });

    // -- positions --------------------------------------------------------

    app.get('/positions', async (request, reply) => {
      const query = z.object({ accountId: z.string().uuid() }).parse(request.query);
      await assertOwnership(request.user!.id, query.accountId);

      const rows = await db
        .select()
        .from(positions)
        .where(eq(positions.accountId, query.accountId));

      const openOrders = await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.accountId, query.accountId),
            inArray(orders.status, ['WORKING', 'PARTIALLY_FILLED']),
          ),
        );

      const views = rows
        .filter((row) => row.qty !== 0)
        .map((row) => {
          const spec = requireInstrument(row.symbol);
          const position = toEnginePosition(row, row.symbol);
          const markTicks = deps.engine.markTicks(spec);
          const protective = openOrders.filter((o) => o.symbol === row.symbol);
          const avg = position.qty === 0 ? null : position.costBasisMicros / (position.qty * spec.tickValueMicros);
          return {
            symbol: row.symbol,
            side: row.side,
            qty: Math.abs(row.qty),
            signedQty: row.qty,
            avgEntryTicks: avg,
            avgEntryPrice: avg === null ? null : ticksToPrice(spec, avg),
            markTicks,
            markPrice: markTicks === null ? null : ticksToPrice(spec, markTicks),
            unrealizedPnlMicros: unrealizedPnlMicros(spec, position, markTicks),
            realizedPnlMicros: row.realizedPnlMicros,
            feesMicros: row.feesMicros,
            openedAt: row.openedAt?.getTime() ?? null,
            updatedAt: row.updatedAt.getTime(),
            stopOrderId: protective.find((o) => o.bracketRole === 'STOP_LOSS')?.id ?? null,
            targetOrderId: protective.find((o) => o.bracketRole === 'TAKE_PROFIT')?.id ?? null,
          };
        });

      return reply.send({ positions: views });
    });

    app.post<{ Params: { symbol: string } }>('/positions/:symbol/flatten', async (request, reply) => {
      const body = z.object({ accountId: z.string().uuid() }).parse(request.body);
      await assertOwnership(request.user!.id, body.accountId);
      try {
        return reply.send(
          await deps.execution.flatten(body.accountId, request.user!.id, request.params.symbol.toUpperCase()),
        );
      } catch (err) {
        mapRejection(err);
      }
    });

    /**
     * Attach, move or remove a position's protective orders.
     *
     * Prices come in as decimals because that is what the chart and the ticket
     * have; they are snapped to the instrument's tick grid here, where the
     * specification lives, rather than trusted from the client. `null` removes
     * a leg and an omitted field leaves it alone - so moving a stop cannot
     * silently cancel a target.
     */
    app.post<{ Params: { symbol: string } }>('/positions/:symbol/protect', async (request, reply) => {
      const body = z
        .object({
          accountId: z.string().uuid(),
          stopPrice: z.number().positive().nullable().optional(),
          targetPrice: z.number().positive().nullable().optional(),
        })
        .parse(request.body);
      await assertOwnership(request.user!.id, body.accountId);
      const spec = requireInstrument(request.params.symbol.toUpperCase());
      const toTicks = (price: number | null | undefined): number | null | undefined =>
        price === undefined || price === null ? price : priceToTicks(spec, price);

      try {
        return reply.send(
          await deps.engine.setProtection(body.accountId, request.user!.id, spec.root, {
            stopTicks: toTicks(body.stopPrice),
            targetTicks: toTicks(body.targetPrice),
          }),
        );
      } catch (err) {
        mapRejection(err);
      }
    });

    app.post<{ Params: { symbol: string } }>('/positions/:symbol/reverse', async (request, reply) => {
      const body = z.object({ accountId: z.string().uuid() }).parse(request.body);
      await assertOwnership(request.user!.id, body.accountId);
      try {
        return reply.send(
          await deps.execution.reverse(body.accountId, request.user!.id, request.params.symbol.toUpperCase()),
        );
      } catch (err) {
        mapRejection(err);
      }
    });

    // -- history ----------------------------------------------------------

    app.get('/trades', async (request, reply) => {
      const query = z
        .object({ accountId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(500).default(200) })
        .parse(request.query);
      await assertOwnership(request.user!.id, query.accountId);

      const rows = await db
        .select()
        .from(trades)
        .where(eq(trades.accountId, query.accountId))
        .orderBy(desc(trades.exitTime))
        .limit(query.limit);

      return reply.send({
        trades: rows.map((row) => {
          const spec = requireInstrument(row.symbol);
          return {
            id: row.id,
            symbol: row.symbol,
            side: row.side,
            qty: row.qty,
            entryPrice: ticksToPrice(spec, unscaleTicks(row.entryTicksScaled)),
            exitPrice: ticksToPrice(spec, unscaleTicks(row.exitTicksScaled)),
            entryTime: row.entryTime.getTime(),
            exitTime: row.exitTime.getTime(),
            grossPnlMicros: row.grossPnlMicros,
            feesMicros: row.feesMicros,
            netPnlMicros: row.netPnlMicros,
            tradeDate: row.tradeDate,
          };
        }),
      });
    });

    app.get('/executions', async (request, reply) => {
      const query = z
        .object({ accountId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(500).default(200) })
        .parse(request.query);
      await assertOwnership(request.user!.id, query.accountId);

      const rows = await db
        .select()
        .from(executions)
        .where(eq(executions.accountId, query.accountId))
        .orderBy(desc(executions.execTime))
        .limit(query.limit);

      return reply.send({
        executions: rows.map((row) => {
          const spec = requireInstrument(row.symbol);
          return {
            id: row.id,
            orderId: row.orderId,
            symbol: row.symbol,
            side: row.side,
            qty: row.qty,
            price: ticksToPrice(spec, row.priceTicks),
            feesMicros: row.feesMicros,
            slippageTicks: row.slippageTicks,
            liquidity: row.liquidity,
            execTime: row.execTime.getTime(),
            seq: row.seq,
          };
        }),
      });
    });

    // -- account P&L ------------------------------------------------------

    /** Equity = settled balance + open P&L. Computed here, never in the browser. */
    app.get('/accounts/:id/pnl', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      await assertOwnership(request.user!.id, params.id);

      /*
       * ONE source of truth.
       *
       * This route used to re-derive equity, day P&L and the drawdown from the
       * account row itself. Two implementations of the same arithmetic is two
       * answers to "what is my P&L", and the trader sees whichever one the
       * screen happens to read. It now reports the engine's valuation - the
       * same figures the rules are enforced on.
       */
      const valuation = await deps.engine.valuation(params.id);
      if (!valuation) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
      const loaded = await loadAccountAndTemplate(db, params.id);
      if (!loaded?.template) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
      const { account, template } = loaded;

      return reply.send({
        accountId: params.id,
        status: account.status,
        startingBalanceMicros: account.startingBalanceMicros,
        balanceMicros: valuation.balanceMicros,
        // Null when the account holds a position the platform cannot price.
        // The terminal shows these as unknown rather than as a number.
        equityMicros: valuation.equityMicros,
        openPnlMicros: valuation.openPnlMicros,
        realizedPnlMicros: valuation.realizedPnlMicros,
        feesMicros: valuation.feesMicros,
        dayPnlMicros: valuation.dayPnlMicros,
        drawdownFloorMicros: valuation.rules.drawdownFloorMicros,
        remainingDrawdownMicros: valuation.remainingDrawdownMicros,
        profitTargetProgressMicros: account.balanceMicros - account.startingBalanceMicros,
        profitTargetMicros: template.profitTargetMicros,
        openContracts: valuation.openContracts,
        maxContracts: template.maxContracts,
        /** False while a position cannot be priced: every P&L figure is null. */
        marked: valuation.rules.marked,
        unmarkable: valuation.unmarkable,
        // Whether a breached account is flat, still flattening, or never
        // flattens — so the terminal never says only "locked" while exposed.
        liquidation: valuation.liquidation,
        seq: account.seq,
      });
    });

    app.get('/accounts/:id/rules', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      await assertOwnership(request.user!.id, params.id);

      const loaded = await loadAccountAndTemplate(db, params.id);
      if (!loaded) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');

      const valuation = await deps.engine.valuation(params.id);
      const days = await dailyStats(db, params.id, 30);

      return reply.send({
        accountId: params.id,
        config: ruleConfigFor(loaded.account, loaded.template),
        templateName: loaded.template?.name ?? null,
        status: valuation?.rules ?? null,
        account: {
          startingBalanceMicros: loaded.account.startingBalanceMicros,
          highWaterMarkMicros: loaded.account.highWaterMarkMicros,
          drawdownFloorMicros: loaded.account.drawdownFloorMicros,
          currentTradeDate: loaded.account.currentTradeDate,
          lockedUntilDate: loaded.account.lockedUntilDate,
          failedReason: loaded.account.failedReason,
        },
        days: days.map((d) => ({
          tradeDate: d.tradeDate,
          startingBalanceMicros: d.startingBalanceMicros,
          endingBalanceMicros: d.endingBalanceMicros,
          realizedPnlMicros: d.realizedPnlMicros,
          counted: d.counted,
        })),
      });
    });

    /**
     * Change one account's rules.
     *
     * Stored as an OVERRIDE rather than by editing the programme's template:
     * two traders on the same programme must not change each other's terms, and
     * the template is what says what the programme is.
     */
    app.put('/accounts/:id/rules', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      await assertOwnership(request.user!.id, params.id);

      const patch = z
        .object({
          profitTargetMicros: z.number().int().min(0).optional(),
          maxLossMicros: z.number().int().min(0).optional(),
          drawdownType: z.enum(['STATIC', 'INTRADAY_TRAILING', 'EOD_TRAILING']).optional(),
          trailingLockAtMicros: z.number().int().min(0).nullable().optional(),
          dailyLossLimitMicros: z.number().int().min(1).nullable().optional(),
          dailyLossPolicy: z.enum(['LOCK_DAY', 'FAIL']).optional(),
          consistencyFormula: z.enum(['BEST_DAY_OVER_TOTAL', 'BEST_DAY_OVER_TARGET']).optional(),
          consistencyThreshold: z.number().min(0.01).max(1).nullable().optional(),
          minTradingDays: z.number().int().min(0).max(365).optional(),
          minWinningDays: z.number().int().min(0).max(365).optional(),
          maxTradingDays: z.number().int().min(1).max(365).nullable().optional(),
          minDailyPnlToCountMicros: z.number().int().min(0).optional(),
          minWinningDayPnlMicros: z.number().int().min(1).optional(),
          maxContracts: z.number().int().min(1).max(1000).optional(),
          flattenOnBreach: z.boolean().optional(),
        })
        .strict()
        .parse(request.body);

      const loaded = await loadAccountAndTemplate(db, params.id);
      if (!loaded) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');

      const merged = normalizeRuleConfig({
        ...ruleConfigFor(loaded.account, loaded.template),
        ...patch,
      });
      await db
        .update(accounts)
        .set({ ruleOverrides: merged as never, updatedAt: new Date() })
        .where(eq(accounts.id, params.id));

      // Re-evaluate at once: a tightened rule that is already broken must take
      // effect now, not on the next tick.
      const status = await deps.engine.enforceRules(params.id);
      return reply.send({ config: merged, status });
    });

    /**
     * Start the programme again.
     *
     * A failed account is final - that is the whole point of a breach, and
     * nothing the trader does afterwards may revive it. A SIMULATOR still has
     * to let them take the evaluation again, so this is an explicit reset that
     * clears the account back to its opening state: balance, drawdown anchor,
     * day counters and history all go. It is destructive and says so.
     */
    app.post('/accounts/:id/reset', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          // Practice at the size you are actually going to trade. Omitted, the
          // account starts again at the size it was created with.
          startingBalanceMicros: z
            .number()
            .int()
            .min(1_000 * 1_000_000)
            .max(10_000_000 * 1_000_000)
            .optional(),
        })
        .strict()
        .parse(request.body ?? {});
      await assertOwnership(request.user!.id, params.id);

      const loaded = await loadAccountAndTemplate(db, params.id);
      if (!loaded) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
      const { account } = loaded;
      const config = ruleConfigFor(account, loaded.template);
      const size = body.startingBalanceMicros ?? account.startingBalanceMicros;

      await db.transaction(async (tx) => {
        // Working orders and open positions belong to the account that had
        // them; a reset account starts flat, with no history to reconcile.
        await tx.delete(executions).where(eq(executions.accountId, params.id));
        await tx.delete(trades).where(eq(trades.accountId, params.id));
        await tx.delete(orders).where(eq(orders.accountId, params.id));
        await tx.delete(positions).where(eq(positions.accountId, params.id));
        await tx.delete(dailyAccountStats).where(eq(dailyAccountStats.accountId, params.id));
        await tx
          .update(accounts)
          .set({
            status: 'ACTIVE',
            startingBalanceMicros: size,
            balanceMicros: size,
            realizedPnlMicros: 0,
            feesMicros: 0,
            highWaterMarkMicros: size,
            drawdownFloorMicros: config.maxLossMicros > 0 ? size - config.maxLossMicros : 0,
            dayStartBalanceMicros: size,
            dayStartEquityMicros: size,
            tradingDaysCount: 0,
            winningDaysCount: 0,
            bestDayProfitMicros: 0,
            currentTradeDate: null,
            lockedUntilDate: null,
            failedReason: null,
            updatedAt: new Date(),
          })
          .where(eq(accounts.id, params.id));
      });

      const status = await deps.engine.enforceRules(params.id);
      return reply.send({ accountId: params.id, status });
    });

    // -- preferences -------------------------------------------------------

    /**
     * Where a trader's display choices live between sessions.
     *
     * Deliberately opaque to the server: chart motion, which panels are open,
     * which training mode was last used. None of it can affect execution, so
     * none of it is validated beyond a size limit - the client owns its own
     * shape, and a preference the server does not understand is one it cannot
     * break.
     */
    app.get('/preferences', async (request, reply) => {
      const [row] = await db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, request.user!.id));
      return reply.send({ preferences: row?.preferences ?? {} });
    });

    app.put('/preferences', async (request, reply) => {
      const body = z.record(z.string(), z.unknown()).parse(request.body);
      const encoded = JSON.stringify(body);
      if (encoded.length > 64_000) {
        throw ApiError.badRequest('PREFERENCES_TOO_LARGE', 'Preferences are limited to 64 KB.');
      }

      const [row] = await db
        .insert(userPreferences)
        .values({ userId: request.user!.id, preferences: body as never })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: { preferences: body as never, updatedAt: new Date() },
        })
        .returning();
      return reply.send({ preferences: row!.preferences });
    });


    /**
     * Drawings, in storage of their own.
     *
     * Presentation, like the preferences, and just as opaque to the server -
     * but with a limit that matches what it holds. A marked-up chart is
     * hundreds of objects and passes the preference budget on its own; sharing
     * one meant a trader who drew a lot lost their motion settings too.
     *
     * The limit is still a limit, and exceeding it is an ERROR the client is
     * told about rather than a save that quietly does not happen.
     */
    app.get('/drawings', async (request, reply) => {
      const [row] = await db
        .select()
        .from(userDrawings)
        .where(eq(userDrawings.userId, request.user!.id));
      return reply.send({ drawings: row?.drawings ?? null });
    });

    /*
     * Its own body limit, above the application's.
     *
     * The app allows 512 KB, which is generous for a request that carries an
     * order and far too little for a marked-up chart. Without this the server
     * would answer a large save with a bare 413 from the framework instead of
     * the message below, and the trader would never learn what to do about it.
     */
    app.put('/drawings', { bodyLimit: 1_100_000 }, async (request, reply) => {
      const body = z.object({ drawings: z.array(z.unknown()).max(2_000) }).parse(request.body);
      const encoded = JSON.stringify(body.drawings);
      if (encoded.length > 1_000_000) {
        throw ApiError.badRequest(
          'DRAWINGS_TOO_LARGE',
          'This chart has more drawings than can be saved. Remove some objects.',
        );
      }

      const [row] = await db
        .insert(userDrawings)
        .values({ userId: request.user!.id, drawings: body.drawings as never })
        .onConflictDoUpdate({
          target: userDrawings.userId,
          set: { drawings: body.drawings as never, updatedAt: new Date() },
        })
        .returning();
      return reply.send({ drawings: row!.drawings });
    });

    // -- environment settings ---------------------------------------------

    app.get('/accounts/:id/environment', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      await assertOwnership(request.user!.id, params.id);
      const [row] = await db
        .select({ env: accounts.simulationEnvironment })
        .from(accounts)
        .where(eq(accounts.id, params.id));
      return reply.send({
        environment: normalizeEnvironment((row?.env ?? null) as never),
        depthLevels: deps.market.currentProvider.depthLevels,
        depthAwareAvailable: deps.market.currentProvider.depthLevels > 1,
      });
    });

    app.put('/accounts/:id/environment', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      await assertOwnership(request.user!.id, params.id);

      const patch = z
        .object({
          fillModel: z.enum(['SIMPLE', 'ADVANCED', 'DEPTH_AWARE']).optional(),
          useBarRange: z.boolean().optional(),
          intrabarPolicy: z.enum(['ADVERSE_FIRST', 'OBSERVED_ONLY']).optional(),
          latencyMs: z.number().int().min(0).max(60_000).optional(),
          marketSlippageTicks: z.number().int().min(0).max(100).optional(),
          stopSlippageTicks: z.number().int().min(0).max(100).optional(),
          maxContractsPerFill: z.number().int().min(1).max(1000).nullable().optional(),
          requireThroughTradeForLimit: z.boolean().optional(),
          feesEnabled: z.boolean().optional(),
          commissionPerSideMicrosOverride: z.number().int().min(0).nullable().optional(),
        })
        .parse(request.body);

      if (patch.fillModel === 'DEPTH_AWARE' && deps.market.currentProvider.depthLevels <= 1) {
        throw ApiError.badRequest(
          'FILL_MODEL_UNAVAILABLE',
          'Depth-aware filling needs a market data feed with Level 2 depth. ' +
            'The development feed provides none, so this model cannot be honoured.',
        );
      }

      const [current] = await db
        .select({ env: accounts.simulationEnvironment })
        .from(accounts)
        .where(eq(accounts.id, params.id));
      const merged = normalizeEnvironment({
        ...((current?.env ?? {}) as object),
        ...patch,
      } as never);

      await db
        .update(accounts)
        .set({ simulationEnvironment: merged as never, updatedAt: new Date() })
        .where(eq(accounts.id, params.id));

      return reply.send({ environment: merged });
    });
  };
}
