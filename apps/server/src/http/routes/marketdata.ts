/**
 * /api/v1/marketdata
 *
 * Historical bars with pagination, quotes, feed status and replay control.
 * Every response states where the data came from and how delayed it is.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { historicalBarsQuerySchema, timeframeSchema } from '@atlas/contracts';
import { getInstrument, listInstruments, requireInstrument, tradingDate } from '@atlas/instruments';
import { anchorsWithin, secondsToBucketClose } from '@atlas/core';
import { ApiError } from '../errors.js';
import { requireUser } from '../auth-plugin.js';
import type { MarketDataService } from '../../marketdata/service.js';
import type { SessionRecorder } from '../../marketdata/recorder.js';
import type { TradingEngine } from '../../trading/engine.js';
import {
  REPLAY_SPEEDS,
  type ReplayProvider,
  type ReplaySpeed,
  type ReplayState,
} from '../../marketdata/providers/replay.js';

/**
 * Hide what a blind session must not give away.
 *
 * The provider knows exactly what it is playing - it has to. The API is where
 * that knowledge stops: a blind session's recording id, symbol, date and
 * absolute clock would each identify the day, so each of them is withheld until
 * the session is revealed. Progress and speed are not identifying and stay.
 */
function maskReplay(state: ReplayState): ReplayState & { elapsedMs: number | null } {
  const elapsedMs =
    state.clock !== null && state.startTs !== null ? state.clock - state.startTs : null;
  if (!state.blind) return { ...state, elapsedMs };
  return {
    ...state,
    recordingId: null,
    clock: null,
    startTs: null,
    endTs: null,
    header: null,
    elapsedMs,
  };
}

const barsQuerySchema = historicalBarsQuerySchema.extend({
  before: z.coerce.number().int().optional(),
});

const captureSchema = z.object({
  symbol: z.string().min(1).max(12),
  /** Exchange trading date, YYYY-MM-DD. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeframe: timeframeSchema.default('1m'),
});

const replayLoadSchema = z.object({ recordingId: z.string().min(1).max(128) });
const replaySpeedSchema = z.object({ speed: z.number() });
const replaySeekSchema = z.object({ progress: z.number().min(0).max(1) });
const providerSchema = z.object({ provider: z.enum(['live', 'replay']) });

export interface MarketDataRouteDeps {
  readonly market: MarketDataService;
  readonly recorder: SessionRecorder;
  readonly replay: ReplayProvider;
  /**
   * The engine, for one question only: is the account flat?
   *
   * Skipping forward through a session is a replay control, but whether it is
   * ALLOWED is a trading fact, and the engine is the only thing that knows it.
   */
  readonly engine: TradingEngine;
  readonly liveProviderFactory: () => import('../../marketdata/provider.js').MarketDataProvider;
}

export function marketDataRoutes(deps: MarketDataRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.addHook('preHandler', requireUser);

    /** Historical + forming bars. `before` pages backwards through real history. */
    app.get('/bars', async (request, reply) => {
      const query = barsQuerySchema.parse(request.query);
      const spec = getInstrument(query.symbol);
      if (!spec) throw ApiError.notFound('UNKNOWN_INSTRUMENT', `No instrument ${query.symbol}.`);

      const page = await deps.market.getChartBars({
        symbol: spec.root,
        timeframe: query.timeframe,
        limit: query.limit,
        ...(query.before !== undefined ? { before: query.before } : {}),
      });

      return reply.send({
        symbol: page.symbol,
        timeframe: page.timeframe,
        bars: page.bars,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        limitReason: page.limitReason,
        source: page.source,
        provider: deps.market.currentProvider.id,
        mode: deps.market.currentProvider.mode,
        pricePrecision: spec.pricePrecision,
        barCloseInSeconds:
          page.bars.length > 0
            ? secondsToBucketClose(spec, Date.now(), query.timeframe)
            : null,
      });
    });

    app.get('/quote', async (request, reply) => {
      const query = z.object({ symbol: z.string().min(1).max(12) }).parse(request.query);
      const spec = getInstrument(query.symbol);
      if (!spec) throw ApiError.notFound('UNKNOWN_INSTRUMENT', `No instrument ${query.symbol}.`);
      await deps.market.subscribe(spec.root);
      return reply.send(deps.market.symbolStatus(spec.root));
    });

    /** Feed status: mode, measured delay, per-symbol freshness. */
    app.get('/status', async (_request, reply) => {
      const status = deps.market.getConnectionStatus();
      const subscribed = deps.market.subscribedSymbols();
      return reply.send({
        connection: status,
        capabilities: deps.market.capabilities(),
        depthLevels: deps.market.currentProvider.depthLevels,
        depthAvailable: deps.market.currentProvider.depthLevels > 0,
        symbols: subscribed.map((s) => deps.market.symbolStatus(s)),
        replay: maskReplay(deps.replay.getState()),
        serverTime: Date.now(),
      });
    });

    app.get('/instruments-status', async (_request, reply) => {
      return reply.send({
        instruments: listInstruments().map((spec) => {
          const quote = deps.market.getQuote(spec.root);
          return {
            symbol: spec.root,
            last: quote?.last ?? null,
            exchangeTs: quote?.exchangeTs ?? null,
            tradingDate: tradingDate(spec, Date.now()),
          };
        }),
      });
    });

    // -- recordings and replay --------------------------------------------

    app.get('/recordings', async (_request, reply) => {
      return reply.send({ recordings: deps.recorder.list() });
    });

    /**
     * The sessions a trader can practise on.
     *
     * Two lists: the recordings already captured, and the recent trading dates
     * the feed could still build one from. The second is bounded by what the
     * vendor actually serves - a development feed keeps seven days of
     * one-minute history - and saying so is better than offering a date picker
     * that fails on most of the dates in it.
     */
    app.get('/sessions', async (request, reply) => {
      const query = z
        .object({
          symbol: z.string().max(12).default('NQ'),
          days: z.coerce.number().int().min(1).max(60).default(10),
        })
        .parse(request.query);

      const spec = getInstrument(query.symbol);
      if (!spec) throw ApiError.notFound('UNKNOWN_INSTRUMENT', `No instrument ${query.symbol}.`);

      const recordings = deps.recorder
        .list()
        .filter((r) => r.header.symbol === spec.root)
        .map((r) => ({
          id: r.id,
          symbol: r.header.symbol,
          tradingDate: r.header.tradingDate,
          events: r.header.eventCount,
          captureMethod: r.header.captureMethod,
          startTs: r.header.startTs,
          endTs: r.header.endTs,
        }));

      const captured = new Set(recordings.map((r) => r.tradingDate));
      const dates: Array<{ date: string; captured: boolean; weekday: number }> = [];
      const today = tradingDate(spec, Date.now());
      let cursor = DateTime.fromFormat(today, 'yyyy-MM-dd', { zone: spec.sessionTimezone });
      while (dates.length < query.days) {
        // Weekends have no session to capture.
        if (cursor.weekday <= 5) {
          const date = cursor.toFormat('yyyy-MM-dd');
          dates.push({ date, captured: captured.has(date), weekday: cursor.weekday });
        }
        cursor = cursor.minus({ days: 1 });
      }

      return reply.send({
        symbol: spec.root,
        recordings,
        dates,
        historyNote:
          'One-minute history from the development feed reaches back about seven days. ' +
          'Older dates can be captured at a coarser timeframe.',
      });
    });

    /** Build a replay file from one real past session. */
    app.post('/recordings/capture', async (request, reply) => {
      const body = captureSchema.parse(request.body);
      const spec = getInstrument(body.symbol);
      if (!spec) throw ApiError.notFound('UNKNOWN_INSTRUMENT', `No instrument ${body.symbol}.`);
      try {
        const summary = await deps.recorder.captureHistoricalSession(
          deps.liveProviderFactory(),
          spec.root,
          body.date,
          body.timeframe,
        );
        return reply.code(201).send(summary);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('NO_DATA_FOR_SESSION')) {
          throw ApiError.notFound(
            'NO_DATA_FOR_SESSION',
            `The feed has no data for ${spec.root} on ${body.date}. ` +
              'The development feed serves only 7 days of 1-minute history.',
          );
        }
        throw err;
      }
    });

    app.get('/replay', async (_request, reply) => reply.send(maskReplay(deps.replay.getState())));

    app.post('/replay/load', async (request, reply) => {
      const body = replayLoadSchema.parse(request.body);
      let path: string;
      try {
        path = deps.recorder.pathFor(body.recordingId);
      } catch {
        throw ApiError.badRequest('INVALID_RECORDING_ID', 'Recording id is not valid.');
      }
      const state = deps.replay.load(path, body.recordingId, { blind: false });
      if (!state.loaded) throw ApiError.notFound('RECORDING_NOT_FOUND', 'No such recording.');
      return reply.send(state);
    });

    app.post('/replay/play', async (_request, reply) => {
      try {
        return reply.send(maskReplay(deps.replay.play()));
      } catch {
        throw ApiError.badRequest('NO_RECORDING_LOADED', 'Load a recording first.');
      }
    });

    app.post('/replay/pause', async (_request, reply) => reply.send(maskReplay(deps.replay.pause())));
    app.post('/replay/reset', async (_request, reply) => reply.send(maskReplay(deps.replay.reset())));

    app.post('/replay/speed', async (request, reply) => {
      const body = replaySpeedSchema.parse(request.body);
      if (!REPLAY_SPEEDS.includes(body.speed as ReplaySpeed)) {
        throw ApiError.badRequest(
          'UNSUPPORTED_SPEED',
          `Speed must be one of ${REPLAY_SPEEDS.join(', ')}.`,
        );
      }
      return reply.send(maskReplay(deps.replay.setSpeed(body.speed as ReplaySpeed)));
    });

    app.post('/replay/seek', async (request, reply) => {
      const body = replaySeekSchema.parse(request.body);
      return reply.send(maskReplay(deps.replay.seek(body.progress)));
    });

    /**
     * Step the replay forward by a handful of events.
     *
     * Studying a session rather than watching it: the platform behaves exactly
     * as it does at speed, one print at a time.
     */
    app.post('/replay/step', async (request, reply) => {
      const body = z
        .object({ count: z.number().int().min(1).max(500).default(1) })
        .strict()
        .parse(request.body ?? {});
      try {
        return reply.send(maskReplay(deps.replay.step(body.count)));
      } catch {
        throw ApiError.badRequest('NO_RECORDING_LOADED', 'Load a recording first.');
      }
    });

    /** Back to the start of the recording, playing. */
    app.post('/replay/restart', async (_request, reply) => {
      try {
        return reply.send(maskReplay(deps.replay.restart()));
      } catch {
        throw ApiError.badRequest('NO_RECORDING_LOADED', 'Load a recording first.');
      }
    });

    /**
     * Skip forward through the session.
     *
     * Only while the account is FLAT and has nothing working: skipping with a
     * position open would mean the market moved without the trader being able
     * to react, which is not practice, it is a random outcome. The events are
     * replayed rather than dropped, so nothing about the session changes.
     */
    app.post('/replay/skip', async (request, reply) => {
      const body = z
        .object({
          accountId: z.string().uuid(),
          minutes: z.number().int().min(1).max(600).optional(),
          toTs: z.number().int().optional(),
        })
        .strict()
        .parse(request.body);

      const blocked = await deps.engine.openExposure(body.accountId);
      if (blocked) {
        throw ApiError.badRequest(
          'NOT_FLAT',
          'Skipping is only allowed while the account is flat with no working orders.',
        );
      }

      if (body.toTs !== undefined) return reply.send(maskReplay(deps.replay.seekToTime(body.toTs, true)));
      return reply.send(maskReplay(deps.replay.skipForward((body.minutes ?? 5) * 60_000)));
    });

    /** Jump to an instant, e.g. a session anchor. */
    app.post('/replay/seek-time', async (request, reply) => {
      const body = z.object({ ts: z.number().int() }).strict().parse(request.body);
      return reply.send(maskReplay(deps.replay.seekToTime(body.ts, true)));
    });

    /**
     * The anchors inside the loaded recording: the opens a trader navigates by.
     */
    app.get('/replay/anchors', async (_request, reply) => {
      const state = deps.replay.getState();
      if (!state.loaded || !state.header || !state.symbol) return reply.send({ anchors: [] });
      const spec = getInstrument(state.symbol);
      if (!spec) return reply.send({ anchors: [] });
      // A blind session must not reveal its date through its anchors, so they
      // are offered as offsets into the recording instead of timestamps.
      const anchors = anchorsWithin(
        spec,
        state.header.tradingDate,
        state.header.startTs,
        state.header.endTs,
      );
      return reply.send({
        anchors: anchors.map((anchor) => ({
          id: anchor.id,
          label: anchor.label,
          description: anchor.description,
          at: state.blind ? null : anchor.at,
          offsetMs: anchor.at - state.header!.startTs,
        })),
      });
    });

    /**
     * Load a session chosen at random and keep which one it is from the trader.
     *
     * The point of a blind session is that the date, and therefore everything
     * the trader might remember about it, is unavailable until it ends.
     */
    app.post('/replay/random', async (request, reply) => {
      const body = z
        .object({ symbol: z.string().max(12).optional(), blind: z.boolean().default(true) })
        .strict()
        .parse(request.body ?? {});

      const available = deps.recorder
        .list()
        .filter((r) => !body.symbol || r.header.symbol === body.symbol.toUpperCase());
      if (available.length === 0) {
        throw ApiError.notFound('NO_RECORDINGS', 'There are no recordings to choose from.');
      }

      const chosen = available[Math.floor(Math.random() * available.length)]!;
      const state = deps.replay.load(deps.recorder.pathFor(chosen.id), chosen.id, {
        blind: body.blind,
      });
      return reply.send(maskReplay(state));
    });

    /** Switch the whole platform between the live delayed feed and replay. */
    app.post('/provider', async (request, reply) => {
      const body = providerSchema.parse(request.body);

      /*
       * Not while anything is open.
       *
       * Market data is global; accounts are not. Switching the platform to a
       * recording re-prices every open position at that recording's market:
       * a long opened at 29,763 was marked at 29,467 and reported a $5,920
       * loss it had never made, and a recording priced ABOVE the entry raised
       * the account's high-water mark for good. The position must be closed
       * before the market under it changes.
       */
      const exposed = await deps.engine.accountsWithExposure(request.user!.id);
      if (exposed.length > 0) {
        throw ApiError.badRequest(
          'OPEN_POSITION_BLOCKS_SWITCH',
          `Close what is open first. ${exposed
            .map((a) => a.name)
            .join(', ')} ${exposed.length === 1 ? 'is' : 'are'} holding a position or a working order, and changing the market it is priced against would change what the account is worth.`,
        );
      }

      if (body.provider === 'replay') {
        await deps.market.switchProvider(deps.replay);
      } else {
        await deps.market.switchProvider(deps.liveProviderFactory());
      }
      return reply.send({
        provider: deps.market.currentProvider.id,
        mode: deps.market.currentProvider.mode,
        connection: deps.market.getConnectionStatus(),
      });
    });

    /** Diagnostics: latency, freshness, normalization and bus counters. */
    app.get('/diagnostics', async (_request, reply) => {
      const status = deps.market.getConnectionStatus();
      return reply.send({
        connection: status,
        busStats: deps.market.bus.getStats(),
        cache: await deps.market.bars.cacheStats(),
        symbols: deps.market.subscribedSymbols().map((s) => {
          const spec = requireInstrument(s);
          const freshness = deps.market.freshness(s);
          return {
            symbol: spec.root,
            freshness,
            lastQuote: deps.market.getQuote(s),
            aggregator: deps.market.aggregatorDiagnostics(s),
          };
        }),
        serverTime: Date.now(),
      });
    });
  };
}
