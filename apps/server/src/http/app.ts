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

export async function buildApp(): Promise<FastifyInstance> {
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

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(instrumentRoutes, { prefix: '/api/v1/instruments' });
  await app.register(accountRoutes, { prefix: '/api/v1/accounts' });
  await app.register(ruleTemplateRoutes, { prefix: '/api/v1/rule-templates' });

  return app;
}
