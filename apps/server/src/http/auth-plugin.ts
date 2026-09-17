/** Attaches the authenticated user to each request, or rejects it. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { verifyAccessToken } from '../auth/tokens.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { ApiError } from './errors.js';

export type UserRole = 'TRADER' | 'SUPPORT' | 'ADMIN' | 'SUPER_ADMIN';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      email: string;
      isAdmin: boolean;
      role: UserRole;
      organizationId: string | null;
    };
  }
}

const RANK: Record<UserRole, number> = {
  TRADER: 0,
  SUPPORT: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

function asRole(value: string | undefined, isAdmin: boolean): UserRole {
  if (value === 'SUPPORT' || value === 'ADMIN' || value === 'SUPER_ADMIN' || value === 'TRADER') {
    return value;
  }
  return isAdmin ? 'ADMIN' : 'TRADER';
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('user', undefined);

  app.addHook('onRequest', async (request) => {
    const token = bearerToken(request);
    if (!token) return;
    const claims = verifyAccessToken(token);
    if (claims) {
      request.user = {
        id: claims.sub,
        email: claims.email,
        isAdmin: claims.isAdmin,
        role: asRole(claims.role, claims.isAdmin),
        organizationId: claims.organizationId ?? null,
      };
    }
  });
}

/** Use as a route `preHandler` for endpoints that require a signed-in user. */
export async function requireUser(request: FastifyRequest): Promise<void> {
  if (!request.user) throw ApiError.unauthorized();
}

/**
 * Authorization, server side.
 *
 * Hiding a button is presentation. This is the thing that actually decides,
 * and every capability that uses it has a test that calls the route with a
 * token that lacks the role.
 *
 * The claim in the token is not trusted on its own: a role can be revoked
 * while a token is still valid, so the database's current role is what counts.
 */
export function requireRole(minimum: UserRole) {
  return async function check(request: FastifyRequest): Promise<void> {
    if (!request.user) throw ApiError.unauthorized();
    const { db } = getDb();
    const [row] = await db
      .select({ role: users.role, status: users.status, organizationId: users.organizationId })
      .from(users)
      .where(eq(users.id, request.user.id));
    if (!row || row.status !== 'ACTIVE') throw ApiError.forbidden('Access denied.');

    const current = asRole(row.role, request.user.isAdmin);
    if (RANK[current] < RANK[minimum]) {
      throw ApiError.forbidden('You do not have permission to do that.');
    }
    request.user = { ...request.user, role: current, organizationId: row.organizationId };
  };
}
