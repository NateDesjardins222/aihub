/**
 * Global owner search (M10-C).
 *
 * One query, matched against the identifying columns of the major objects, with
 * results grouped by type. Every result carries a typed link target the console
 * turns into a Universal Object Explorer / 360 route. This is a read surface; the
 * caller is authorized upstream (`customers.read` etc.).
 */
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  accounts, affiliateCodes, affiliates, certificates, commercialOrders, enforcementCases, incidents, orders,
  payoutRequests, supportRemediations, supportTickets, users,
} from '../db/schema.js';

export interface SearchResult {
  readonly type: string;
  readonly id: string;
  readonly label: string;
  readonly sublabel?: string;
}

export interface SearchResponse {
  readonly query: string;
  readonly groups: Array<{ type: string; results: SearchResult[] }>;
  readonly total: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function globalSearch(db: Database, organizationId: string, raw: string, perGroup = 8): Promise<SearchResponse> {
  const q = raw.trim();
  const groups: Array<{ type: string; results: SearchResult[] }> = [];
  if (q.length < 2) return { query: q, groups, total: 0 };
  const isUuid = UUID.test(q);
  const like = `%${q}%`;

  const push = (type: string, results: SearchResult[]) => {
    if (results.length) groups.push({ type, results });
  };
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };

  // Customers (traders) by email / name / uuid.
  push('customer', await safe(async () => {
    const rows = await db
      .select({ id: users.id, email: users.email, displayName: users.displayName, role: users.role })
      .from(users)
      .where(and(eq(users.role, 'TRADER'), isUuid ? eq(users.id, q) : or(ilike(users.email, like), ilike(users.displayName, like))!))
      .limit(perGroup);
    return rows.map((r) => ({ type: 'customer', id: r.id, label: r.displayName, sublabel: r.email }));
  }, []));

  // Staff by email / name / uuid.
  push('staff', await safe(async () => {
    const rows = await db
      .select({ id: users.id, email: users.email, displayName: users.displayName, role: users.role })
      .from(users)
      .where(and(sql`${users.role} <> 'TRADER'`, isUuid ? eq(users.id, q) : or(ilike(users.email, like), ilike(users.displayName, like))!))
      .limit(perGroup);
    return rows.map((r) => ({ type: 'staff', id: r.id, label: `${r.displayName} (${r.role})`, sublabel: r.email }));
  }, []));

  // Accounts by public id (SIM-nnnnnn) or uuid.
  push('account', await safe(async () => {
    const rows = await db
      .select({ id: accounts.id, publicId: accounts.publicId, status: accounts.status })
      .from(accounts)
      .where(isUuid ? eq(accounts.id, q) : ilike(accounts.publicId, like))
      .limit(perGroup);
    return rows.map((r) => ({ type: 'account', id: r.id, label: r.publicId ?? r.id, sublabel: r.status ?? undefined }));
  }, []));

  // Payout requests by uuid.
  if (isUuid) {
    push('payout', await safe(async () => {
      const rows = await db.select({ id: payoutRequests.id, state: payoutRequests.state }).from(payoutRequests).where(eq(payoutRequests.id, q)).limit(perGroup);
      return rows.map((r) => ({ type: 'payout', id: r.id, label: r.id.slice(0, 8), sublabel: r.state ?? undefined }));
    }, []));
    push('order', await safe(async () => {
      const rows = await db.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.id, q)).limit(perGroup);
      return rows.map((r) => ({ type: 'order', id: r.id, label: r.id.slice(0, 8), sublabel: r.status ?? undefined }));
    }, []));
    push('commercial_order', await safe(async () => {
      const rows = await db.select({ id: commercialOrders.id, status: commercialOrders.status }).from(commercialOrders).where(eq(commercialOrders.id, q)).limit(perGroup);
      return rows.map((r) => ({ type: 'commercial_order', id: r.id, label: r.id.slice(0, 8), sublabel: r.status ?? undefined }));
    }, []));
  }

  // Enforcement cases by public ref (HTR-xxxxxx) or uuid.
  push('enforcement_case', await safe(async () => {
    const rows = await db
      .select({ id: enforcementCases.id, publicRef: enforcementCases.publicRef, status: enforcementCases.status })
      .from(enforcementCases)
      .where(isUuid ? eq(enforcementCases.id, q) : ilike(enforcementCases.publicRef, like))
      .limit(perGroup);
    return rows.map((r) => ({ type: 'enforcement_case', id: r.id, label: r.publicRef ?? r.id, sublabel: r.status ?? undefined }));
  }, []));

  // Certificates by public id or verification token.
  push('certificate', await safe(async () => {
    const rows = await db
      .select({ id: certificates.id, publicId: certificates.certificatePublicId, type: certificates.type, token: certificates.verificationToken })
      .from(certificates)
      .where(isUuid ? eq(certificates.id, q) : or(ilike(certificates.certificatePublicId, like), eq(certificates.verificationToken, q))!)
      .limit(perGroup);
    return rows.map((r) => ({ type: 'certificate', id: r.id, label: r.publicId, sublabel: r.type }));
  }, []));

  // Incidents by public ref (HT-INC-xxxx) or uuid.
  push('incident', await safe(async () => {
    const rows = await db
      .select({ id: incidents.id, publicRef: incidents.publicRef, title: incidents.title, status: incidents.status })
      .from(incidents)
      .where(and(eq(incidents.organizationId, organizationId), isUuid ? eq(incidents.id, q) : ilike(incidents.publicRef, like)))
      .orderBy(desc(incidents.createdAt))
      .limit(perGroup);
    return rows.map((r) => ({ type: 'incident', id: r.id, label: r.publicRef, sublabel: r.title }));
  }, []));

  // Support tickets by public ref (HT-xxxxxx), subject or uuid.
  push('support_ticket', await safe(async () => {
    const rows = await db
      .select({ id: supportTickets.id, publicRef: supportTickets.publicRef, subject: supportTickets.subject, status: supportTickets.status })
      .from(supportTickets)
      .where(and(eq(supportTickets.organizationId, organizationId), isUuid ? eq(supportTickets.id, q) : or(ilike(supportTickets.publicRef, like), ilike(supportTickets.subject, like))!))
      .orderBy(desc(supportTickets.updatedAt))
      .limit(perGroup);
    return rows.map((r) => ({ type: 'support_ticket', id: r.id, label: r.publicRef, sublabel: r.subject }));
  }, []));

  // Support remediations by public ref (REM-xxxxxx) or uuid.
  push('support_remediation', await safe(async () => {
    const rows = await db
      .select({ id: supportRemediations.id, ticketId: supportRemediations.ticketId, publicRef: supportRemediations.publicRef, type: supportRemediations.type, status: supportRemediations.status })
      .from(supportRemediations)
      .where(and(eq(supportRemediations.organizationId, organizationId), isUuid ? eq(supportRemediations.id, q) : ilike(supportRemediations.publicRef, like)))
      .orderBy(desc(supportRemediations.createdAt))
      .limit(perGroup);
    // link target is the parent ticket workspace, where remediation is managed.
    return rows.map((r) => ({ type: 'support_remediation', id: r.ticketId, label: r.publicRef, sublabel: `${r.type} · ${r.status}` }));
  }, []));

  // Affiliates by name / email / public id / uuid.
  push('affiliate', await safe(async () => {
    const rows = await db
      .select({ id: affiliates.id, publicId: affiliates.publicId, displayName: affiliates.displayName, email: affiliates.email, status: affiliates.status })
      .from(affiliates)
      .where(and(eq(affiliates.organizationId, organizationId), isUuid ? eq(affiliates.id, q) : or(ilike(affiliates.displayName, like), ilike(affiliates.email, like), ilike(affiliates.publicId, like))!))
      .limit(perGroup);
    return rows.map((r) => ({ type: 'affiliate', id: r.id, label: `${r.displayName} (${r.publicId})`, sublabel: r.status }));
  }, []));

  // Affiliate by code (canonical).
  if (!isUuid) {
    push('affiliate_code', await safe(async () => {
      const rows = await db
        .select({ affiliateId: affiliateCodes.affiliateId, code: affiliateCodes.code, status: affiliateCodes.status })
        .from(affiliateCodes)
        .where(and(eq(affiliateCodes.organizationId, organizationId), eq(affiliateCodes.codeCanonical, q.toLowerCase())))
        .limit(perGroup);
      return rows.map((r) => ({ type: 'affiliate', id: r.affiliateId, label: `code ${r.code}`, sublabel: r.status }));
    }, []));
  }

  const total = groups.reduce((n, g) => n + g.results.length, 0);
  return { query: q, groups, total };
}
