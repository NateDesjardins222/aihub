/**
 * /api/v1/marketdata
 *
 * Historical bars with pagination, quotes, feed status and replay control.
 * Every response states where the data came from and how delayed it is.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { historicalBarsQuerySchema, timeframeSchema } from '@atlas/contracts';
import { getInstrument, listInstruments, requireInstrument, tradingDate } from '@atlas/instruments';
import { secondsToBucketClose } from '@atlas/core';
import { ApiError } from '../errors.js';
import { requireUser } from '../auth-plugin.js';
import type { MarketDataService } from '../../marketdata/service.js';
import type { SessionRecorder } from '../../marketdata/recorder.js';
import { REPLAY_SPEEDS, type ReplayProvider, type ReplaySpeed } from '../../marketdata/providers/replay.js';

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
        replay: deps.replay.getState(),
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

    app.get('/replay', async (_request, reply) => reply.send(deps.replay.getState()));

    app.post('/replay/load', async (request, reply) => {
      const body = replayLoadSchema.parse(request.body);
      let path: string;
      try {
        path = deps.recorder.pathFor(body.recordingId);
      } catch {
        throw ApiError.badRequest('INVALID_RECORDING_ID', 'Recording id is not valid.');
      }
      const state = deps.replay.load(path, body.recordingId);
      if (!state.loaded) throw ApiError.notFound('RECORDING_NOT_FOUND', 'No such recording.');
      return reply.send(state);
    });

    app.post('/replay/play', async (_request, reply) => {
      try {
        return reply.send(deps.replay.play());
      } catch {
        throw ApiError.badRequest('NO_RECORDING_LOADED', 'Load a recording first.');
      }
    });

    app.post('/replay/pause', async (_request, reply) => reply.send(deps.replay.pause()));
    app.post('/replay/reset', async (_request, reply) => reply.send(deps.replay.reset()));

    app.post('/replay/speed', async (request, reply) => {
      const body = replaySpeedSchema.parse(request.body);
      if (!REPLAY_SPEEDS.includes(body.speed as ReplaySpeed)) {
        throw ApiError.badRequest(
          'UNSUPPORTED_SPEED',
          `Speed must be one of ${REPLAY_SPEEDS.join(', ')}.`,
        );
      }
      return reply.send(deps.replay.setSpeed(body.speed as ReplaySpeed));
    });

    app.post('/replay/seek', async (request, reply) => {
      const body = replaySeekSchema.parse(request.body);
      return reply.send(deps.replay.seek(body.progress));
    });

    /** Switch the whole platform between the live delayed feed and replay. */
    app.post('/provider', async (request, reply) => {
      const body = providerSchema.parse(request.body);
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
