/**
 * Operational incidents (M10-H).
 *
 * An incident groups many alerts/failures into one investigable record so a
 * provider outage that affects hundreds of accounts becomes ONE incident, not
 * hundreds of notifications. `openOrGroupIncident` is idempotent on an open
 * dedupe key. The lifecycle is OPEN → ACKNOWLEDGED → INVESTIGATING → IDENTIFIED →
 * MONITORING → RESOLVED (with reopen from RESOLVED/MONITORING → INVESTIGATING).
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Database } from '../db/client.js';
import { alerts, incidentLinks, incidents } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from './audit.js';
import type { Actor } from './actor.js';

export const INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

const TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  OPEN: ['ACKNOWLEDGED', 'INVESTIGATING', 'MONITORING', 'RESOLVED'],
  ACKNOWLEDGED: ['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED'],
  INVESTIGATING: ['IDENTIFIED', 'MONITORING', 'RESOLVED'],
  IDENTIFIED: ['MONITORING', 'RESOLVED'],
  MONITORING: ['RESOLVED', 'INVESTIGATING'],
  RESOLVED: ['INVESTIGATING'], // reopen on recurrence
};

export function canTransitionIncident(from: IncidentStatus, to: IncidentStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

function publicRef(): string {
  return `HT-INC-${randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`;
}

const NON_RESOLVED: IncidentStatus[] = ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'IDENTIFIED', 'MONITORING'];

export interface OpenIncidentInput {
  readonly organizationId: string | null;
  readonly title: string;
  readonly severity?: 'INFO' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';
  readonly source?: string;
  readonly affectedSubsystem?: string;
  readonly dedupeKey?: string;
  readonly detail?: unknown;
  readonly actor?: Actor;
}

// Advisory-lock namespace for dedupe-key serialization (arbitrary constant).
const INCIDENT_DEDUPE_CLASS = 0x494e43; // 'INC'

async function insertIncident(exec: Database, input: OpenIncidentInput): Promise<{ id: string; publicRef: string }> {
  const ref = publicRef();
  const [row] = await exec
    .insert(incidents)
    .values({
      organizationId: input.organizationId, publicRef: ref, title: input.title, severity: input.severity ?? 'WARNING',
      status: 'OPEN', source: input.source ?? null, affectedSubsystem: input.affectedSubsystem ?? null,
      dedupeKey: input.dedupeKey ?? null, detectedAt: new Date(), detail: (input.detail ?? null) as never,
    })
    .returning({ id: incidents.id, publicRef: incidents.publicRef });
  if (input.actor) {
    await recordAudit(exec, { organizationId: input.organizationId, actor: input.actor, subjectType: 'ORGANIZATION', subjectId: null, action: 'incident.opened', newState: { publicRef: ref, severity: input.severity ?? 'WARNING' }, reason: input.title });
  }
  return { id: row!.id, publicRef: row!.publicRef };
}

/**
 * Find a non-resolved incident with the same dedupe key, or create one.
 *
 * When a dedupe key is present the check-then-insert runs inside a transaction
 * behind a per-key advisory lock, so a concurrent storm of identical opens
 * collapses to exactly ONE incident instead of racing to create duplicates
 * (the "one incident, not hundreds" guarantee under real concurrency).
 */
export async function openOrGroupIncident(db: Database, input: OpenIncidentInput): Promise<{ id: string; publicRef: string; grouped: boolean }> {
  if (!input.dedupeKey) {
    const created = await insertIncident(db, input);
    return { ...created, grouped: false };
  }
  const key = input.dedupeKey;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${INCIDENT_DEDUPE_CLASS}, hashtext(${key}))`);
    const [existing] = await tx
      .select({ id: incidents.id, publicRef: incidents.publicRef })
      .from(incidents)
      .where(and(eq(incidents.dedupeKey, key), ne(incidents.status, 'RESOLVED')))
      .limit(1);
    if (existing) return { id: existing.id, publicRef: existing.publicRef, grouped: true };
    const created = await insertIncident(tx as unknown as Database, input);
    return { ...created, grouped: false };
  });
}

export async function linkToIncident(db: Database, incidentId: string, linkType: string, refId: string): Promise<void> {
  await db.insert(incidentLinks).values({ incidentId, linkType, refId });
}

/** Count of distinct alerts linked to an incident (via alerts.incidentId). */
export async function incidentDetail(db: Database, id: string) {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, id));
  if (!inc) throw ApiError.notFound('INCIDENT_NOT_FOUND', 'Incident not found.');
  const links = await db.select().from(incidentLinks).where(eq(incidentLinks.incidentId, id));
  const linkedAlerts = await db.select({ id: alerts.id, title: alerts.title, severity: alerts.severity, count: alerts.count }).from(alerts).where(eq(alerts.incidentId, id));
  return { incident: inc, links, alerts: linkedAlerts, validNext: TRANSITIONS[inc.status as IncidentStatus] ?? [] };
}

export async function listIncidents(db: Database, organizationId: string, opts: { status?: string; limit?: number } = {}) {
  const conds = [eq(incidents.organizationId, organizationId)];
  if (opts.status) conds.push(eq(incidents.status, opts.status));
  return db.select().from(incidents).where(and(...conds)).orderBy(desc(incidents.createdAt)).limit(Math.min(opts.limit ?? 100, 500));
}

export async function transitionIncident(db: Database, id: string, to: IncidentStatus, actor: Actor, note?: string): Promise<void> {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, id));
  if (!inc) throw ApiError.notFound('INCIDENT_NOT_FOUND', 'Incident not found.');
  const from = inc.status as IncidentStatus;
  if (from === to) return;
  if (!canTransitionIncident(from, to)) throw ApiError.badRequest('INVALID_TRANSITION', `Cannot move an incident from ${from} to ${to}.`);
  const patch: Record<string, unknown> = { status: to, updatedAt: new Date() };
  if (to === 'ACKNOWLEDGED') { patch['acknowledgedByUserId'] = actor.userId ?? null; patch['acknowledgedAt'] = new Date(); }
  if (to === 'RESOLVED') { patch['resolvedAt'] = new Date(); patch['resolution'] = note ?? inc.resolution ?? null; }
  await db.update(incidents).set(patch).where(eq(incidents.id, id));
  await recordAudit(db, { organizationId: inc.organizationId, actor, subjectType: 'ORGANIZATION', subjectId: null, action: 'incident.transition', prevState: { status: from }, newState: { publicRef: inc.publicRef, status: to }, reason: note ?? `${from}→${to}` });
}

export async function assignIncident(db: Database, id: string, assigneeUserId: string, actor: Actor): Promise<void> {
  const [inc] = await db.select({ organizationId: incidents.organizationId }).from(incidents).where(eq(incidents.id, id));
  if (!inc) throw ApiError.notFound('INCIDENT_NOT_FOUND', 'Incident not found.');
  await db.update(incidents).set({ assigneeUserId, updatedAt: new Date() }).where(eq(incidents.id, id));
  await recordAudit(db, { organizationId: inc.organizationId, actor, subjectType: 'ORGANIZATION', subjectId: null, action: 'incident.assigned', newState: { assigneeUserId }, reason: 'assigned' });
}

export async function incidentSummary(db: Database, organizationId: string) {
  const rows = await db
    .select({ status: incidents.status, n: sql<number>`count(*)::int` })
    .from(incidents)
    .where(and(eq(incidents.organizationId, organizationId), ne(incidents.status, 'RESOLVED')))
    .groupBy(incidents.status);
  const open = rows.reduce((n, r) => n + r.n, 0);
  return { open, byStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])) };
}

void NON_RESOLVED;
