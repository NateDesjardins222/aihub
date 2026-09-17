/**
 * The trading journal: trades, tags, notes, sessions and analytics.
 *
 * Everything here READS trading state and adds the trader's own record on top
 * of it. No route in this file can change a position, an order or a balance -
 * journalling must never be able to alter what happened, only describe it.
 *
 * The analytics are computed on demand from the stored trades rather than
 * maintained as running totals. A journal that keeps its own counters drifts
 * from the trades it claims to summarize, and the trades are the thing a trader
 * can check.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { getInstrument } from '@atlas/instruments';
import { analyze, type TradeRecord } from '@atlas/core';
import { ApiError } from '../errors.js';
import { requireUser } from '../auth-plugin.js';
import { getDb } from '../../db/client.js';
import {
  accounts,
  practiceSessions,
  riskEvents,
  sessionTagLinks,
  tradeTagLinks,
  tradeTags,
  trades,
} from '../../db/schema.js';
import { unscaleTicks } from '../../trading/mapping.js';
import type { TradingEngine } from '../../trading/engine.js';
import type { ReplayProvider } from '../../marketdata/providers/replay.js';

interface Deps {
  readonly engine: TradingEngine;
  /**
   * The replay, for one purpose: recording WHICH session was practised.
   *
   * A blind session is masked in the API, so the client genuinely does not
   * know what it is trading and cannot tell the journal. The server does know,
   * and has to write it down - otherwise the reveal at the end has nothing to
   * reveal, and the session history is a list of unknowns.
   */
  readonly replay: ReplayProvider;
}

/** A trade as the journal serves it: prices decoded, tags attached. */
function presentTrade(
  row: typeof trades.$inferSelect,
  tagIds: string[],
): Record<string, unknown> {
  const spec = getInstrument(row.symbol);
  const entryTicks = unscaleTicks(row.entryTicksScaled);
  const exitTicks = unscaleTicks(row.exitTicksScaled);
  const tickSize = spec ? spec.tickSizeScaled / 10 ** spec.pricePrecision : 0.25;

  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    qty: row.qty,
    entryPrice: Number((entryTicks * tickSize).toFixed(spec?.pricePrecision ?? 2)),
    exitPrice: Number((exitTicks * tickSize).toFixed(spec?.pricePrecision ?? 2)),
    entryTime: row.entryTime.getTime(),
    exitTime: row.exitTime.getTime(),
    holdMs: row.exitTime.getTime() - row.entryTime.getTime(),
    grossPnlMicros: row.grossPnlMicros,
    feesMicros: row.feesMicros,
    netPnlMicros: row.netPnlMicros,
    maeMicros: row.maeMicros,
    mfeMicros: row.mfeMicros,
    initialRiskMicros: row.initialRiskMicros,
    rMultiple:
      row.initialRiskMicros && row.initialRiskMicros > 0
        ? row.netPnlMicros / row.initialRiskMicros
        : null,
    tradeDate: row.tradeDate,
    sessionId: row.sessionId,
    notes: row.notes,
    tagIds,
  };
}

/** Trades in the shape the analytics module wants, with exchange-local time. */
function toRecords(rows: Array<typeof trades.$inferSelect>): TradeRecord[] {
  return rows.map((row) => {
    const spec = getInstrument(row.symbol);
    const zone = spec?.sessionTimezone ?? 'America/Chicago';
    // Time of day is only meaningful in the market's own timezone: the same
    // trade is not at a different hour because the trader moved house.
    const local = DateTime.fromMillis(row.entryTime.getTime(), { zone });
    return {
      id: row.id,
      symbol: row.symbol,
      side: row.side === 'SHORT' ? 'SHORT' : 'LONG',
      qty: row.qty,
      entryTime: row.entryTime.getTime(),
      exitTime: row.exitTime.getTime(),
      grossPnlMicros: row.grossPnlMicros,
      feesMicros: row.feesMicros,
      netPnlMicros: row.netPnlMicros,
      maeMicros: row.maeMicros,
      mfeMicros: row.mfeMicros,
      initialRiskMicros: row.initialRiskMicros,
      tradeDate: row.tradeDate,
      hourOfDay: local.hour,
      dayOfWeek: local.weekday % 7,
    };
  });
}

export function journalRoutes(deps: Deps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    async function assertOwnership(userId: string, accountId: string): Promise<void> {
      const [row] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
      if (!row) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
    }

    async function tagsFor(tradeIds: string[]): Promise<Map<string, string[]>> {
      const out = new Map<string, string[]>();
      if (tradeIds.length === 0) return out;
      const links = await db
        .select()
        .from(tradeTagLinks)
        .where(inArray(tradeTagLinks.tradeId, tradeIds));
      for (const link of links) {
        const list = out.get(link.tradeId);
        if (list) list.push(link.tagId);
        else out.set(link.tradeId, [link.tagId]);
      }
      return out;
    }

    async function loadTrades(
      accountId: string,
      filters: { from?: string; to?: string; symbol?: string; sessionId?: string; limit: number },
    ) {
      const where = [eq(trades.accountId, accountId)];
      if (filters.from) where.push(gte(trades.tradeDate, filters.from));
      if (filters.to) where.push(lte(trades.tradeDate, filters.to));
      if (filters.symbol) where.push(eq(trades.symbol, filters.symbol.toUpperCase()));
      if (filters.sessionId) where.push(eq(trades.sessionId, filters.sessionId));
      return db
        .select()
        .from(trades)
        .where(and(...where))
        .orderBy(desc(trades.exitTime))
        .limit(filters.limit);
    }

    // -- trades ------------------------------------------------------------

    app.get('/trades', async (request, reply) => {
      const query = z
        .object({
          accountId: z.string().uuid(),
          from: z.string().optional(),
          to: z.string().optional(),
          symbol: z.string().optional(),
          sessionId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(5_000).default(500),
        })
        .parse(request.query);
      await assertOwnership(request.user!.id, query.accountId);

      const rows = await loadTrades(query.accountId, query);
      const tags = await tagsFor(rows.map((r) => r.id));
      return reply.send({
        trades: rows.map((row) => presentTrade(row, tags.get(row.id) ?? [])),
      });
    });

    app.patch<{ Params: { id: string } }>('/trades/:id', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({ notes: z.string().max(4_000).nullable().optional() })
        .strict()
        .parse(request.body);

      const [row] = await db.select().from(trades).where(eq(trades.id, params.id));
      if (!row) throw ApiError.notFound('TRADE_NOT_FOUND', 'No such trade.');
      await assertOwnership(request.user!.id, row.accountId);

      if (body.notes !== undefined) {
        await db.update(trades).set({ notes: body.notes }).where(eq(trades.id, params.id));
      }
      const [updated] = await db.select().from(trades).where(eq(trades.id, params.id));
      const tags = await tagsFor([params.id]);
      return reply.send({ trade: presentTrade(updated!, tags.get(params.id) ?? []) });
    });

    /** Replace a trade's tags wholesale: the UI edits them as a set. */
    app.put<{ Params: { id: string } }>('/trades/:id/tags', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({ tagIds: z.array(z.string().uuid()).max(30) })
        .strict()
        .parse(request.body);

      const [row] = await db.select().from(trades).where(eq(trades.id, params.id));
      if (!row) throw ApiError.notFound('TRADE_NOT_FOUND', 'No such trade.');
      await assertOwnership(request.user!.id, row.accountId);

      // Only the trader's own tags, so one account cannot attach another's.
      const owned = await db
        .select({ id: tradeTags.id })
        .from(tradeTags)
        .where(eq(tradeTags.userId, request.user!.id));
      const allowed = new Set(owned.map((t) => t.id));
      const tagIds = body.tagIds.filter((id) => allowed.has(id));

      await db.transaction(async (tx) => {
        await tx.delete(tradeTagLinks).where(eq(tradeTagLinks.tradeId, params.id));
        if (tagIds.length > 0) {
          await tx.insert(tradeTagLinks).values(tagIds.map((tagId) => ({ tradeId: params.id, tagId })));
        }
      });

      return reply.send({ tradeId: params.id, tagIds });
    });

    // -- tags --------------------------------------------------------------

    app.get('/tags', async (request, reply) => {
      const rows = await db
        .select()
        .from(tradeTags)
        .where(eq(tradeTags.userId, request.user!.id))
        .orderBy(tradeTags.sort, tradeTags.name);
      return reply.send({ tags: rows });
    });

    app.post('/tags', async (request, reply) => {
      const body = z
        .object({
          name: z.string().min(1).max(40),
          color: z.string().max(16).default('slate'),
          kind: z.enum(['GOOD', 'BAD', 'NEUTRAL']).default('NEUTRAL'),
          sort: z.number().int().min(0).max(999).default(0),
        })
        .strict()
        .parse(request.body);

      try {
        const [row] = await db
          .insert(tradeTags)
          .values({ ...body, userId: request.user!.id })
          .returning();
        return reply.code(201).send({ tag: row });
      } catch {
        throw ApiError.badRequest('TAG_EXISTS', 'You already have a tag with that name.');
      }
    });

    app.patch<{ Params: { id: string } }>('/tags/:id', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          name: z.string().min(1).max(40).optional(),
          color: z.string().max(16).optional(),
          kind: z.enum(['GOOD', 'BAD', 'NEUTRAL']).optional(),
          sort: z.number().int().min(0).max(999).optional(),
        })
        .strict()
        .parse(request.body);

      const [row] = await db
        .update(tradeTags)
        .set(body)
        .where(and(eq(tradeTags.id, params.id), eq(tradeTags.userId, request.user!.id)))
        .returning();
      if (!row) throw ApiError.notFound('TAG_NOT_FOUND', 'No such tag.');
      return reply.send({ tag: row });
    });

    app.delete<{ Params: { id: string } }>('/tags/:id', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const [row] = await db
        .delete(tradeTags)
        .where(and(eq(tradeTags.id, params.id), eq(tradeTags.userId, request.user!.id)))
        .returning();
      if (!row) throw ApiError.notFound('TAG_NOT_FOUND', 'No such tag.');
      return reply.send({ deleted: row.id });
    });

    // -- analytics ---------------------------------------------------------

    app.get('/analytics', async (request, reply) => {
      const query = z
        .object({
          accountId: z.string().uuid(),
          from: z.string().optional(),
          to: z.string().optional(),
          symbol: z.string().optional(),
          sessionId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(20_000).default(5_000),
        })
        .parse(request.query);
      await assertOwnership(request.user!.id, query.accountId);

      const [account] = await db.select().from(accounts).where(eq(accounts.id, query.accountId));
      const rows = await loadTrades(query.accountId, query);
      const analytics = analyze(toRecords(rows), account?.startingBalanceMicros ?? 0);

      return reply.send({
        accountId: query.accountId,
        startingBalanceMicros: account?.startingBalanceMicros ?? 0,
        ...analytics,
      });
    });

    // -- practice sessions -------------------------------------------------

    app.get('/sessions', async (request, reply) => {
      const query = z
        .object({
          accountId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      await assertOwnership(request.user!.id, query.accountId);

      const rows = await db
        .select()
        .from(practiceSessions)
        .where(eq(practiceSessions.accountId, query.accountId))
        .orderBy(desc(practiceSessions.startedAt))
        .limit(query.limit);

      return reply.send({ sessions: rows.map(presentSession) });
    });

    app.get('/sessions/active', async (request, reply) => {
      const query = z.object({ accountId: z.string().uuid() }).parse(request.query);
      await assertOwnership(request.user!.id, query.accountId);
      const [row] = await db
        .select()
        .from(practiceSessions)
        .where(
          and(
            eq(practiceSessions.accountId, query.accountId),
            isNull(practiceSessions.endedAt),
          ),
        )
        .orderBy(desc(practiceSessions.startedAt))
        .limit(1);
      return reply.send({ session: row ? presentSession(row) : null });
    });

    /**
     * Open a session.
     *
     * Only one at a time per account: a trade belongs to exactly one sitting,
     * and an account with two open sessions could not say which. Starting a new
     * one closes whatever was still open.
     */
    app.post('/sessions', async (request, reply) => {
      const body = z
        .object({
          accountId: z.string().uuid(),
          source: z.enum(['LIVE', 'REPLAY']).default('REPLAY'),
          mode: z.string().max(24).default('STANDARD'),
          config: z.record(z.string(), z.unknown()).optional(),
          recordingId: z.string().max(120).nullable().optional(),
          symbol: z.string().max(12).nullable().optional(),
          tradingDate: z.string().max(10).nullable().optional(),
          dateHidden: z.boolean().default(false),
        })
        .strict()
        .parse(request.body);
      await assertOwnership(request.user!.id, body.accountId);

      const [account] = await db.select().from(accounts).where(eq(accounts.id, body.accountId));
      if (!account) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');

      const open = await db
        .select()
        .from(practiceSessions)
        .where(
          and(eq(practiceSessions.accountId, body.accountId), isNull(practiceSessions.endedAt)),
        );
      for (const previous of open) await endSession(previous.id);

      // What is actually loaded wins over what the client thinks: a blind
      // session's client has been told nothing, on purpose.
      const replayState = deps.replay.getState();
      const fromReplay =
        body.source === 'REPLAY' && replayState.loaded
          ? {
              recordingId: replayState.recordingId,
              symbol: replayState.symbol,
              tradingDate: replayState.header?.tradingDate ?? null,
            }
          : { recordingId: null, symbol: null, tradingDate: null };

      const [row] = await db
        .insert(practiceSessions)
        .values({
          accountId: body.accountId,
          userId: request.user!.id,
          source: body.source,
          mode: body.mode,
          config: (body.config ?? {}) as never,
          recordingId: body.recordingId ?? fromReplay.recordingId,
          symbol: body.symbol ?? fromReplay.symbol,
          tradingDate: body.tradingDate ?? fromReplay.tradingDate,
          // A session the trader cannot identify is hidden until it ends,
          // whether they asked for that or the replay imposed it.
          dateHidden: body.dateHidden || replayState.blind,
          startingBalanceMicros: account.balanceMicros,
        })
        .returning();
      return reply.code(201).send({ session: presentSession(row!) });
    });

    app.post<{ Params: { id: string } }>('/sessions/:id/end', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const [row] = await db
        .select()
        .from(practiceSessions)
        .where(eq(practiceSessions.id, params.id));
      if (!row) throw ApiError.notFound('SESSION_NOT_FOUND', 'No such session.');
      await assertOwnership(request.user!.id, row.accountId);

      const session = await endSession(params.id);
      // The replay stops withholding too: the trader has finished, and the
      // whole point of the reveal is to compare what they did with what it was.
      deps.replay.reveal();
      return reply.send({ session: presentSession(session!) });
    });

    app.patch<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          notes: z.string().max(8_000).nullable().optional(),
          tagIds: z.array(z.string().uuid()).max(30).optional(),
        })
        .strict()
        .parse(request.body);

      const [row] = await db
        .select()
        .from(practiceSessions)
        .where(eq(practiceSessions.id, params.id));
      if (!row) throw ApiError.notFound('SESSION_NOT_FOUND', 'No such session.');
      await assertOwnership(request.user!.id, row.accountId);

      if (body.notes !== undefined) {
        await db
          .update(practiceSessions)
          .set({ notes: body.notes })
          .where(eq(practiceSessions.id, params.id));
      }
      if (body.tagIds) {
        const owned = await db
          .select({ id: tradeTags.id })
          .from(tradeTags)
          .where(eq(tradeTags.userId, request.user!.id));
        const allowed = new Set(owned.map((t) => t.id));
        const tagIds = body.tagIds.filter((id) => allowed.has(id));
        await db.transaction(async (tx) => {
          await tx.delete(sessionTagLinks).where(eq(sessionTagLinks.sessionId, params.id));
          if (tagIds.length > 0) {
            await tx
              .insert(sessionTagLinks)
              .values(tagIds.map((tagId) => ({ sessionId: params.id, tagId })));
          }
        });
      }

      const [updated] = await db
        .select()
        .from(practiceSessions)
        .where(eq(practiceSessions.id, params.id));
      return reply.send({ session: presentSession(updated!) });
    });

    /** A session with its review, its trades and the tags on it. */
    app.get<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const [row] = await db
        .select()
        .from(practiceSessions)
        .where(eq(practiceSessions.id, params.id));
      if (!row) throw ApiError.notFound('SESSION_NOT_FOUND', 'No such session.');
      await assertOwnership(request.user!.id, row.accountId);

      const rows = await db
        .select()
        .from(trades)
        .where(eq(trades.sessionId, params.id))
        .orderBy(trades.exitTime);
      const tags = await tagsFor(rows.map((r) => r.id));
      const links = await db
        .select()
        .from(sessionTagLinks)
        .where(eq(sessionTagLinks.sessionId, params.id));

      // A session that is still running gets a review computed live, so the
      // trader can look at where they are without ending it.
      const review = row.summary ?? (await buildReview(row));

      return reply.send({
        session: presentSession(row),
        review,
        tagIds: links.map((l) => l.tagId),
        trades: rows.map((trade) => presentTrade(trade, tags.get(trade.id) ?? [])),
      });
    });

    // -- the review --------------------------------------------------------

    /**
     * Everything a review says about a session.
     *
     * Deliberately DATA rather than prose: figures, violations, the best and
     * worst trade, the tags the trader used. An analysis layer can be written
     * against this later without the trading engine knowing it exists, which is
     * the only way to add one without changing what the engine does.
     */
    async function buildReview(
      session: typeof practiceSessions.$inferSelect,
    ): Promise<Record<string, unknown>> {
      const rows = await db
        .select()
        .from(trades)
        .where(eq(trades.sessionId, session.id))
        .orderBy(trades.exitTime);

      const analytics = analyze(toRecords(rows), session.startingBalanceMicros);
      const [account] = await db.select().from(accounts).where(eq(accounts.id, session.accountId));

      const violations = await db
        .select()
        .from(riskEvents)
        .where(
          and(
            eq(riskEvents.accountId, session.accountId),
            gte(riskEvents.createdAt, session.startedAt),
            session.endedAt ? lte(riskEvents.createdAt, session.endedAt) : sql`true`,
          ),
        )
        .orderBy(riskEvents.createdAt);

      const ordered = [...rows].sort((a, b) => a.netPnlMicros - b.netPnlMicros);
      const worst = ordered[0] ?? null;
      const best = ordered[ordered.length - 1] ?? null;

      const status = await deps.engine.valuation(session.accountId);

      return {
        version: 1,
        sessionId: session.id,
        accountId: session.accountId,
        mode: session.mode,
        source: session.source,
        symbol: session.symbol,
        recordingId: session.recordingId,
        tradingDate: session.tradingDate,
        startedAt: session.startedAt.getTime(),
        endedAt: session.endedAt?.getTime() ?? null,
        startingBalanceMicros: session.startingBalanceMicros,
        endingBalanceMicros: session.endingBalanceMicros ?? account?.balanceMicros ?? null,
        netPnlMicros: analytics.stats.netPnlMicros,
        stats: analytics.stats,
        curve: analytics.curve,
        breakdowns: analytics.breakdowns,
        bestTrade: best ? presentTrade(best, []) : null,
        worstTrade: worst ? presentTrade(worst, []) : null,
        violations: violations.map((event) => ({
          rule: event.rule,
          reasonCode: event.reasonCode,
          detail: event.detail,
          at: event.createdAt.getTime(),
        })),
        // Where the programme stands, which is what a challenge session is for.
        programme: status
          ? {
              status: status.rules.status,
              canTrade: status.rules.canTrade,
              profitProgressMicros: status.rules.profitProgressMicros,
              profitTargetMicros: status.rules.profitTargetMicros,
              remainingDrawdownMicros: status.rules.remainingDrawdownMicros,
              requirements: status.rules.requirements,
              breach: status.rules.breach,
            }
          : null,
      };
    }

    async function endSession(
      id: string,
    ): Promise<typeof practiceSessions.$inferSelect | undefined> {
      const [session] = await db.select().from(practiceSessions).where(eq(practiceSessions.id, id));
      if (!session) return undefined;
      if (session.endedAt) return session;

      const [account] = await db.select().from(accounts).where(eq(accounts.id, session.accountId));
      const summary = await buildReview({ ...session, endedAt: new Date() });

      const [updated] = await db
        .update(practiceSessions)
        .set({
          endedAt: new Date(),
          endingBalanceMicros: account?.balanceMicros ?? session.startingBalanceMicros,
          summary: summary as never,
          // A blind session is only revealed once it is over - and now there is
          // something to reveal, because the server wrote down what it was.
          dateHidden: false,
        })
        .where(eq(practiceSessions.id, id))
        .returning();
      return updated;
    }
  };
}

/** A session row as the client sees it, with the date withheld while blind. */
function presentSession(row: typeof practiceSessions.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    accountId: row.accountId,
    source: row.source,
    mode: row.mode,
    config: row.config,
    recordingId: row.dateHidden ? null : row.recordingId,
    symbol: row.symbol,
    tradingDate: row.dateHidden ? null : row.tradingDate,
    dateHidden: row.dateHidden,
    startingBalanceMicros: row.startingBalanceMicros,
    endingBalanceMicros: row.endingBalanceMicros,
    startedAt: row.startedAt.getTime(),
    endedAt: row.endedAt?.getTime() ?? null,
    summary: row.summary,
    notes: row.notes,
  };
}
