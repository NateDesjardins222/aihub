/**
 * Owner OS workspace primitives (M10-J): internal notes, operational tasks,
 * saved views, and async export jobs. Small, audited CRUD. Exports honor
 * permissions upstream and record an audit event.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { exportJobs, internalNotes, opsTasks, savedViews, users, payoutRequests } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from './audit.js';
import type { Actor } from './actor.js';

// ---- internal notes -------------------------------------------------------
export async function addNote(db: Database, input: { organizationId: string | null; subjectType: string; subjectId: string; body: string; pinned?: boolean; visibility?: string; actor: Actor }): Promise<{ id: string }> {
  if (!input.body || input.body.trim().length < 1) throw ApiError.badRequest('EMPTY_NOTE', 'A note body is required.');
  const [row] = await db.insert(internalNotes).values({
    organizationId: input.organizationId, subjectType: input.subjectType, subjectId: input.subjectId,
    authorUserId: input.actor.userId ?? null, authorLabel: input.actor.label ?? null, body: input.body.trim(),
    pinned: input.pinned ?? false, visibility: input.visibility === 'CUSTOMER_VISIBLE' ? 'CUSTOMER_VISIBLE' : 'INTERNAL',
  }).returning({ id: internalNotes.id });
  await recordAudit(db, { organizationId: input.organizationId, actor: input.actor, subjectType: 'CUSTOMER', subjectId: null, action: 'note.added', newState: { subjectType: input.subjectType, subjectId: input.subjectId }, reason: 'internal note' });
  return { id: row!.id };
}
export async function listNotes(db: Database, subjectType: string, subjectId: string) {
  return db.select().from(internalNotes).where(and(eq(internalNotes.subjectType, subjectType), eq(internalNotes.subjectId, subjectId))).orderBy(desc(internalNotes.pinned), desc(internalNotes.createdAt));
}
export async function pinNote(db: Database, id: string, pinned: boolean): Promise<void> {
  await db.update(internalNotes).set({ pinned, updatedAt: new Date() }).where(eq(internalNotes.id, id));
}

// ---- ops tasks ------------------------------------------------------------
export async function createTask(db: Database, input: { organizationId: string | null; title: string; description?: string; priority?: string; assigneeUserId?: string; subjectType?: string; subjectId?: string; dueAt?: Date; actor: Actor }): Promise<{ id: string }> {
  if (!input.title || input.title.trim().length < 3) throw ApiError.badRequest('TITLE_REQUIRED', 'A task title is required.');
  const [row] = await db.insert(opsTasks).values({
    organizationId: input.organizationId, title: input.title.trim(), description: input.description ?? null,
    priority: input.priority ?? 'NORMAL', assigneeUserId: input.assigneeUserId ?? null, creatorUserId: input.actor.userId ?? null,
    subjectType: input.subjectType ?? null, subjectId: input.subjectId ?? null, dueAt: input.dueAt ?? null,
  }).returning({ id: opsTasks.id });
  return { id: row!.id };
}
export async function listTasks(db: Database, opts: { status?: string; assigneeUserId?: string; limit?: number } = {}) {
  const conds = [] as ReturnType<typeof eq>[];
  if (opts.status) conds.push(eq(opsTasks.status, opts.status));
  if (opts.assigneeUserId) conds.push(eq(opsTasks.assigneeUserId, opts.assigneeUserId));
  const q = db.select().from(opsTasks);
  return (conds.length ? q.where(and(...conds)) : q).orderBy(desc(opsTasks.createdAt)).limit(Math.min(opts.limit ?? 100, 500));
}
export async function updateTask(db: Database, id: string, patch: { status?: string; assigneeUserId?: string; priority?: string }): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status) { set['status'] = patch.status; if (patch.status === 'RESOLVED') set['resolvedAt'] = new Date(); }
  if (patch.assigneeUserId !== undefined) set['assigneeUserId'] = patch.assigneeUserId;
  if (patch.priority) set['priority'] = patch.priority;
  const [row] = await db.update(opsTasks).set(set).where(eq(opsTasks.id, id)).returning({ id: opsTasks.id });
  if (!row) throw ApiError.notFound('TASK_NOT_FOUND', 'Task not found.');
}

// ---- saved views ----------------------------------------------------------
export async function saveView(db: Database, input: { organizationId: string | null; ownerUserId: string; scope: string; name: string; filters: unknown; visibility?: string }): Promise<{ id: string }> {
  const [row] = await db.insert(savedViews).values({ organizationId: input.organizationId, ownerUserId: input.ownerUserId, scope: input.scope, name: input.name, filters: (input.filters ?? {}) as never, visibility: input.visibility === 'TEAM' ? 'TEAM' : 'PERSONAL' }).returning({ id: savedViews.id });
  return { id: row!.id };
}
export async function listViews(db: Database, scope: string, userId: string) {
  // Personal views for this user + TEAM views in the same scope.
  return db.select().from(savedViews).where(and(eq(savedViews.scope, scope))).orderBy(desc(savedViews.createdAt)).then((rows) => rows.filter((v) => v.visibility === 'TEAM' || v.ownerUserId === userId));
}
export async function deleteView(db: Database, id: string, userId: string): Promise<void> {
  const [row] = await db.select({ ownerUserId: savedViews.ownerUserId }).from(savedViews).where(eq(savedViews.id, id));
  if (!row) throw ApiError.notFound('VIEW_NOT_FOUND', 'Saved view not found.');
  if (row.ownerUserId !== userId) throw ApiError.forbidden('Not your saved view.');
  await db.delete(savedViews).where(eq(savedViews.id, id));
}

// ---- exports (async job; small kinds materialized to CSV inline) -----------
export const EXPORT_KINDS = ['customers', 'payouts', 'accounts'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function createExportJob(db: Database, input: { organizationId: string; kind: ExportKind; filters?: unknown; actor: Actor }): Promise<{ id: string; status: string; rowCount: number | null }> {
  const [job] = await db.insert(exportJobs).values({ organizationId: input.organizationId, kind: input.kind, filters: (input.filters ?? null) as never, status: 'RUNNING', requestedByUserId: input.actor.userId ?? '00000000-0000-0000-0000-000000000000', startedAt: new Date() }).returning({ id: exportJobs.id });
  await recordAudit(db, { organizationId: input.organizationId, actor: input.actor, subjectType: 'ORGANIZATION', subjectId: null, action: 'export.created', newState: { kind: input.kind }, reason: `export ${input.kind}` });
  try {
    const { rows, header } = await materialize(db, input.organizationId, input.kind);
    const csv = [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
    await db.update(exportJobs).set({ status: 'COMPLETED', rowCount: rows.length, resultRef: csv.slice(0, 2_000_000), completedAt: new Date(), updatedAt: new Date() }).where(eq(exportJobs.id, job!.id));
    return { id: job!.id, status: 'COMPLETED', rowCount: rows.length };
  } catch (e) {
    await db.update(exportJobs).set({ status: 'FAILED', error: (e as Error).message.slice(0, 300), updatedAt: new Date() }).where(eq(exportJobs.id, job!.id));
    return { id: job!.id, status: 'FAILED', rowCount: null };
  }
}

async function materialize(db: Database, organizationId: string, kind: ExportKind): Promise<{ header: string[]; rows: unknown[][] }> {
  if (kind === 'customers') {
    const rows = await db.select({ id: users.id, email: users.email, displayName: users.displayName, createdAt: users.createdAt }).from(users).where(and(eq(users.organizationId, organizationId), eq(users.role, 'TRADER'))).limit(50_000);
    return { header: ['id', 'email', 'displayName', 'createdAt'], rows: rows.map((r) => [r.id, r.email, r.displayName, r.createdAt.toISOString()]) };
  }
  if (kind === 'payouts') {
    const rows = await db.select({ id: payoutRequests.id, accountId: payoutRequests.accountId, state: payoutRequests.state, gross: payoutRequests.requestedGrossMicros, trader: payoutRequests.traderShareMicros }).from(payoutRequests).where(eq(payoutRequests.organizationId, organizationId)).limit(50_000);
    return { header: ['id', 'accountId', 'state', 'requestedGrossMicros', 'traderShareMicros'], rows: rows.map((r) => [r.id, r.accountId, r.state, r.gross, r.trader]) };
  }
  const { accounts } = await import('../db/schema.js');
  const rows = await db.select({ id: accounts.id, publicId: accounts.publicId, status: accounts.status, type: accounts.accountType }).from(accounts).where(eq(accounts.organizationId, organizationId)).limit(50_000);
  return { header: ['id', 'publicId', 'status', 'accountType'], rows: rows.map((r) => [r.id, r.publicId, r.status, r.type]) };
}

export async function listExports(db: Database, organizationId: string, limit = 100) {
  return db.select({ id: exportJobs.id, kind: exportJobs.kind, status: exportJobs.status, rowCount: exportJobs.rowCount, requestedByUserId: exportJobs.requestedByUserId, createdAt: exportJobs.createdAt }).from(exportJobs).where(eq(exportJobs.organizationId, organizationId)).orderBy(desc(exportJobs.createdAt)).limit(Math.min(limit, 500));
}
export async function getExport(db: Database, id: string) {
  const [row] = await db.select().from(exportJobs).where(eq(exportJobs.id, id));
  if (!row) throw ApiError.notFound('EXPORT_NOT_FOUND', 'Export not found.');
  return row;
}
