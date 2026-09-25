/**
 * Support ticket lifecycle + messaging (Milestone 12).
 *
 * The heart of the support system: create a ticket, hold the conversation
 * (customer replies, staff public replies, and INTERNAL notes in one append-only
 * thread), move it through an explicit persisted lifecycle with SLA accounting,
 * assign/prioritise/tag it, resolve it with a customer-safe summary and separate
 * internal notes, and reopen / merge / split without ever destroying history.
 *
 * Safety rules enforced here, not just in the UI:
 *  - a customer only ever touches their OWN ticket, and only adds CUSTOMER-visible
 *    messages; an INTERNAL note is never returned to a customer;
 *  - staff status changes are guarded by optimistic concurrency (version);
 *  - messages are idempotent per (ticket, idempotencyKey) so a retry never dupes.
 */
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  supportMessages, supportTicketEvents, supportTicketLinks, supportTickets, users,
} from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from './actor.js';
import { recordAudit } from './audit.js';
import {
  canTransitionTicket, generateTicketRef, getSupportConfig, listCategories, slaPolicy,
  suggestPriority, TERMINAL_STATUSES, WAITING_STATUSES,
  type Priority, type ResolutionCode, type RootCauseCategory, type TicketStatus, type SupportTeam,
} from './support-config.js';

const ORG_LOCK_CLASS = 0x53555050; // 'SUPP'

// ---------------------------------------------------------------------------
// SLA timing (business-hours-aware when the policy opts in; elapsed otherwise)
// ---------------------------------------------------------------------------
interface BusinessHours { timezone: string; days: number[]; start: string; end: string; observeHours: boolean }

/** Add `minutes` to `from`, counting only working minutes when observeHours is on. */
export function addSlaMinutes(from: Date, minutes: number, bh: BusinessHours | null): Date {
  if (!bh || !bh.observeHours) return new Date(from.getTime() + minutes * 60_000);
  const [sh, sm] = bh.start.split(':').map(Number);
  const [eh, em] = bh.end.split(':').map(Number);
  const startMin = (sh ?? 9) * 60 + (sm ?? 0);
  const endMin = (eh ?? 17) * 60 + (em ?? 0);
  const dayMinutes = Math.max(1, endMin - startMin);
  let remaining = minutes;
  const cursor = new Date(from);
  let guard = 0;
  while (remaining > 0 && guard < 100_000) {
    guard += 1;
    const dow = cursor.getUTCDay();
    const minuteOfDay = cursor.getUTCHours() * 60 + cursor.getUTCMinutes();
    if (!bh.days.includes(dow) || minuteOfDay >= endMin) {
      // advance to next day's open
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      continue;
    }
    if (minuteOfDay < startMin) { cursor.setUTCHours(Math.floor(startMin / 60), startMin % 60, 0, 0); continue; }
    const availToday = Math.min(dayMinutes, endMin - minuteOfDay);
    const use = Math.min(remaining, availToday);
    cursor.setTime(cursor.getTime() + use * 60_000);
    remaining -= use;
  }
  return cursor;
}

async function computeSlaDue(db: Database, organizationId: string, policyKey: string, priority: Priority, now: Date) {
  const p = await slaPolicy(db, organizationId, policyKey);
  if (!p) return { firstResponseDueAt: null as Date | null, resolutionDueAt: null as Date | null, policyKey };
  const bh = (p.businessHours as BusinessHours | null) ?? null;
  const fr = (p.firstResponseMinsByPriority as Record<string, number>)[priority];
  const res = (p.resolutionMinsByPriority as Record<string, number>)[priority];
  return {
    firstResponseDueAt: fr != null ? addSlaMinutes(now, fr, bh) : null,
    resolutionDueAt: res != null ? addSlaMinutes(now, res, bh) : null,
    policyKey,
  };
}

async function ticketEvent(db: Database, t: { organizationId: string; ticketId: string; type: string; from?: string | null; to?: string | null; actor: Actor; reason?: string | null; detail?: unknown }) {
  await db.insert(supportTicketEvents).values({
    organizationId: t.organizationId, ticketId: t.ticketId, type: t.type,
    fromValue: t.from ?? null, toValue: t.to ?? null, actorUserId: t.actor.userId ?? null,
    actorType: t.actor.type === 'USER' ? 'CUSTOMER' : 'STAFF', reason: t.reason ?? null, detail: (t.detail ?? null) as never,
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export interface SubmitTicketInput {
  readonly organizationId: string;
  readonly customerUserId: string;
  readonly customerIdentityId?: string | null;
  readonly categoryKey: string;
  readonly subcategoryKey?: string | null;
  readonly subject: string;
  readonly body: string;
  readonly customerUrgency?: Priority | null;
  readonly signals?: Parameters<typeof suggestPriority>[2];
  readonly links?: Array<{ objectType: string; objectId: string; label?: string }>;
  readonly idempotencyKey?: string | null;
  readonly actor: Actor;
}

export async function submitTicket(db: Database, input: SubmitTicketInput): Promise<{ id: string; publicRef: string }> {
  const cats = await listCategories(db, input.organizationId);
  const cat = cats.find((c) => c.key === input.categoryKey);
  if (!cat) throw ApiError.badRequest('UNKNOWN_CATEGORY', 'That support category does not exist.');
  if (input.subcategoryKey) {
    const sub = cats.find((c) => c.key === input.subcategoryKey && c.parentKey === input.categoryKey);
    if (!sub) throw ApiError.badRequest('UNKNOWN_SUBCATEGORY', 'That subcategory does not exist for this category.');
  }
  const cfg = await getSupportConfig(db, input.organizationId);
  const now = new Date();
  const defaultPriority = (cat.defaultPriority as Priority) ?? 'NORMAL';
  const suggested = suggestPriority(input.subcategoryKey ?? input.categoryKey, defaultPriority, input.signals);
  const priority = suggested; // authoritative starts at the suggested value; staff can change
  const team = (cat.team as SupportTeam | null) ?? 'GENERAL_SUPPORT';
  const sla = await computeSlaDue(db, input.organizationId, cfg.settings.defaultSlaPolicyKey, priority, now);

  const publicRef = await uniqueRef(db);
  const [ticket] = await db.insert(supportTickets).values({
    organizationId: input.organizationId, publicRef, customerUserId: input.customerUserId,
    customerIdentityId: input.customerIdentityId ?? null, categoryKey: input.categoryKey,
    subcategoryKey: input.subcategoryKey ?? null, subject: input.subject.slice(0, 200), status: 'OPEN',
    priority, customerUrgency: input.customerUrgency ?? null, suggestedPriority: suggested, team,
    slaPolicyKey: sla.policyKey, firstResponseDueAt: sla.firstResponseDueAt, resolutionDueAt: sla.resolutionDueAt,
    lastCustomerAt: now,
  }).returning();

  await db.insert(supportMessages).values({
    organizationId: input.organizationId, ticketId: ticket!.id, senderUserId: input.customerUserId,
    senderType: 'CUSTOMER', visibility: 'CUSTOMER', body: input.body,
    idempotencyKey: input.idempotencyKey ?? `create-${ticket!.id}`,
  });

  for (const l of input.links ?? []) {
    await db.insert(supportTicketLinks).values({
      organizationId: input.organizationId, ticketId: ticket!.id, objectType: l.objectType,
      objectId: l.objectId, label: l.label ?? null, auto: true, linkedByUserId: input.customerUserId,
    }).onConflictDoNothing();
  }

  await ticketEvent(db, { organizationId: input.organizationId, ticketId: ticket!.id, type: 'CREATED', to: 'OPEN', actor: input.actor });
  await recordAudit(db, { organizationId: input.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: ticket!.id, userId: input.customerUserId, action: 'support.ticket.created', newState: { publicRef, categoryKey: input.categoryKey, priority }, reason: input.subject.slice(0, 120) });
  return { id: ticket!.id, publicRef };
}

async function uniqueRef(db: Database): Promise<string> {
  for (let i = 0; i < 8; i += 1) {
    const ref = generateTicketRef();
    const [exists] = await db.select({ id: supportTickets.id }).from(supportTickets).where(eq(supportTickets.publicRef, ref));
    if (!exists) return ref;
  }
  throw ApiError.conflict('REF_COLLISION', 'Could not allocate a ticket reference.');
}

/** Recent-duplicate detection: an open ticket by the same customer in the same
 *  (sub)category within the configured window. Suggestion only — never auto-close. */
export async function findRecentDuplicate(db: Database, organizationId: string, customerUserId: string, categoryKey: string, subcategoryKey: string | null): Promise<{ id: string; publicRef: string } | null> {
  const cfg = await getSupportConfig(db, organizationId);
  const since = new Date(Date.now() - cfg.settings.duplicateWindowMinutes * 60_000);
  const [row] = await db.select({ id: supportTickets.id, publicRef: supportTickets.publicRef })
    .from(supportTickets)
    .where(and(
      eq(supportTickets.organizationId, organizationId), eq(supportTickets.customerUserId, customerUserId),
      eq(supportTickets.categoryKey, categoryKey),
      subcategoryKey ? eq(supportTickets.subcategoryKey, subcategoryKey) : sql`${supportTickets.subcategoryKey} is null`,
      gte(supportTickets.createdAt, since),
      sql`${supportTickets.status} not in ('RESOLVED','CLOSED')`,
    ))
    .orderBy(desc(supportTickets.createdAt)).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function getTicketRow(db: Database, ticketId: string) {
  const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId));
  return t ?? null;
}
export async function getTicketByRef(db: Database, organizationId: string, publicRef: string) {
  const [t] = await db.select().from(supportTickets).where(and(eq(supportTickets.organizationId, organizationId), eq(supportTickets.publicRef, publicRef)));
  return t ?? null;
}

/** Messages. Staff see everything; a customer view NEVER includes INTERNAL notes. */
export async function listMessages(db: Database, ticketId: string, opts: { includeInternal: boolean }) {
  const rows = await db.select({
    id: supportMessages.id, senderUserId: supportMessages.senderUserId, senderType: supportMessages.senderType,
    visibility: supportMessages.visibility, body: supportMessages.body, createdAt: supportMessages.createdAt,
    senderName: users.displayName,
  }).from(supportMessages).leftJoin(users, eq(users.id, supportMessages.senderUserId))
    .where(eq(supportMessages.ticketId, ticketId)).orderBy(asc(supportMessages.createdAt));
  const visible = opts.includeInternal ? rows : rows.filter((r) => r.visibility === 'CUSTOMER');
  // For the customer projection, never leak a staff member's identity by name.
  return visible.map((r) => ({
    id: r.id, senderType: r.senderType, visibility: r.visibility, body: r.body, createdAt: r.createdAt,
    senderName: opts.includeInternal ? (r.senderName ?? null) : r.senderType === 'CUSTOMER' ? (r.senderName ?? 'You') : 'Happy Trader Support',
  }));
}

export async function listCustomerTickets(db: Database, organizationId: string, customerUserId: string) {
  return db.select({
    id: supportTickets.id, publicRef: supportTickets.publicRef, subject: supportTickets.subject,
    categoryKey: supportTickets.categoryKey, status: supportTickets.status, priority: supportTickets.priority,
    createdAt: supportTickets.createdAt, updatedAt: supportTickets.updatedAt, lastStaffAt: supportTickets.lastStaffAt,
    resolvedAt: supportTickets.resolvedAt, resolutionSummaryCustomer: supportTickets.resolutionSummaryCustomer,
  }).from(supportTickets)
    .where(and(eq(supportTickets.organizationId, organizationId), eq(supportTickets.customerUserId, customerUserId)))
    .orderBy(desc(supportTickets.updatedAt)).limit(200);
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
export interface AddMessageInput {
  readonly ticketId: string;
  readonly senderType: 'CUSTOMER' | 'STAFF' | 'SYSTEM';
  readonly visibility: 'CUSTOMER' | 'INTERNAL';
  readonly body: string;
  readonly mentions?: string[];
  readonly idempotencyKey?: string | null;
  readonly actor: Actor;
}
export async function addMessage(db: Database, input: AddMessageInput): Promise<{ id: string; deduped: boolean }> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  if (input.senderType === 'CUSTOMER' && input.visibility !== 'CUSTOMER') {
    throw ApiError.forbidden('A customer cannot post an internal note.');
  }
  if (TERMINAL_STATUSES.includes(t.status as TicketStatus) && input.senderType === 'CUSTOMER') {
    throw ApiError.badRequest('TICKET_CLOSED', 'This request is resolved. Please reopen it or open a new one.');
  }
  const now = new Date();
  // Idempotent insert: a retried client message collapses to one row.
  const key = input.idempotencyKey ?? null;
  if (key) {
    const [existing] = await db.select({ id: supportMessages.id }).from(supportMessages)
      .where(and(eq(supportMessages.ticketId, input.ticketId), eq(supportMessages.idempotencyKey, key)));
    if (existing) return { id: existing.id, deduped: true };
  }
  let inserted;
  try {
    [inserted] = await db.insert(supportMessages).values({
      organizationId: t.organizationId, ticketId: input.ticketId, senderUserId: input.actor.userId ?? null,
      senderType: input.senderType, visibility: input.visibility, body: input.body,
      mentions: (input.mentions ?? null) as never, idempotencyKey: key,
    }).returning();
  } catch (e) {
    if (String((e as Error).message).includes('support_messages_idem_key') && key) {
      const [existing] = await db.select({ id: supportMessages.id }).from(supportMessages)
        .where(and(eq(supportMessages.ticketId, input.ticketId), eq(supportMessages.idempotencyKey, key)));
      if (existing) return { id: existing.id, deduped: true };
    }
    throw e;
  }

  // Timeline bookkeeping: last-touch stamps and SLA first-response.
  const patch: Record<string, unknown> = { updatedAt: now };
  if (input.senderType === 'CUSTOMER') patch['lastCustomerAt'] = now;
  if (input.senderType === 'STAFF' && input.visibility === 'CUSTOMER') {
    patch['lastStaffAt'] = now;
    if (!t.slaFirstRespondedAt) patch['slaFirstRespondedAt'] = now;
  }
  await db.update(supportTickets).set(patch).where(eq(supportTickets.id, input.ticketId));
  await recordAudit(db, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: input.visibility === 'INTERNAL' ? 'support.note.added' : 'support.message.sent', newState: { senderType: input.senderType, visibility: input.visibility } });
  return { id: inserted!.id, deduped: false };
}

// ---------------------------------------------------------------------------
// Lifecycle transitions (optimistic concurrency + SLA pause accounting)
// ---------------------------------------------------------------------------
export async function transitionStatus(db: Database, input: { ticketId: string; to: TicketStatus; actor: Actor; reason?: string; expectedVersion?: number }): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(${ORG_LOCK_CLASS}, hashtext(${input.ticketId}))`);
    const [t] = await tx.select().from(supportTickets).where(eq(supportTickets.id, input.ticketId));
    if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
    if (input.expectedVersion != null && input.expectedVersion !== t.version) {
      throw ApiError.conflict('STALE_TICKET', 'This ticket changed since you loaded it. Reload and try again.', { currentVersion: t.version });
    }
    const from = t.status as TicketStatus;
    if (from === input.to) return;
    if (!canTransitionTicket(from, input.to)) {
      throw ApiError.badRequest('INVALID_TRANSITION', `Cannot move a ticket from ${from} to ${input.to}.`);
    }
    const now = new Date();
    const patch: Record<string, unknown> = { status: input.to, version: t.version + 1, updatedAt: now };

    const enteringWaiting = WAITING_STATUSES.includes(input.to);
    const leavingWaiting = WAITING_STATUSES.includes(from) && !enteringWaiting;
    if (enteringWaiting && !t.slaPausedAt) patch['slaPausedAt'] = now;
    if (leavingWaiting && t.slaPausedAt) {
      const pausedMs = now.getTime() - new Date(t.slaPausedAt).getTime();
      patch['slaPausedAt'] = null;
      if (t.resolutionDueAt) patch['resolutionDueAt'] = new Date(new Date(t.resolutionDueAt).getTime() + pausedMs);
      if (t.firstResponseDueAt && !t.slaFirstRespondedAt) patch['firstResponseDueAt'] = new Date(new Date(t.firstResponseDueAt).getTime() + pausedMs);
    }
    if (input.to === 'RESOLVED') patch['resolvedAt'] = now;
    if (input.to === 'CLOSED') patch['closedAt'] = now;

    await tx.update(supportTickets).set(patch).where(eq(supportTickets.id, input.ticketId));
    await ticketEvent(tx, { organizationId: t.organizationId, ticketId: input.ticketId, type: 'STATUS_CHANGED', from, to: input.to, actor: input.actor, reason: input.reason });
    await recordAudit(tx, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: 'support.ticket.status', prevState: { status: from }, newState: { status: input.to }, reason: input.reason ?? null });
  });
}

export async function assignTicket(db: Database, input: { ticketId: string; assigneeUserId: string | null; team?: SupportTeam | null; actor: Actor }): Promise<void> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  const patch: Record<string, unknown> = { assigneeUserId: input.assigneeUserId, updatedAt: new Date() };
  if (input.team !== undefined) patch['team'] = input.team;
  await db.update(supportTickets).set(patch).where(eq(supportTickets.id, input.ticketId));
  await ticketEvent(db, { organizationId: t.organizationId, ticketId: input.ticketId, type: 'ASSIGNED', from: t.assigneeUserId, to: input.assigneeUserId, actor: input.actor, detail: { team: input.team } });
  await recordAudit(db, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: 'support.ticket.assigned', newState: { assigneeUserId: input.assigneeUserId, team: input.team } });
}

export async function setPriority(db: Database, input: { ticketId: string; priority: Priority; actor: Actor; reason?: string }): Promise<void> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  await db.update(supportTickets).set({ priority: input.priority, updatedAt: new Date() }).where(eq(supportTickets.id, input.ticketId));
  await ticketEvent(db, { organizationId: t.organizationId, ticketId: input.ticketId, type: 'PRIORITY_CHANGED', from: t.priority, to: input.priority, actor: input.actor, reason: input.reason });
  await recordAudit(db, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: 'support.ticket.priority', prevState: { priority: t.priority }, newState: { priority: input.priority }, reason: input.reason ?? null });
}

export async function setTags(db: Database, input: { ticketId: string; tags: string[]; actor: Actor }): Promise<void> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  const clean = [...new Set(input.tags.map((s) => s.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
  await db.update(supportTickets).set({ tags: clean as never, updatedAt: new Date() }).where(eq(supportTickets.id, input.ticketId));
  await ticketEvent(db, { organizationId: t.organizationId, ticketId: input.ticketId, type: 'TAGS_CHANGED', to: clean.join(','), actor: input.actor });
}

/**
 * Associate (or clear) the incident a ticket belongs to. This is how an operator
 * groups the tickets an incident caused — the inbox can then filter by incidentId
 * and mass-communicate truthfully. It never touches money or the incident itself.
 */
export async function setTicketIncident(db: Database, input: { ticketId: string; incidentId: string | null; actor: Actor }): Promise<void> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  await db.update(supportTickets).set({ incidentId: input.incidentId, updatedAt: new Date() }).where(eq(supportTickets.id, input.ticketId));
  await ticketEvent(db, { organizationId: t.organizationId, ticketId: input.ticketId, type: 'INCIDENT_LINKED', from: t.incidentId ?? null, to: input.incidentId, actor: input.actor });
  await recordAudit(db, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: input.incidentId ? 'support.ticket.incident_linked' : 'support.ticket.incident_unlinked', prevState: { incidentId: t.incidentId }, newState: { incidentId: input.incidentId } });
}

// ---------------------------------------------------------------------------
// Escalate / resolve / reopen / merge / split / csat
// ---------------------------------------------------------------------------
export async function escalateTicket(db: Database, input: { ticketId: string; team: SupportTeam; priority?: Priority; reason: string; note?: string; actor: Actor }): Promise<void> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  const patch: Record<string, unknown> = { status: 'ESCALATED', team: input.team, version: t.version + 1, updatedAt: new Date() };
  if (input.priority) patch['priority'] = input.priority;
  await db.update(supportTickets).set(patch).where(eq(supportTickets.id, input.ticketId));
  await ticketEvent(db, { organizationId: t.organizationId, ticketId: input.ticketId, type: 'ESCALATED', from: t.team, to: input.team, actor: input.actor, reason: input.reason });
  if (input.note) {
    await addMessage(db, { ticketId: input.ticketId, senderType: 'STAFF', visibility: 'INTERNAL', body: `Escalated to ${input.team}: ${input.note}`, actor: input.actor });
  }
  await recordAudit(db, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: 'support.ticket.escalated', newState: { team: input.team }, reason: input.reason });
}

export async function resolveTicket(db: Database, input: { ticketId: string; resolutionCode: ResolutionCode; customerSummary: string; internalNotes?: string; rootCause?: RootCauseCategory; actor: Actor; expectedVersion?: number }): Promise<void> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  if (input.expectedVersion != null && input.expectedVersion !== t.version) throw ApiError.conflict('STALE_TICKET', 'This ticket changed since you loaded it.', { currentVersion: t.version });
  if (!input.customerSummary.trim()) throw ApiError.badRequest('RESOLUTION_SUMMARY_REQUIRED', 'A customer-facing resolution summary is required.');
  const now = new Date();
  await db.update(supportTickets).set({
    status: 'RESOLVED', resolvedAt: now, version: t.version + 1, updatedAt: now,
    resolutionCode: input.resolutionCode, resolutionSummaryCustomer: input.customerSummary,
    resolutionNotesInternal: input.internalNotes ?? null, rootCauseCategory: input.rootCause ?? null,
  }).where(eq(supportTickets.id, input.ticketId));
  await ticketEvent(db, { organizationId: t.organizationId, ticketId: input.ticketId, type: 'RESOLVED', from: t.status, to: 'RESOLVED', actor: input.actor, detail: { resolutionCode: input.resolutionCode, rootCause: input.rootCause } });
  await recordAudit(db, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: 'support.ticket.resolved', newState: { resolutionCode: input.resolutionCode, rootCause: input.rootCause ?? null } });
}

export async function reopenTicket(db: Database, input: { ticketId: string; actor: Actor; reason: string; byCustomer: boolean }): Promise<void> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  if (!TERMINAL_STATUSES.includes(t.status as TicketStatus)) throw ApiError.badRequest('NOT_RESOLVED', 'Only a resolved or closed ticket can be reopened.');
  if (input.byCustomer) {
    const cfg = await getSupportConfig(db, t.organizationId);
    const base = t.resolvedAt ?? t.closedAt ?? t.updatedAt;
    const deadline = new Date(new Date(base).getTime() + cfg.settings.reopenWindowDays * 86_400_000);
    if (Date.now() > deadline.getTime()) throw ApiError.badRequest('REOPEN_WINDOW_CLOSED', 'The reopen window has closed. Please open a new request.');
  }
  const now = new Date();
  await db.update(supportTickets).set({ status: input.byCustomer ? 'OPEN' : 'IN_PROGRESS', resolvedAt: null, closedAt: null, version: t.version + 1, updatedAt: now, lastCustomerAt: input.byCustomer ? now : t.lastCustomerAt }).where(eq(supportTickets.id, input.ticketId));
  await ticketEvent(db, { organizationId: t.organizationId, ticketId: input.ticketId, type: 'REOPENED', from: t.status, to: input.byCustomer ? 'OPEN' : 'IN_PROGRESS', actor: input.actor, reason: input.reason });
  await recordAudit(db, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: 'support.ticket.reopened', reason: input.reason });
}

/** Merge `secondaryId` into `primaryId`: the secondary is CLOSED and points at the
 *  primary. History on both is preserved (append-only); nothing is deleted. */
export async function mergeTickets(db: Database, input: { primaryId: string; secondaryId: string; actor: Actor }): Promise<void> {
  if (input.primaryId === input.secondaryId) throw ApiError.badRequest('SAME_TICKET', 'Cannot merge a ticket into itself.');
  const primary = await getTicketRow(db, input.primaryId);
  const secondary = await getTicketRow(db, input.secondaryId);
  if (!primary || !secondary) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  if (primary.customerUserId !== secondary.customerUserId) throw ApiError.badRequest('DIFFERENT_CUSTOMER', 'Only two tickets from the same customer can be merged.');
  const now = new Date();
  await db.update(supportTickets).set({ status: 'CLOSED', mergedIntoTicketId: input.primaryId, closedAt: now, version: secondary.version + 1, updatedAt: now }).where(eq(supportTickets.id, input.secondaryId));
  await ticketEvent(db, { organizationId: secondary.organizationId, ticketId: input.secondaryId, type: 'MERGED', to: primary.publicRef, actor: input.actor });
  await ticketEvent(db, { organizationId: primary.organizationId, ticketId: input.primaryId, type: 'MERGE_RECEIVED', from: secondary.publicRef, actor: input.actor });
  await recordAudit(db, { organizationId: primary.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.primaryId, action: 'support.ticket.merged', newState: { secondary: secondary.publicRef } });
}

/** Split off a linked follow-up ticket for an unrelated issue in the same thread. */
export async function splitTicket(db: Database, input: { fromTicketId: string; subject: string; categoryKey: string; body: string; actor: Actor }): Promise<{ id: string; publicRef: string }> {
  const parent = await getTicketRow(db, input.fromTicketId);
  if (!parent) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  const created = await submitTicket(db, {
    organizationId: parent.organizationId, customerUserId: parent.customerUserId, customerIdentityId: parent.customerIdentityId,
    categoryKey: input.categoryKey, subject: input.subject, body: input.body, actor: input.actor,
  });
  await db.update(supportTickets).set({ followUpToTicketId: input.fromTicketId }).where(eq(supportTickets.id, created.id));
  await ticketEvent(db, { organizationId: parent.organizationId, ticketId: input.fromTicketId, type: 'SPLIT', to: created.publicRef, actor: input.actor });
  return created;
}

export async function submitCsat(db: Database, input: { ticketId: string; customerUserId: string; rating: number; comment?: string }): Promise<void> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  if (t.customerUserId !== input.customerUserId) throw ApiError.forbidden('Not your ticket.');
  if (!TERMINAL_STATUSES.includes(t.status as TicketStatus)) throw ApiError.badRequest('NOT_RESOLVED', 'You can rate a request once it is resolved.');
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw ApiError.badRequest('INVALID_RATING', 'Rating must be 1–5.');
  await db.update(supportTickets).set({ csatRating: input.rating, csatComment: input.comment?.slice(0, 1000) ?? null, updatedAt: new Date() }).where(eq(supportTickets.id, input.ticketId));
  await recordAudit(db, { organizationId: t.organizationId, actor: { type: 'USER', userId: input.customerUserId }, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: 'support.ticket.rated', newState: { rating: input.rating } });
}
