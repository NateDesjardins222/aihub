/**
 * The canonical operational event query (M10-C).
 *
 * Rather than duplicate a new event table, this reads the two existing
 * authoritative sources — `audit_log` (what staff/system CHANGED, hash-chained)
 * and `domain_events` (what business objects DID) — plus provider connection
 * events (technical), and presents them behind one typed query with filters and
 * a time cursor. The four logging concepts stay semantically distinct via the
 * `stream` field: ACTIVITY, AUDIT, SECURITY, TECHNICAL.
 *
 * Correlation lives inside the payload/context of the underlying rows
 * (`context.correlationId`/`requestId` on audit, `payload.correlationId` on
 * domain events); this module surfaces it uniformly so an owner can pull "every
 * event tied to correlation X".
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { auditLog, domainEvents, providerConnectionEvents } from '../db/schema.js';

export type EventStream = 'ACTIVITY' | 'AUDIT' | 'SECURITY' | 'TECHNICAL';

export interface OpsEvent {
  readonly id: string;
  readonly at: string;
  readonly stream: EventStream;
  readonly type: string;
  readonly actorType: string | null;
  readonly actorLabel: string | null;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly accountId: string | null;
  readonly userId: string | null;
  readonly correlationId: string | null;
  readonly source: string | null;
  readonly summary: string;
}

export interface OpsEventQuery {
  readonly stream?: EventStream;
  readonly accountId?: string;
  readonly userId?: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly correlationId?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit?: number;
}

const SECURITY_PREFIXES = ['staff.', 'impersonation.', 'security.', 'auth.', 'kill_switch', 'break_glass', 'killswitch'];

function classifyAudit(action: string): EventStream {
  return SECURITY_PREFIXES.some((p) => action.startsWith(p) || action.includes(p)) ? 'SECURITY' : 'AUDIT';
}

function correlationOf(ctx: unknown): string | null {
  if (ctx && typeof ctx === 'object') {
    const c = ctx as Record<string, unknown>;
    if (typeof c['correlationId'] === 'string') return c['correlationId'];
    if (typeof c['correlation_id'] === 'string') return c['correlation_id'] as string;
  }
  return null;
}

/** Merge the sources, filter, sort newest-first, and bound the result. */
export async function queryOpsEvents(db: Database, organizationId: string, q: OpsEventQuery = {}): Promise<OpsEvent[]> {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const events: OpsEvent[] = [];

  const wantAudit = !q.stream || q.stream === 'AUDIT' || q.stream === 'SECURITY';
  const wantActivity = !q.stream || q.stream === 'ACTIVITY';
  const wantTechnical = !q.stream || q.stream === 'TECHNICAL';

  if (wantAudit) {
    const conds = [eq(auditLog.organizationId, organizationId)];
    if (q.accountId) conds.push(eq(auditLog.accountId, q.accountId));
    if (q.userId) conds.push(eq(auditLog.userId, q.userId));
    if (q.subjectType) conds.push(eq(auditLog.subjectType, q.subjectType));
    if (q.subjectId) conds.push(eq(auditLog.subjectId, q.subjectId));
    if (q.since) conds.push(gte(auditLog.createdAt, q.since));
    if (q.until) conds.push(lte(auditLog.createdAt, q.until));
    if (q.correlationId) conds.push(sql`(${auditLog.context}->>'correlationId' = ${q.correlationId} or ${auditLog.requestId} = ${q.correlationId})`);
    const rows = await db.select().from(auditLog).where(and(...conds)).orderBy(desc(auditLog.createdAt)).limit(limit);
    for (const r of rows) {
      const stream = classifyAudit(r.action);
      if (q.stream && q.stream !== stream) continue;
      events.push({
        id: r.id, at: r.createdAt.toISOString(), stream, type: r.action,
        actorType: r.actorType, actorLabel: r.actorLabel, subjectType: r.subjectType, subjectId: r.subjectId,
        accountId: r.accountId, userId: r.userId, correlationId: correlationOf(r.context) ?? r.requestId ?? null,
        source: 'audit', summary: `${r.actorLabel ?? r.actorType ?? 'system'} · ${r.action}`,
      });
    }
  }

  if (wantActivity) {
    const conds = [eq(domainEvents.organizationId, organizationId)];
    if (q.accountId) conds.push(eq(domainEvents.accountId, q.accountId));
    if (q.userId) conds.push(eq(domainEvents.userId, q.userId));
    if (q.since) conds.push(gte(domainEvents.occurredAt, q.since));
    if (q.until) conds.push(lte(domainEvents.occurredAt, q.until));
    if (q.correlationId) conds.push(sql`${domainEvents.payload}->>'correlationId' = ${q.correlationId}`);
    const rows = await db.select().from(domainEvents).where(and(...conds)).orderBy(desc(domainEvents.occurredAt)).limit(limit);
    for (const r of rows) {
      events.push({
        id: r.id, at: r.occurredAt.toISOString(), stream: 'ACTIVITY', type: r.type,
        actorType: 'SYSTEM', actorLabel: null, subjectType: r.accountId ? 'ACCOUNT' : r.userId ? 'CUSTOMER' : null,
        subjectId: r.accountId ?? r.userId ?? null, accountId: r.accountId, userId: r.userId,
        correlationId: correlationOf(r.payload), source: 'domain', summary: r.type,
      });
    }
  }

  if (wantTechnical && !q.accountId && !q.userId && !q.subjectId) {
    const conds = [] as ReturnType<typeof eq>[];
    if (q.since) conds.push(gte(providerConnectionEvents.createdAt, q.since));
    if (q.until) conds.push(lte(providerConnectionEvents.createdAt, q.until));
    const rows = await db
      .select()
      .from(providerConnectionEvents)
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(providerConnectionEvents.createdAt))
      .limit(limit);
    for (const r of rows) {
      events.push({
        id: r.id, at: r.createdAt.toISOString(), stream: 'TECHNICAL', type: `${r.provider}.${r.plant}.${r.event}`,
        actorType: 'SERVICE', actorLabel: r.provider, subjectType: 'PROVIDER', subjectId: r.provider,
        accountId: null, userId: null, correlationId: null, source: 'provider',
        summary: `${r.provider} ${r.plant} ${r.event}${r.detail ? ` — ${r.detail}` : ''}`,
      });
    }
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, limit);
}

/** A correlation trace: every event carrying the correlation id, oldest first. */
export async function correlationTrace(db: Database, organizationId: string, correlationId: string): Promise<OpsEvent[]> {
  const events = await queryOpsEvents(db, organizationId, { correlationId, limit: 500 });
  return events.slice().reverse();
}
