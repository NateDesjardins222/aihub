/**
 * Owner alerts + incidents (M10-H, seeded in M10-F for the kill-switch alert).
 *
 * An alert has a severity, a category and an optional dedupe key. Raising an
 * alert whose open dedupe key already exists BUMPS the existing row's count and
 * last-seen timestamp instead of creating a new row — this is what stops one
 * provider outage from becoming 400 separate alerts. Grouping alerts under a
 * single incident is handled in the incident service.
 *
 * Delivery channels (IN_APP/EMAIL/SMS/PUSH) go through a provider abstraction
 * that reports NOT_CONFIGURED honestly; alerts are always recorded in-app.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { alerts } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from './audit.js';
import type { Actor } from './actor.js';

export type AlertSeverity = 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';

export interface RaiseAlertInput {
  readonly organizationId: string | null;
  readonly severity: AlertSeverity;
  readonly category: string;
  readonly title: string;
  readonly body?: string;
  readonly dedupeKey?: string;
  readonly source?: string;
  readonly incidentId?: string | null;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly detail?: unknown;
}

export interface RaisedAlert { readonly id: string; readonly deduped: boolean; readonly count: number }

/**
 * Raise (or coalesce) an alert. Same open dedupe key → bump count + last_seen and
 * escalate severity if higher; otherwise a new OPEN alert. Idempotent-ish under
 * a storm: N identical raises produce ONE row with count N.
 */
export async function raiseAlert(db: Database, input: RaiseAlertInput): Promise<RaisedAlert> {
  const sevRank: Record<AlertSeverity, number> = { INFO: 0, NOTICE: 1, WARNING: 2, CRITICAL: 3, EMERGENCY: 4 };
  if (input.dedupeKey) {
    const [existing] = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.dedupeKey, input.dedupeKey), eq(alerts.status, 'OPEN')))
      .limit(1);
    if (existing) {
      const higher = sevRank[input.severity] > sevRank[existing.severity as AlertSeverity] ? input.severity : (existing.severity as AlertSeverity);
      const [row] = await db
        .update(alerts)
        .set({ count: sql`${alerts.count} + 1`, lastSeenAt: new Date(), severity: higher, incidentId: input.incidentId ?? existing.incidentId, updatedAt: new Date() })
        .where(eq(alerts.id, existing.id))
        .returning({ id: alerts.id, count: alerts.count });
      return { id: row!.id, deduped: true, count: row!.count };
    }
  }
  const [row] = await db
    .insert(alerts)
    .values({
      organizationId: input.organizationId, severity: input.severity, category: input.category, title: input.title,
      body: input.body ?? null, dedupeKey: input.dedupeKey ?? null, status: 'OPEN', incidentId: input.incidentId ?? null,
      source: input.source ?? null, subjectType: input.subjectType ?? null, subjectId: input.subjectId ?? null,
      detail: (input.detail ?? null) as never,
    })
    .returning({ id: alerts.id, count: alerts.count });
  return { id: row!.id, deduped: false, count: row!.count };
}

export interface ListAlertsQuery { readonly status?: string; readonly severity?: string; readonly limit?: number }

export async function listAlerts(db: Database, organizationId: string, q: ListAlertsQuery = {}) {
  const conds = [eq(alerts.organizationId, organizationId)];
  if (q.status) conds.push(eq(alerts.status, q.status));
  if (q.severity) conds.push(eq(alerts.severity, q.severity));
  return db.select().from(alerts).where(and(...conds)).orderBy(desc(alerts.lastSeenAt)).limit(Math.min(q.limit ?? 100, 500));
}

export async function acknowledgeAlert(db: Database, id: string, actor: Actor): Promise<void> {
  const [row] = await db.select({ id: alerts.id, organizationId: alerts.organizationId, status: alerts.status }).from(alerts).where(eq(alerts.id, id));
  if (!row) throw ApiError.notFound('ALERT_NOT_FOUND', 'Alert not found.');
  if (row.status === 'RESOLVED') return;
  await db.update(alerts).set({ status: 'ACKNOWLEDGED', acknowledgedByUserId: actor.userId ?? null, acknowledgedAt: new Date(), updatedAt: new Date() }).where(eq(alerts.id, id));
  await recordAudit(db, { organizationId: row.organizationId, actor, subjectType: 'ORGANIZATION', subjectId: id, action: 'alert.acknowledged', reason: 'alert acknowledged' });
}

export async function resolveAlert(db: Database, id: string, actor: Actor): Promise<void> {
  const [row] = await db.select({ id: alerts.id, organizationId: alerts.organizationId }).from(alerts).where(eq(alerts.id, id));
  if (!row) throw ApiError.notFound('ALERT_NOT_FOUND', 'Alert not found.');
  await db.update(alerts).set({ status: 'RESOLVED', resolvedAt: new Date(), updatedAt: new Date() }).where(eq(alerts.id, id));
  await recordAudit(db, { organizationId: row.organizationId, actor, subjectType: 'ORGANIZATION', subjectId: id, action: 'alert.resolved', reason: 'alert resolved' });
}

/** Open-alert counts by severity for the Command Center. */
export async function alertSummary(db: Database, organizationId: string) {
  const rows = await db
    .select({ severity: alerts.severity, n: sql<number>`count(*)::int` })
    .from(alerts)
    .where(and(eq(alerts.organizationId, organizationId), eq(alerts.status, 'OPEN')))
    .groupBy(alerts.severity);
  const out: Record<string, number> = { INFO: 0, NOTICE: 0, WARNING: 0, CRITICAL: 0, EMERGENCY: 0 };
  for (const r of rows) out[r.severity] = r.n;
  return out;
}

void isNull;
