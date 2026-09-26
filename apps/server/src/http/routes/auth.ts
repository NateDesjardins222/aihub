/** /api/v1/auth */
import type { FastifyInstance } from 'fastify';
import { loginSchema, registerSchema } from '@atlas/contracts';
import { z } from 'zod';
import {
  AuthError,
  completeMfaLogin,
  getUserById,
  login,
  logout,
  refresh,
  register,
} from '../../auth/service.js';
import {
  activateEnrollment,
  beginEnrollment,
  disableMfa,
  MfaError,
  mfaStatus,
  regenerateRecoveryCodes,
  verifyFactor,
} from '../../auth/mfa.js';
import { verifyPassword } from '../../auth/password.js';
import { getDb } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { ApiError } from '../errors.js';
import { requireUser } from '../auth-plugin.js';

const refreshSchema = z.object({ refreshToken: z.string().min(10) });
const mfaVerifySchema = z.object({ challengeToken: z.string().min(10), code: z.string().min(6).max(20) });
const codeSchema = z.object({ code: z.string().min(6).max(20) });

function mapAuthError(err: unknown): never {
  if (err instanceof AuthError) {
    const status = err.code === 'EMAIL_TAKEN' ? 409 : 401;
    throw new ApiError(status, err.code, err.message);
  }
  if (err instanceof MfaError) {
    const status = err.code === 'INVALID_CODE' ? 401 : 400;
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

  // Second step of an MFA login. Same tight IP budget as /login: the code space
  // is only 10^6 and the TOTP window is ±1 step, so this budget makes an online
  // guessing campaign against a single challenge useless.
  app.post('/mfa/verify', limit(20), async (request, reply) => {
    const body = mfaVerifySchema.parse(request.body);
    try {
      return reply.send(await completeMfaLogin(db, body.challengeToken, body.code, request.headers['user-agent'] ?? null));
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

  // -------------------------------------------------------------------------
  // MFA management (authenticated). Any signed-in user may add a second factor
  // to their own account; operators are expected to. Enrollment is two-phase so
  // a half-finished setup can never lock anyone out, and disabling requires the
  // password AND a live factor so a stolen access token alone cannot remove it.
  // -------------------------------------------------------------------------
  app.get('/mfa/status', { preHandler: requireUser }, async (request, reply) => {
    return reply.send(await mfaStatus(db, request.user!.id));
  });

  app.post('/mfa/enroll/begin', { preHandler: requireUser, ...limit(10) }, async (request, reply) => {
    try {
      return reply.send(await beginEnrollment(db, request.user!.id));
    } catch (err) {
      mapAuthError(err);
    }
  });

  app.post('/mfa/enroll/activate', { preHandler: requireUser, ...limit(20) }, async (request, reply) => {
    const body = codeSchema.parse(request.body);
    try {
      return reply.send(await activateEnrollment(db, request.user!.id, body.code));
    } catch (err) {
      mapAuthError(err);
    }
  });

  app.post('/mfa/disable', { preHandler: requireUser, ...limit(10) }, async (request, reply) => {
    const body = z.object({ password: z.string().min(1), code: z.string().min(6).max(20) }).parse(request.body);
    // Re-prove the password AND a live second factor before removing it.
    const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, request.user!.id));
    if (!row || !(await verifyPassword(body.password, row.passwordHash))) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Password is incorrect.');
    }
    if (!(await verifyFactor(db, request.user!.id, body.code))) {
      throw new ApiError(401, 'INVALID_MFA', 'That verification code is not valid.');
    }
    try {
      await disableMfa(db, request.user!.id);
      return reply.send({ ok: true });
    } catch (err) {
      mapAuthError(err);
    }
  });

  app.post('/mfa/recovery-codes', { preHandler: requireUser, ...limit(10) }, async (request, reply) => {
    const body = codeSchema.parse(request.body);
    if (!(await verifyFactor(db, request.user!.id, body.code))) {
      throw new ApiError(401, 'INVALID_MFA', 'That verification code is not valid.');
    }
    try {
      return reply.send(await regenerateRecoveryCodes(db, request.user!.id));
    } catch (err) {
      mapAuthError(err);
    }
  });
}
