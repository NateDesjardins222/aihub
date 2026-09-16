/** Attaches the authenticated user to each request, or rejects it. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../auth/tokens.js';
import { ApiError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string; isAdmin: boolean };
  }
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
    if (claims) request.user = { id: claims.sub, email: claims.email, isAdmin: claims.isAdmin };
  });
}

/** Use as a route `preHandler` for endpoints that require a signed-in user. */
export async function requireUser(request: FastifyRequest): Promise<void> {
  if (!request.user) throw ApiError.unauthorized();
}
