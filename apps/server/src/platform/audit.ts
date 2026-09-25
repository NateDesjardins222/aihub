/**
 * The audit log.
 *
 * Append-only and hash chained. The database refuses UPDATE and DELETE on the
 * table outright (see migration 0006), so this module only has to make sure
 * every row is written once, in order, with the previous row's hash.
 *
 * The chain is per organisation. Writing takes a transaction-scoped advisory
 * lock on the organisation so two concurrent actions cannot both read the same
 * previous hash and produce a fork.
 *
 * This is deliberately NOT the same thing as `account_events`, which is the
 * engine's sequenced state stream for WebSocket recovery. That one exists to
 * rebuild a client's view; this one exists to answer "who did this, when, and
 * what did it change".
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import type { Actor } from './actor.js';

export type AuditSubject =
  | 'ACCOUNT'
  | 'USER'
  | 'PROFILE'
  | 'ORDER'
  | 'ORGANIZATION'
  | 'PAYOUT'
  | 'CUSTOMER'
  | 'IDENTITY'
  | 'AGREEMENT'
  | 'COMMERCE'
  | 'NOTIFICATION'
  | 'ENFORCEMENT'
  | 'APPEAL'
  | 'AFFILIATE'
  | 'SUPPORT_TICKET'
  | 'SUPPORT_REMEDIATION';

export interface AuditEntry {
  readonly organizationId: string | null;
  readonly actor: Actor;
  readonly subjectType: AuditSubject;
  readonly subjectId?: string | null;
  readonly accountId?: string | null;
  readonly userId?: string | null;
  /** `account.reset`, `admin.account.locked`, `order.filled`, ... */
  readonly action: string;
  readonly prevState?: unknown;
  readonly newState?: unknown;
  readonly reason?: string | null;
  readonly context?: unknown;
}

export interface AuditRow {
  readonly id: string;
  readonly hash: string;
  readonly prevHash: string | null;
  readonly createdAt: Date;
}

/** JSON with its keys in a fixed order, so the same content hashes the same. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function auditHash(prevHash: string | null, payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(prevHash ?? '')
    .update('\n')
    .update(canonical(payload))
    .digest('hex');
}

/** Lock key for an organisation's chain. Postgres advisory locks take bigints. */
function chainKey(organizationId: string | null): number {
  const digest = createHash('sha256').update(organizationId ?? 'global').digest();
  // 31 bits: comfortably inside a signed 32-bit advisory lock key.
  return digest.readUInt32BE(0) & 0x7fffffff;
}

export async function recordAudit(db: Database, entry: AuditEntry): Promise<AuditRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${chainKey(entry.organizationId)})`);

    const [previous] = await tx
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .where(
        entry.organizationId === null
          ? sql`${auditLog.organizationId} is null`
          : eq(auditLog.organizationId, entry.organizationId),
      )
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(1);

    // The timestamp is part of the hash, so it is chosen here rather than by
    // the column default - a hash cannot cover a value it never saw.
    const createdAt = new Date();
    const prevHash = previous?.hash ?? null;
    const payload = {
      organizationId: entry.organizationId,
      actorType: entry.actor.type,
      actorUserId: entry.actor.userId ?? null,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId ?? null,
      accountId: entry.accountId ?? null,
      userId: entry.userId ?? null,
      action: entry.action,
      prevState: entry.prevState ?? null,
      newState: entry.newState ?? null,
      reason: entry.reason ?? null,
      createdAt: createdAt.toISOString(),
    };

    const [row] = await tx
      .insert(auditLog)
      .values({
        organizationId: entry.organizationId,
        actorType: entry.actor.type,
        actorUserId: entry.actor.userId ?? null,
        actorLabel: entry.actor.label ?? null,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId ?? null,
        accountId: entry.accountId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        prevState: (entry.prevState ?? null) as never,
        newState: (entry.newState ?? null) as never,
        reason: entry.reason ?? null,
        context: (entry.context ?? null) as never,
        requestId: entry.actor.requestId ?? null,
        ip: entry.actor.ip ?? null,
        prevHash,
        hash: auditHash(prevHash, payload),
        createdAt,
      })
      .returning();

    return {
      id: row!.id,
      hash: row!.hash,
      prevHash: row!.prevHash,
      createdAt: row!.createdAt,
    };
  });
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly checked: number;
  /** The id of the first row whose hash does not follow from the one before. */
  readonly brokenAt: string | null;
}

/**
 * Walk an organisation's chain.
 *
 * A row that was removed or altered out of band - by a direct connection, a
 * restore from a doctored dump - shows up here as a break, because the next
 * row's `prev_hash` no longer matches what precedes it.
 *
 * `since` verifies a window rather than the whole history, which is what an
 * administrator asking "has anything been tampered with this month" wants. The
 * first row of a window has nothing before it to link to, so only its own
 * content hash is checked.
 */
export async function verifyAuditChain(
  db: Database,
  organizationId: string,
  options: { since?: Date; limit?: number } = {},
): Promise<ChainVerification> {
  const limit = options.limit ?? 10_000;
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      options.since
        ? and(eq(auditLog.organizationId, organizationId), gte(auditLog.createdAt, options.since))
        : eq(auditLog.organizationId, organizationId),
    )
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
    .limit(limit);

  let previousHash: string | null = null;
  let checked = 0;
  for (const row of rows) {
    const expected = auditHash(row.prevHash, {
      organizationId: row.organizationId,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      accountId: row.accountId,
      userId: row.userId,
      action: row.action,
      prevState: row.prevState ?? null,
      newState: row.newState ?? null,
      reason: row.reason ?? null,
      createdAt: row.createdAt.toISOString(),
    });
    if (row.hash !== expected) return { ok: false, checked, brokenAt: row.id };
    if (checked > 0 && row.prevHash !== previousHash) {
      return { ok: false, checked, brokenAt: row.id };
    }
    previousHash = row.hash;
    checked += 1;
  }
  return { ok: true, checked, brokenAt: null };
}

/** Recent audit entries for one account, newest first. */
export async function accountAudit(db: Database, accountId: string, limit = 100) {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.accountId, accountId))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

/** Recent audit entries for one user, newest first. */
export async function userAudit(db: Database, userId: string, limit = 100) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}
