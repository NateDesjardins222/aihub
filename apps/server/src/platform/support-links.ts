/**
 * Ticket ⇄ business-object linking, evidence, customer context, and the
 * investigation timeline (Milestone 12-E).
 *
 * A ticket links to REAL objects (account, order, payout, purchase, affiliate,
 * incident…) so staff never chase free-text ids. Ownership is verified: a customer
 * can only link objects that belong to them (forging a link to another customer's
 * account is refused). The timeline is drawn from the canonical M10 event/audit
 * streams — never fabricated.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  accounts, affiliateCommissions, affiliates, certificates, commercialOrders, orders, executions,
  payoutRequests, positions, supportEvidence, supportTicketLinks, supportTickets,
} from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from './actor.js';
import { recordAudit } from './audit.js';
import { LINKABLE_OBJECT_TYPES, type LinkableObjectType } from './support-config.js';
import { queryOpsEvents } from './ops-events.js';
import { getTicketRow } from './support-tickets.js';

/** Object types a CUSTOMER may link themselves (they must own the object). */
const CUSTOMER_LINKABLE: LinkableObjectType[] = ['account', 'order', 'execution', 'position', 'purchase', 'reset', 'payout', 'certificate', 'affiliate', 'commission'];

export interface OwnershipResult { readonly ownerUserId: string | null; readonly label: string; readonly exists: boolean }

/**
 * Resolve an object, its owner, and a human label. Returns exists:false when the
 * id does not resolve. Ownership is null for org-level objects (incident/job/…).
 */
export async function resolveObject(db: Database, organizationId: string, objectType: string, objectId: string): Promise<OwnershipResult> {
  const notFound: OwnershipResult = { ownerUserId: null, label: objectId, exists: false };
  switch (objectType) {
    case 'account': {
      const [a] = await db.select({ userId: accounts.userId, publicId: accounts.publicId, org: accounts.organizationId }).from(accounts).where(eq(accounts.id, objectId));
      return a && a.org === organizationId ? { ownerUserId: a.userId, label: a.publicId ?? objectId, exists: true } : notFound;
    }
    case 'purchase':
    case 'reset': {
      const [o] = await db.select({ userId: commercialOrders.userId, org: commercialOrders.organizationId, source: commercialOrders.source }).from(commercialOrders).where(eq(commercialOrders.id, objectId));
      return o && o.org === organizationId ? { ownerUserId: o.userId, label: `${o.source} order`, exists: true } : notFound;
    }
    case 'order': {
      const [o] = await db.select({ accountId: orders.accountId }).from(orders).where(eq(orders.id, objectId));
      if (!o) return notFound;
      const [a] = await db.select({ userId: accounts.userId, org: accounts.organizationId }).from(accounts).where(eq(accounts.id, o.accountId));
      return a && a.org === organizationId ? { ownerUserId: a.userId, label: 'Trading order', exists: true } : notFound;
    }
    case 'execution': {
      const [e] = await db.select({ accountId: executions.accountId, symbol: executions.symbol }).from(executions).where(eq(executions.id, objectId));
      if (!e) return notFound;
      const [a] = await db.select({ userId: accounts.userId, org: accounts.organizationId }).from(accounts).where(eq(accounts.id, e.accountId));
      return a && a.org === organizationId ? { ownerUserId: a.userId, label: `Execution ${e.symbol}`, exists: true } : notFound;
    }
    case 'position': {
      const [p] = await db.select({ accountId: positions.accountId, symbol: positions.symbol }).from(positions).where(eq(positions.id, objectId));
      if (!p) return notFound;
      const [a] = await db.select({ userId: accounts.userId, org: accounts.organizationId }).from(accounts).where(eq(accounts.id, p.accountId));
      return a && a.org === organizationId ? { ownerUserId: a.userId, label: `Position ${p.symbol}`, exists: true } : notFound;
    }
    case 'payout': {
      const [p] = await db.select({ accountId: payoutRequests.accountId, org: payoutRequests.organizationId }).from(payoutRequests).where(eq(payoutRequests.id, objectId));
      if (!p || p.org !== organizationId) return notFound;
      const [a] = await db.select({ userId: accounts.userId }).from(accounts).where(eq(accounts.id, p.accountId));
      return { ownerUserId: a?.userId ?? null, label: 'Payout request', exists: true };
    }
    case 'certificate': {
      const [c] = await db.select({ accountId: certificates.accountId, publicId: certificates.certificatePublicId }).from(certificates).where(eq(certificates.id, objectId));
      if (!c) return notFound;
      let ownerUserId: string | null = null;
      if (c.accountId) { const [a] = await db.select({ userId: accounts.userId }).from(accounts).where(eq(accounts.id, c.accountId)); ownerUserId = a?.userId ?? null; }
      return { ownerUserId, label: c.publicId ?? 'Certificate', exists: true };
    }
    case 'affiliate': {
      const [a] = await db.select({ userId: affiliates.userId, publicId: affiliates.publicId, org: affiliates.organizationId }).from(affiliates).where(eq(affiliates.id, objectId));
      return a && a.org === organizationId ? { ownerUserId: a.userId, label: a.publicId ?? 'Affiliate', exists: true } : notFound;
    }
    case 'commission': {
      const [c] = await db.select({ affiliateId: affiliateCommissions.affiliateId, org: affiliateCommissions.organizationId }).from(affiliateCommissions).where(eq(affiliateCommissions.id, objectId));
      if (!c || c.org !== organizationId) return notFound;
      const [a] = await db.select({ userId: affiliates.userId }).from(affiliates).where(eq(affiliates.id, c.affiliateId));
      return { ownerUserId: a?.userId ?? null, label: 'Affiliate commission', exists: true };
    }
    // Org-level objects: staff-linkable only; existence is not customer-verifiable here.
    case 'incident': case 'job': case 'webhook': case 'agreement': case 'session':
    case 'payout_operation': case 'enforcement_case': case 'appeal':
      return { ownerUserId: null, label: `${objectType}:${objectId.slice(0, 8)}`, exists: true };
    default:
      return notFound;
  }
}

export async function linkObject(db: Database, input: { ticketId: string; objectType: string; objectId: string; label?: string; actor: Actor; auto?: boolean; enforceOwnership?: boolean; customerUserId?: string }): Promise<{ id: string }> {
  if (!(LINKABLE_OBJECT_TYPES as readonly string[]).includes(input.objectType)) {
    throw ApiError.badRequest('UNSUPPORTED_LINK', `Cannot link an object of type ${input.objectType}.`);
  }
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  const resolved = await resolveObject(db, t.organizationId, input.objectType, input.objectId);
  if (!resolved.exists) throw ApiError.badRequest('OBJECT_NOT_FOUND', 'That object does not exist.');
  if (input.enforceOwnership) {
    // A customer may only link objects they own — and only owned object types.
    if (!(CUSTOMER_LINKABLE as string[]).includes(input.objectType)) throw ApiError.forbidden('You cannot link that type of object.');
    const cust = input.customerUserId ?? t.customerUserId;
    if (resolved.ownerUserId !== cust) throw ApiError.forbidden('That object does not belong to you.');
  }
  const [row] = await db.insert(supportTicketLinks).values({
    organizationId: t.organizationId, ticketId: input.ticketId, objectType: input.objectType,
    objectId: input.objectId, label: input.label ?? resolved.label, auto: input.auto ?? false, linkedByUserId: input.actor.userId ?? null,
  }).onConflictDoNothing().returning();
  if (!row) { const [ex] = await db.select({ id: supportTicketLinks.id }).from(supportTicketLinks).where(and(eq(supportTicketLinks.ticketId, input.ticketId), eq(supportTicketLinks.objectType, input.objectType), eq(supportTicketLinks.objectId, input.objectId))); return { id: ex!.id }; }
  await recordAudit(db, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: 'support.ticket.linked', newState: { objectType: input.objectType, objectId: input.objectId } });
  return { id: row.id };
}

export async function unlinkObject(db: Database, input: { ticketId: string; linkId: string; actor: Actor }): Promise<void> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  await db.delete(supportTicketLinks).where(and(eq(supportTicketLinks.id, input.linkId), eq(supportTicketLinks.ticketId, input.ticketId)));
  await recordAudit(db, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: 'support.ticket.unlinked', newState: { linkId: input.linkId } });
}

export async function listLinks(db: Database, ticketId: string) {
  return db.select().from(supportTicketLinks).where(eq(supportTicketLinks.ticketId, ticketId)).orderBy(desc(supportTicketLinks.createdAt));
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------
export async function markEvidence(db: Database, input: { ticketId: string; sourceType: 'ATTACHMENT' | 'OBJECT' | 'EVENT'; sourceRef: string; objectType?: string; description?: string; actor: Actor }): Promise<{ id: string }> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  const [row] = await db.insert(supportEvidence).values({
    organizationId: t.organizationId, ticketId: input.ticketId, sourceType: input.sourceType,
    sourceRef: input.sourceRef, objectType: input.objectType ?? null, description: input.description ?? null,
    createdByUserId: input.actor.userId ?? null,
  }).returning();
  await recordAudit(db, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: 'support.evidence.marked', newState: { sourceType: input.sourceType, sourceRef: input.sourceRef } });
  return { id: row!.id };
}
export async function listEvidence(db: Database, ticketId: string) {
  return db.select().from(supportEvidence).where(eq(supportEvidence.ticketId, ticketId)).orderBy(desc(supportEvidence.createdAt));
}

// ---------------------------------------------------------------------------
// Customer context snapshot (links into Customer 360; no raw secrets)
// ---------------------------------------------------------------------------
export async function customerContextSnapshot(db: Database, organizationId: string, customerUserId: string) {
  const [accts, recentPurchases, recentPayouts, openTickets] = await Promise.all([
    db.select({ id: accounts.id, publicId: accounts.publicId, accountType: accounts.accountType, status: accounts.status, adminHold: accounts.adminHold }).from(accounts).where(and(eq(accounts.organizationId, organizationId), eq(accounts.userId, customerUserId))).orderBy(desc(accounts.createdAt)).limit(25),
    db.select({ id: commercialOrders.id, source: commercialOrders.source, status: commercialOrders.status, amountMicros: commercialOrders.amountMicros, refundedAt: commercialOrders.refundedAt, createdAt: commercialOrders.createdAt }).from(commercialOrders).where(and(eq(commercialOrders.organizationId, organizationId), eq(commercialOrders.userId, customerUserId))).orderBy(desc(commercialOrders.createdAt)).limit(10),
    payoutsForUser(db, organizationId, customerUserId),
    db.select({ id: supportTickets.id, publicRef: supportTickets.publicRef, status: supportTickets.status, categoryKey: supportTickets.categoryKey, createdAt: supportTickets.createdAt }).from(supportTickets).where(and(eq(supportTickets.organizationId, organizationId), eq(supportTickets.customerUserId, customerUserId))).orderBy(desc(supportTickets.createdAt)).limit(10),
  ]);
  return {
    accounts: accts,
    recentPurchases,
    recentPayouts,
    recentTickets: openTickets,
    activeAccounts: accts.filter((a) => ['ACTIVE', 'PENDING', 'GOAL_REACHED', 'LOCKED'].includes(a.status)).length,
  };
}

async function payoutsForUser(db: Database, organizationId: string, customerUserId: string) {
  const accts = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.organizationId, organizationId), eq(accounts.userId, customerUserId)));
  const ids = accts.map((a) => a.id);
  if (ids.length === 0) return [] as Array<{ id: string; state: string; requestedGrossMicros: number | null; createdAt: Date }>;
  return db.select({ id: payoutRequests.id, state: payoutRequests.state, requestedGrossMicros: payoutRequests.requestedGrossMicros, createdAt: payoutRequests.createdAt }).from(payoutRequests).where(inArray(payoutRequests.accountId, ids)).orderBy(desc(payoutRequests.createdAt)).limit(10);
}

// ---------------------------------------------------------------------------
// Investigation timeline (canonical events; never fabricated)
// ---------------------------------------------------------------------------
export async function investigationTimeline(db: Database, organizationId: string, ticketId: string, opts: { limit?: number } = {}) {
  const t = await getTicketRow(db, ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  const links = await listLinks(db, ticketId);
  const accountIds = links.filter((l) => l.objectType === 'account').map((l) => l.objectId);
  const limit = Math.min(opts.limit ?? 60, 200);

  // Customer-wide events, plus any linked-account events, merged and deduped.
  const buckets = await Promise.all([
    queryOpsEvents(db, organizationId, { userId: t.customerUserId, limit }),
    ...accountIds.map((accountId) => queryOpsEvents(db, organizationId, { accountId, limit })),
  ]);
  const seen = new Set<string>();
  const merged = buckets.flat().filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  merged.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return merged.slice(-limit).map((e) => ({ at: e.at, stream: e.stream, type: e.type, summary: e.summary, actor: e.actorLabel ?? e.actorType, accountId: e.accountId, correlationId: e.correlationId }));
}

/** Which tickets reference a given object (for Account 360 / Incident impact). */
export async function ticketsForObject(db: Database, organizationId: string, objectType: string, objectId: string) {
  return db.select({ ticketId: supportTicketLinks.ticketId, publicRef: supportTickets.publicRef, status: supportTickets.status, subject: supportTickets.subject })
    .from(supportTicketLinks)
    .innerJoin(supportTickets, eq(supportTickets.id, supportTicketLinks.ticketId))
    .where(and(eq(supportTicketLinks.organizationId, organizationId), eq(supportTicketLinks.objectType, objectType), eq(supportTicketLinks.objectId, objectId)))
    .orderBy(desc(supportTickets.createdAt)).limit(200);
}

void sql;
