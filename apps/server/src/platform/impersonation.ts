/**
 * Safe support impersonation — "View as customer" (M10-B).
 *
 * No customer password is ever required or exposed. The operator starts a
 * short-lived, recorded support session against a target customer; a dedicated
 * impersonation token carries an `imp` marker and the operator identity. Default
 * mode is READ_ONLY: the safe-support gate refuses dangerous customer actions
 * (trading, password/destination change, purchases, payout requests, identity
 * changes, destructive account ops) for impersonated tokens. Every start/stop is
 * audited with the operator and the target as distinct actors, and the owner can
 * terminate any active impersonation.
 */
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { impersonationSessions, users } from '../db/schema.js';
import { env } from '../config/env.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from './audit.js';
import type { Actor } from './actor.js';

const IMPERSONATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Actions an impersonated (read-only support) token must never perform. */
export const IMPERSONATION_FORBIDDEN = [
  'order.place',
  'password.change',
  'destination.change',
  'purchase',
  'payout.request',
  'identity.change',
  'account.destructive',
] as const;
export type ImpersonationForbidden = (typeof IMPERSONATION_FORBIDDEN)[number];

export interface ImpersonationClaims {
  readonly typ: 'impersonation';
  readonly sub: string; // target user id (whose data is viewed)
  readonly op: string; // operator user id
  readonly sid: string; // impersonation session id
  readonly mode: 'READ_ONLY' | 'SUPPORT';
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface StartInput {
  readonly organizationId: string | null;
  readonly operatorUserId: string;
  readonly targetUserId: string;
  readonly reason: string;
  readonly mode?: 'READ_ONLY' | 'SUPPORT';
  readonly actor: Actor;
  readonly ip?: string | null;
  readonly requestId?: string | null;
}

export async function startImpersonation(db: Database, input: StartInput): Promise<{ sessionId: string; token: string; expiresAt: Date }> {
  if (!input.reason || input.reason.trim().length < 3) throw ApiError.badRequest('REASON_REQUIRED', 'A reason is required to view as a customer.');
  const [target] = await db.select({ id: users.id, role: users.role, status: users.status }).from(users).where(eq(users.id, input.targetUserId));
  if (!target) throw ApiError.notFound('CUSTOMER_NOT_FOUND', 'Customer not found.');
  if (target.role !== 'TRADER') throw ApiError.badRequest('NOT_A_CUSTOMER', 'Only customer accounts can be impersonated.');
  if (input.operatorUserId === input.targetUserId) throw ApiError.badRequest('SELF_IMPERSONATION', 'Cannot impersonate yourself.');

  const raw = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS);
  const mode = input.mode ?? 'READ_ONLY';
  const [row] = await db
    .insert(impersonationSessions)
    .values({
      organizationId: input.organizationId,
      operatorUserId: input.operatorUserId,
      targetUserId: input.targetUserId,
      reason: input.reason.trim(),
      mode,
      status: 'ACTIVE',
      tokenHash: hashToken(raw),
      originatingRequestId: input.requestId ?? null,
      ip: input.ip ?? null,
      expiresAt,
    })
    .returning({ id: impersonationSessions.id });
  const claims: ImpersonationClaims = { typ: 'impersonation', sub: input.targetUserId, op: input.operatorUserId, sid: row!.id, mode };
  const token = jwt.sign({ ...claims, jti: raw }, env().JWT_SECRET, { algorithm: 'HS256', expiresIn: Math.floor(IMPERSONATION_TTL_MS / 1000), issuer: 'atlas-futures' });
  await recordAudit(db, {
    organizationId: input.organizationId,
    actor: input.actor,
    subjectType: 'CUSTOMER',
    subjectId: input.targetUserId,
    userId: input.targetUserId,
    action: 'impersonation.started',
    newState: { sessionId: row!.id, mode, operatorUserId: input.operatorUserId },
    reason: input.reason.trim(),
  });
  return { sessionId: row!.id, token, expiresAt };
}

/** Verify an impersonation token against its DB session (active + unexpired). */
export async function verifyImpersonation(db: Database, token: string): Promise<ImpersonationClaims | null> {
  let decoded: Record<string, unknown>;
  try {
    const v = jwt.verify(token, env().JWT_SECRET, { algorithms: ['HS256'], issuer: 'atlas-futures' });
    if (typeof v === 'string') return null;
    decoded = v as Record<string, unknown>;
  } catch {
    return null;
  }
  if (decoded['typ'] !== 'impersonation') return null;
  const sid = decoded['sid'];
  const jti = decoded['jti'];
  if (typeof sid !== 'string' || typeof jti !== 'string') return null;
  const [sess] = await db.select().from(impersonationSessions).where(eq(impersonationSessions.id, sid));
  if (!sess || sess.status !== 'ACTIVE') return null;
  if (sess.expiresAt.getTime() < Date.now()) return null;
  if (sess.tokenHash !== hashToken(jti)) return null;
  return { typ: 'impersonation', sub: sess.targetUserId, op: sess.operatorUserId, sid: sess.id, mode: sess.mode === 'SUPPORT' ? 'SUPPORT' : 'READ_ONLY' };
}

export async function endImpersonation(db: Database, sessionId: string, actor: Actor): Promise<void> {
  const [sess] = await db.select().from(impersonationSessions).where(eq(impersonationSessions.id, sessionId));
  if (!sess) throw ApiError.notFound('SESSION_NOT_FOUND', 'Impersonation session not found.');
  if (sess.status !== 'ACTIVE') return;
  await db.update(impersonationSessions).set({ status: 'ENDED', endedAt: new Date() }).where(eq(impersonationSessions.id, sessionId));
  await recordAudit(db, {
    organizationId: sess.organizationId,
    actor,
    subjectType: 'CUSTOMER',
    subjectId: sess.targetUserId,
    userId: sess.targetUserId,
    action: 'impersonation.ended',
    newState: { sessionId },
    reason: 'impersonation ended',
  });
}

export async function listActiveImpersonations(db: Database) {
  return db
    .select({
      id: impersonationSessions.id,
      operatorUserId: impersonationSessions.operatorUserId,
      targetUserId: impersonationSessions.targetUserId,
      mode: impersonationSessions.mode,
      reason: impersonationSessions.reason,
      startedAt: impersonationSessions.startedAt,
      expiresAt: impersonationSessions.expiresAt,
    })
    .from(impersonationSessions)
    .where(and(eq(impersonationSessions.status, 'ACTIVE'), sql`${impersonationSessions.expiresAt} > now()`))
    .orderBy(desc(impersonationSessions.startedAt));
}

/** Whether a forbidden action is blocked for a given impersonation mode. */
export function impersonationBlocks(mode: 'READ_ONLY' | 'SUPPORT', action: ImpersonationForbidden): boolean {
  // Every forbidden action is blocked in both modes; SUPPORT mode only widens
  // a small set of SAFE writes handled elsewhere, never these.
  void mode;
  return (IMPERSONATION_FORBIDDEN as readonly string[]).includes(action);
}
