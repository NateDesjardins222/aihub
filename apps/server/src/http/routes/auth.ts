/** /api/v1/auth */
import type { FastifyInstance } from 'fastify';
import { loginSchema, registerSchema } from '@atlas/contracts';
import { z } from 'zod';
import { AuthError, getUserById, login, logout, refresh, register } from '../../auth/service.js';
import { getDb } from '../../db/client.js';
import { ApiError } from '../errors.js';
import { requireUser } from '../auth-plugin.js';

const refreshSchema = z.object({ refreshToken: z.string().min(10) });

function mapAuthError(err: unknown): never {
  if (err instanceof AuthError) {
    const status = err.code === 'EMAIL_TAKEN' ? 409 : 401;
    throw new ApiError(status, err.code, err.message);
  }
  throw err;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();

  /*
   * Every unauthenticated auth endpoint is IP-rate-limited.
   *
   * These are the platform's front door and, before this, they had NO limit:
   * the global limiter is `global: false`, so a route without its own config is
   * unlimited. That left credential brute-force, credential stuffing, and
   * account-enumeration amplification wide open. The keys are per-IP; the IP is
   * only trustworthy because `trustProxy` is off by default (see app.ts), so a
   * spoofed `X-Forwarded-For` cannot mint a fresh bucket per request. Budgets
   * are generous enough for a fat-fingered human, tight enough to make an
   * automated campaign useless.
   */
  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  app.post('/register', limit(10), async (request, reply) => {
    const body = registerSchema.parse(request.body);
    try {
      return reply.code(201).send(await register(db, body, request.headers['user-agent'] ?? null));
    } catch (err) {
      mapAuthError(err);
    }
  });

  app.post('/login', limit(20), async (request, reply) => {
    const body = loginSchema.parse(request.body);
    try {
      return reply.send(await login(db, body, request.headers['user-agent'] ?? null));
    } catch (err) {
      mapAuthError(err);
    }
  });

  app.post('/refresh', limit(30), async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    try {
      return reply.send(await refresh(db, body.refreshToken, request.headers['user-agent'] ?? null));
    } catch (err) {
      mapAuthError(err);
    }
  });

  app.post('/logout', limit(30), async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    await logout(db, body.refreshToken);
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: requireUser }, async (request, reply) => {
    const user = await getUserById(db, request.user!.id);
    if (!user) throw ApiError.notFound('USER_NOT_FOUND', 'User no longer exists.');
    return reply.send({ user });
  });
}
