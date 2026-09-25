/**
 * Owner Operating System authorization (M10-B).
 *
 * `requirePermission(perm)` is the granular server-side gate for every owner
 * route. Like `requireRole`, it re-reads the operator's current role and status
 * from the database (a token's role can be stale), computes the effective
 * permission set (role defaults ± per-user overrides) and 403s if the permission
 * is absent. UI hiding is never authorization; this is.
 *
 * `requireReauth(class)` demands a fresh step-up token (header `x-stepup-token`)
 * for high-risk actions.
 */
import type { FastifyRequest } from 'fastify';
import { getDb } from '../db/client.js';
import { ApiError } from './errors.js';
import { effectiveAccess } from '../platform/staff.js';
import type { Permission, ReauthClass } from '../platform/permissions.js';
import { verifyStepUp } from '../platform/reauth.js';
import type { Actor } from '../platform/actor.js';

declare module 'fastify' {
  interface FastifyRequest {
    ownerAccess?: { role: string; permissions: string[] };
  }
}

async function loadAccess(request: FastifyRequest): Promise<{ role: string; permissions: string[] }> {
  if (request.ownerAccess) return request.ownerAccess;
  if (!request.user) throw ApiError.unauthorized();
  const { db } = getDb();
  const access = await effectiveAccess(db, request.user.id);
  if (!access || access.status !== 'ACTIVE') throw ApiError.forbidden('Access denied.');
  request.ownerAccess = { role: access.role, permissions: access.permissions };
  // Keep request.user.role in step with the DB (mirrors requireRole behavior).
  request.user = { ...request.user, role: access.role as typeof request.user.role };
  return request.ownerAccess;
}

export function requirePermission(permission: Permission) {
  return async function check(request: FastifyRequest): Promise<void> {
    const access = await loadAccess(request);
    if (!access.permissions.includes(permission)) {
      throw ApiError.forbidden('You do not have permission to do that.');
    }
  };
}

/** Passes if the operator holds ANY of the listed permissions. */
export function requireAnyPermission(...permissions: Permission[]) {
  return async function check(request: FastifyRequest): Promise<void> {
    const access = await loadAccess(request);
    if (!permissions.some((p) => access.permissions.includes(p))) {
      throw ApiError.forbidden('You do not have permission to do that.');
    }
  };
}

export function requireReauth(cls: ReauthClass) {
  return async function check(request: FastifyRequest): Promise<void> {
    if (!request.user) throw ApiError.unauthorized();
    const token = request.headers['x-stepup-token'];
    const value = Array.isArray(token) ? token[0] : token;
    if (!verifyStepUp(value, request.user.id, cls)) {
      throw ApiError.forbidden('This action requires reauthentication.');
    }
  };
}

/** Build an Actor for audit from the request (operator identity + request meta). */
export function actorFromRequest(request: FastifyRequest): Actor {
  return {
    type: request.user?.role === 'SUPER_ADMIN' || request.user?.role === 'ADMIN' ? 'ADMIN' : 'USER',
    userId: request.user?.id ?? null,
    label: request.user?.email ?? null,
    ip: request.ip ?? null,
    requestId: request.id ?? null,
  };
}
