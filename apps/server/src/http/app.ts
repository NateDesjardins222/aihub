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
import { adminRoutes } from './routes/admin.js';
import { provisioningRoutes } from './routes/provisioning.js';
import { TradingEngine } from '../trading/engine.js';
import { AtlasSimulationExecutionProvider } from '../execution/provider.js';
import { buildMarketDataStack, type MarketDataStack } from '../marketdata/bootstrap.js';
import { getDb, getLockSql } from '../db/client.js';
import { OutboxWorker, notifyAccountChanged } from '../platform/outbox.js';
import { accountOutboxHandler } from '../platform/projection.js';
import { listenAccountChanged } from '../platform/account-notify.js';
import { MarketDataGateway } from '../ws/gateway.js';
import { recordEngineActivity } from '../platform/engine-audit.js';
import { certifyPassedEvaluations, registerAutoCertification } from '../platform/commerce-certify.js';

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
    // The browser cannot read a response header it has not been told about,
    // and the execution instrument needs the server's own timing.
    exposedHeaders: ['x-atlas-ms'],
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
      } catch {
        /*
         * A body that is not JSON is the CALLER's mistake.
         *
         * Handing back the raw SyntaxError - which is what this did - loses
         * the one thing the error handler needs: a status. Fastify's own
         * parser raises a FastifyError carrying 400, but this parser replaced
         * it to let an empty body mean `{}`, and threw that typing away with
         * it. So every malformed body, on every route, came back as
         * `INTERNAL_ERROR` with a 500: Atlas reporting a client's typo as its
         * own failure, and paging whoever watches 5xx rates for it.
         */
        done(
          ApiError.badRequest(
            'MALFORMED_JSON',
            'The request body is not valid JSON.',
          ) as unknown as Error,
          undefined,
        );
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

  /*
   * How long the server itself took.
   *
   * The browser can time a round trip, but a round trip is wire plus server
   * and a trader with a slow fill deserves to know which. Every response
   * carries the handler's own duration, so the execution instrument can
   * report "the server decided in 3ms and the wire cost 40" rather than one
   * number that explains nothing.
   */
  app.addHook('onRequest', async (request) => {
    (request as { atlasStart?: number }).atlasStart = performance.now();
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const started = (request as { atlasStart?: number }).atlasStart;
    if (started !== undefined) {
      reply.header('x-atlas-ms', (performance.now() - started).toFixed(1));
    }
    return payload;
  });

  app.get('/health', async () => ({
    status: 'ok',
    time: new Date().toISOString(),
    env: env().NODE_ENV,
  }));

  const { db } = getDb();
  const stack = buildMarketDataStack(db);
  // A dedicated lock pool gives the engine its cross-process account lock; a
  // second Atlas instance sharing this database can no longer double-fill an
  // account. It is a separate pool so a held lock never starves queries.
  const engine = new TradingEngine(db, stack.market, getLockSql());
  // Order flow routes through the execution provider seam; today that is the
  // simulator wrapping this engine. A live provider would slot in here.
  const execution = new AtlasSimulationExecutionProvider(engine);
  const gateway = new MarketDataGateway(stack.market, engine);
  gateway.register(app);

  /*
   * The platform record listens to the engine; the engine does not know it is
   * there. Fills become audit rows and domain events, and a terminal rule
   * outcome closes the account's lifecycle - all without a line of it inside
   * the matching path.
   */
  const stopRecording = recordEngineActivity(db, engine);

  /*
   * The commercial layer plugs in the same way: it certifies an evaluation the
   * instant the engine says PASSED, turning the reversible verdict into a
   * one-way qualification. The startup sweep recovers any pass a crash left
   * un-certified, so a qualification is never lost. The engine is untouched.
   */
  const stopCertifying = registerAutoCertification(db);
  void certifyPassedEvaluations(db).catch(() => undefined);

  /*
   * The outbox delivery worker keeps the operational read model current and
   * wakes other instances. It drains account.changed events into the projection
   * and, after each committed batch, NOTIFYs so an instance holding a trader's
   * or owner's socket re-publishes even for a change processed elsewhere. Its
   * connection is the dedicated lock pool, kept off the query pool.
   */
  const workerPg = getLockSql();
  const outboxWorker = new OutboxWorker(db, {
    handler: accountOutboxHandler,
    onDelivered: (accountIds) => void notifyAccountChanged(workerPg, accountIds),
  });
  outboxWorker.start();

  const accountListener = await listenAccountChanged(workerPg, (accountId) => {
    void gateway.publishAccountState(accountId);
  }).catch((): null => null);

  app.addHook('onClose', async () => {
    stopRecording();
    stopCertifying();
    outboxWorker.stop();
    await accountListener?.close().catch(() => undefined);
    engine.stop();
    await stack.market.stop();
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(instrumentRoutes, { prefix: '/api/v1/instruments' });
  await app.register(accountRoutes, { prefix: '/api/v1/accounts' });
  await app.register(ruleTemplateRoutes, { prefix: '/api/v1/rule-templates' });
  await app.register(marketDataRoutes({ ...stack, engine }), { prefix: '/api/v1/marketdata' });
  await app.register(tradingRoutes({ engine, market: stack.market, execution }), { prefix: '/api/v1' });
  await app.register(journalRoutes({ engine, replay: stack.replay }), { prefix: '/api/v1/journal' });
  // The operator console and the machine-to-machine seam. Both are authorised
  // server-side; neither is reachable from the trading terminal's session.
  await app.register(adminRoutes({ engine, market: stack.market }), { prefix: '/api/v1/admin' });
  await app.register(provisioningRoutes, { prefix: '/api/v1/provisioning' });

  return { app, stack, gateway, engine };
}
