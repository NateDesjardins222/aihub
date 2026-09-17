/** Fastify application assembly. */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env, isProduction } from '../config/env.js';
import { ApiError } from './errors.js';
import { registerAuth } from './auth-plugin.js';
import { authRoutes } from './routes/auth.js';
import { instrumentRoutes } from './routes/instruments.js';
import { accountRoutes, ruleTemplateRoutes } from './routes/accounts.js';
import { marketDataRoutes } from './routes/marketdata.js';
import { tradingRoutes } from './routes/trading.js';
import { journalRoutes } from './routes/journal.js';
import { TradingEngine } from '../trading/engine.js';
import { buildMarketDataStack, type MarketDataStack } from '../marketdata/bootstrap.js';
import { getDb } from '../db/client.js';
import { MarketDataGateway } from '../ws/gateway.js';
import { recordEngineActivity } from '../platform/engine-audit.js';

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly stack: MarketDataStack;
  readonly gateway: MarketDataGateway;
  readonly engine: TradingEngine;
}

export async function buildApp(): Promise<BuiltApp> {
  const app = Fastify({
    logger: {
      level: isProduction() ? 'info' : 'warn',
      redact: ['req.headers.authorization', 'req.body.password', 'req.body.refreshToken'],
    },
    trustProxy: true,
    bodyLimit: 1024 * 512,
  });

  await app.register(cors, {
    origin: env().CORS_ORIGIN === '*' ? true : env().CORS_ORIGIN.split(','),
    credentials: true,
  });

  await app.register(rateLimit, {
    global: false,
    max: 600,
    timeWindow: '1 minute',
  });

  // Several control endpoints (replay play/pause/reset) legitimately take no
  // body. A client that still sets a JSON content-type would otherwise be
  // rejected outright, so an empty body is read as an empty object.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body === undefined || body === null || body.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  registerAuth(app);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message, detail: error.detail } });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request failed validation.',
          detail: { issues: error.issues },
        },
      });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply
        .code(429)
        .send({ error: { code: 'RATE_LIMITED', message: 'Too many requests.' } });
    }

    // A framework error already carries a meaningful status and code. Reporting
    // a 400 as INTERNAL_ERROR sends the caller hunting for a server fault that
    // does not exist.
    const framework = error as { statusCode?: number; code?: string; message?: string };
    if (typeof framework.statusCode === 'number' && framework.statusCode < 500) {
      return reply.code(framework.statusCode).send({
        error: {
          code: framework.code ?? 'BAD_REQUEST',
          message: framework.message ?? 'Request could not be processed.',
        },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
  });

  app.get('/health', async () => ({
    status: 'ok',
    time: new Date().toISOString(),
    env: env().NODE_ENV,
  }));

  const { db } = getDb();
  const stack = buildMarketDataStack(db);
  const engine = new TradingEngine(db, stack.market);
  const gateway = new MarketDataGateway(stack.market, engine);
  gateway.register(app);

  /*
   * The platform record listens to the engine; the engine does not know it is
   * there. Fills become audit rows and domain events, and a terminal rule
   * outcome closes the account's lifecycle - all without a line of it inside
   * the matching path.
   */
  const stopRecording = recordEngineActivity(db, engine);

  app.addHook('onClose', async () => {
    stopRecording();
    engine.stop();
    await stack.market.stop();
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(instrumentRoutes, { prefix: '/api/v1/instruments' });
  await app.register(accountRoutes, { prefix: '/api/v1/accounts' });
  await app.register(ruleTemplateRoutes, { prefix: '/api/v1/rule-templates' });
  await app.register(marketDataRoutes({ ...stack, engine }), { prefix: '/api/v1/marketdata' });
  await app.register(tradingRoutes({ engine, market: stack.market }), { prefix: '/api/v1' });
  await app.register(journalRoutes({ engine, replay: stack.replay }), { prefix: '/api/v1/journal' });

  return { app, stack, gateway, engine };
}
