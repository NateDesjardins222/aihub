/**
 * Support inbox, analytics, and the assembled ticket views (Milestone 12-D/J).
 *
 * Server-side filtered + keyset-paginated inbox, factual overview metrics, the
 * staff workspace (thread + full context in one payload) and the customer-safe
 * ticket view. Every SLA state is derived from authoritative timestamps — no fake
 * numbers, no giant unbounded payloads.
 */
import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { supportRemediations, supportTickets, users } from '../db/schema.js';
import { TERMINAL_STATUSES, type TicketStatus } from './support-config.js';
import { getTicketRow, listMessages } from './support-tickets.js';
import { listLinks, listEvidence, customerContextSnapshot, investigationTimeline } from './support-links.js';
import { listAttachments } from './support-attachments.js';
import { listRemediations } from './support-remediation.js';

export type SlaState = 'NONE' | 'ON_TRACK' | 'DUE_SOON' | 'BREACHED' | 'PAUSED' | 'MET';

/** Pure SLA state from the ticket's authoritative timestamps. */
export function slaState(ticket: { status: string; slaPausedAt: Date | null; resolutionDueAt: Date | null; resolvedAt: Date | null }, now = new Date()): SlaState {
  if (TERMINAL_STATUSES.includes(ticket.status as TicketStatus)) {
    if (ticket.resolvedAt && ticket.resolutionDueAt) return new Date(ticket.resolvedAt) <= new Date(ticket.resolutionDueAt) ? 'MET' : 'BREACHED';
    return 'MET';
  }
  if (ticket.slaPausedAt) return 'PAUSED';
  if (!ticket.resolutionDueAt) return 'NONE';
  const due = new Date(ticket.resolutionDueAt).getTime();
  const ms = due - now.getTime();
  if (ms < 0) return 'BREACHED';
  if (ms < 4 * 3_600_000) return 'DUE_SOON';
  return 'ON_TRACK';
}

export interface InboxQuery {
  view?: 'ALL' | 'UNASSIGNED' | 'MINE' | 'URGENT' | 'WAITING_CUSTOMER' | 'WAITING_INTERNAL' | 'WAITING_PROVIDER' | 'ESCALATED' | 'RESOLVED' | 'REOPENED';
  category?: string; priority?: string; team?: string; assigneeUserId?: string; status?: string;
  incidentId?: string; q?: string; cursor?: string | null; limit?: number; viewerUserId?: string;
}

export async function listInbox(db: Database, organizationId: string, query: InboxQuery = {}) {
  const conds = [eq(supportTickets.organizationId, organizationId)];
  const v = query.view ?? 'ALL';
  if (v === 'UNASSIGNED') conds.push(sql`${supportTickets.assigneeUserId} is null`);
  if (v === 'MINE' && query.viewerUserId) conds.push(eq(supportTickets.assigneeUserId, query.viewerUserId));
  if (v === 'URGENT') conds.push(eq(supportTickets.priority, 'URGENT'));
  if (v === 'ESCALATED') conds.push(eq(supportTickets.status, 'ESCALATED'));
  if (v === 'WAITING_CUSTOMER') conds.push(eq(supportTickets.status, 'WAITING_ON_CUSTOMER'));
  if (v === 'WAITING_INTERNAL') conds.push(eq(supportTickets.status, 'WAITING_ON_INTERNAL'));
  if (v === 'WAITING_PROVIDER') conds.push(eq(supportTickets.status, 'WAITING_ON_PROVIDER'));
  if (v === 'RESOLVED') conds.push(inArray(supportTickets.status, ['RESOLVED', 'CLOSED']));
  if (v === 'REOPENED') conds.push(sql`${supportTickets.reopenedFromTicketId} is not null`);
  if (query.category) conds.push(eq(supportTickets.categoryKey, query.category));
  if (query.priority) conds.push(eq(supportTickets.priority, query.priority));
  if (query.team) conds.push(eq(supportTickets.team, query.team));
  if (query.assigneeUserId) conds.push(eq(supportTickets.assigneeUserId, query.assigneeUserId));
  if (query.status) conds.push(eq(supportTickets.status, query.status));
  if (query.incidentId) conds.push(eq(supportTickets.incidentId, query.incidentId));
  if (query.q && query.q.length >= 2) {
    const like = `%${query.q}%`;
    conds.push(or(ilike(supportTickets.publicRef, like), ilike(supportTickets.subject, like))!);
  }
  if (query.cursor) conds.push(lt(supportTickets.updatedAt, new Date(query.cursor)));
  const limit = Math.min(Math.max(query.limit ?? 40, 1), 100);
  const rows = await db.select({
    id: supportTickets.id, publicRef: supportTickets.publicRef, subject: supportTickets.subject,
    categoryKey: supportTickets.categoryKey, status: supportTickets.status, priority: supportTickets.priority,
    team: supportTickets.team, assigneeUserId: supportTickets.assigneeUserId, tags: supportTickets.tags,
    slaPausedAt: supportTickets.slaPausedAt, resolutionDueAt: supportTickets.resolutionDueAt, resolvedAt: supportTickets.resolvedAt,
    incidentId: supportTickets.incidentId, customerUserId: supportTickets.customerUserId,
    customerName: users.displayName, updatedAt: supportTickets.updatedAt, createdAt: supportTickets.createdAt,
  }).from(supportTickets).leftJoin(users, eq(users.id, supportTickets.customerUserId))
    .where(and(...conds)).orderBy(desc(supportTickets.updatedAt)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1]!.updatedAt.toISOString() : null;
  return { tickets: page.map((r) => ({ ...r, sla: slaState(r) })), nextCursor };
}

export async function supportOverview(db: Database, organizationId: string) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [statusCounts, priorityCounts, resolvedToday, reopened, csat, categoryCounts, pendingRemediations, activeForSla] = await Promise.all([
    db.select({ status: supportTickets.status, n: sql<number>`count(*)::int` }).from(supportTickets).where(eq(supportTickets.organizationId, organizationId)).groupBy(supportTickets.status),
    db.select({ n: sql<number>`count(*)::int` }).from(supportTickets).where(and(eq(supportTickets.organizationId, organizationId), eq(supportTickets.priority, 'URGENT'), sql`${supportTickets.status} not in ('RESOLVED','CLOSED')`)),
    db.select({ n: sql<number>`count(*)::int` }).from(supportTickets).where(and(eq(supportTickets.organizationId, organizationId), gte(supportTickets.resolvedAt, startOfDay))),
    db.select({ n: sql<number>`count(*)::int` }).from(supportTickets).where(and(eq(supportTickets.organizationId, organizationId), sql`${supportTickets.reopenedFromTicketId} is not null`)),
    db.select({ avg: sql<number>`coalesce(avg(${supportTickets.csatRating}),0)::float`, n: sql<number>`count(${supportTickets.csatRating})::int` }).from(supportTickets).where(eq(supportTickets.organizationId, organizationId)),
    db.select({ categoryKey: supportTickets.categoryKey, n: sql<number>`count(*)::int` }).from(supportTickets).where(eq(supportTickets.organizationId, organizationId)).groupBy(supportTickets.categoryKey),
    db.select({ n: sql<number>`count(*)::int` }).from(supportRemediations).where(and(eq(supportRemediations.organizationId, organizationId), inArray(supportRemediations.status, ['REQUESTED', 'UNDER_REVIEW']))),
    db.select({ id: supportTickets.id, status: supportTickets.status, slaPausedAt: supportTickets.slaPausedAt, resolutionDueAt: supportTickets.resolutionDueAt, resolvedAt: supportTickets.resolvedAt, assigneeUserId: supportTickets.assigneeUserId })
      .from(supportTickets).where(and(eq(supportTickets.organizationId, organizationId), sql`${supportTickets.status} not in ('RESOLVED','CLOSED')`)).limit(2000),
  ]);
  const byStatus = Object.fromEntries(statusCounts.map((r) => [r.status, r.n]));
  const open = activeForSla.length;
  const unassigned = activeForSla.filter((t) => !t.assigneeUserId).length;
  const breached = activeForSla.filter((t) => slaState(t, now) === 'BREACHED').length;
  const dueSoon = activeForSla.filter((t) => slaState(t, now) === 'DUE_SOON').length;
  return {
    open, unassigned, breached, dueSoon,
    urgent: Number(priorityCounts[0]?.n ?? 0),
    waitingOnCustomer: byStatus['WAITING_ON_CUSTOMER'] ?? 0,
    waitingOnProvider: byStatus['WAITING_ON_PROVIDER'] ?? 0,
    waitingOnInternal: byStatus['WAITING_ON_INTERNAL'] ?? 0,
    escalated: byStatus['ESCALATED'] ?? 0,
    resolvedToday: Number(resolvedToday[0]?.n ?? 0),
    reopened: Number(reopened[0]?.n ?? 0),
    csatAverage: Number(csat[0]?.avg ?? 0), csatCount: Number(csat[0]?.n ?? 0),
    pendingRemediationApprovals: Number(pendingRemediations[0]?.n ?? 0),
    byCategory: Object.fromEntries(categoryCounts.map((r) => [r.categoryKey, r.n])),
    byStatus,
  };
}

/** The full staff workspace payload for one ticket. */
export async function ticketWorkspace(db: Database, organizationId: string, ticketId: string) {
  const ticket = await getTicketRow(db, ticketId);
  if (!ticket || ticket.organizationId !== organizationId) return null;
  const [messages, links, evidence, attachments, remediations, timeline, context, customer] = await Promise.all([
    listMessages(db, ticketId, { includeInternal: true }),
    listLinks(db, ticketId),
    listEvidence(db, ticketId),
    listAttachments(db, ticketId, { includeInternal: true }),
    listRemediations(db, ticketId),
    investigationTimeline(db, organizationId, ticketId).catch(() => []),
    customerContextSnapshot(db, organizationId, ticket.customerUserId),
    db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, ticket.customerUserId)).then((r) => r[0] ?? null),
  ]);
  return { ticket: { ...ticket, sla: slaState(ticket) }, customer, messages, links, evidence, attachments, remediations, timeline, context };
}

/** The customer-safe view: their ticket, public messages + attachments only. */
export async function customerTicketView(db: Database, organizationId: string, customerUserId: string, ticketId: string) {
  const ticket = await getTicketRow(db, ticketId);
  if (!ticket || ticket.organizationId !== organizationId || ticket.customerUserId !== customerUserId) return null;
  const [messages, attachments] = await Promise.all([
    listMessages(db, ticketId, { includeInternal: false }),
    listAttachments(db, ticketId, { includeInternal: false }),
  ]);
  return {
    ticket: {
      id: ticket.id, publicRef: ticket.publicRef, subject: ticket.subject, categoryKey: ticket.categoryKey,
      status: ticket.status, priority: ticket.priority, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt,
      resolvedAt: ticket.resolvedAt, resolutionSummaryCustomer: ticket.resolutionSummaryCustomer,
      csatRating: ticket.csatRating,
    },
    messages, attachments,
  };
}
