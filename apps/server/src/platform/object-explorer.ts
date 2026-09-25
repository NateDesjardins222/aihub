/**
 * Universal object explorer (M10-C).
 *
 * Given a typed object reference, return a normalized inspector payload:
 * identity, current state, related object links, and recent history — built from
 * the existing authoritative surfaces (customer detail, account inspector, payout
 * inspector, enforcement case detail, staff detail), never a raw JSON dump.
 */
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, affiliates, certificates, customerIdentities, supportTickets, users } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { inspectAccount, inspectPayout } from './inspectors.js';
import { accountAudit, userAudit } from './audit.js';
import { staffDetail } from './staff.js';
import { listLinks } from './support-links.js';

export interface RelatedLink { readonly type: string; readonly id: string; readonly label: string }

export interface ObjectView {
  readonly type: string;
  readonly id: string;
  readonly title: string;
  readonly state: Record<string, unknown>;
  readonly related: RelatedLink[];
  readonly history: Array<{ at: string; action: string; actor: string | null; reason: string | null }>;
}

async function auditToHistory(rows: Awaited<ReturnType<typeof accountAudit>>) {
  return rows.map((r) => ({ at: r.createdAt.toISOString(), action: r.action, actor: r.actorLabel ?? r.actorType, reason: r.reason }));
}

export async function explainObject(db: Database, organizationId: string, type: string, id: string): Promise<ObjectView> {
  switch (type) {
    case 'account': {
      const a = await inspectAccount(db, id);
      const [owner] = await db.select({ userId: accounts.userId }).from(accounts).where(eq(accounts.id, id));
      const related: RelatedLink[] = [];
      if (owner?.userId) related.push({ type: 'customer', id: owner.userId, label: 'Owner' });
      return {
        type, id, title: a.publicId ?? id,
        state: { status: a.status, ruleStatus: a.ruleStatus, adminHold: a.adminHold, tradingHold: a.tradingHold, drawdownBand: a.drawdown.band, balanceMicros: a.balanceMicros },
        related,
        history: await auditToHistory(await accountAudit(db, id, 25)),
      };
    }
    case 'payout': {
      const p = await inspectPayout(db, id);
      return {
        type, id, title: `Payout ${id.slice(0, 8)}`,
        state: { state: p.stateMachine.current, terminal: p.stateMachine.terminal, validNext: p.stateMachine.validNext, eligibility: p.eligibility.state, reasonCodes: p.eligibility.reasonCodes },
        related: [{ type: 'account', id: p.accountId, label: 'Account' }],
        history: [],
      };
    }
    case 'customer': {
      const [u] = await db.select({ id: users.id, email: users.email, displayName: users.displayName, role: users.role, status: users.status }).from(users).where(eq(users.id, id));
      if (!u) throw ApiError.notFound('CUSTOMER_NOT_FOUND', 'Customer not found.');
      const [ident] = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(eq(customerIdentities.userId, id));
      const accts = await db.select({ id: accounts.id, publicId: accounts.publicId, status: accounts.status }).from(accounts).where(eq(accounts.userId, id)).orderBy(desc(accounts.createdAt)).limit(20);
      return {
        type, id, title: u.displayName,
        state: { email: u.email, role: u.role, status: u.status, identityId: ident?.id ?? null, accountCount: accts.length },
        related: accts.map((a) => ({ type: 'account', id: a.id, label: a.publicId ?? a.id })),
        history: await auditToHistory(await userAudit(db, id, 25)),
      };
    }
    case 'staff': {
      const d = await staffDetail(db, id);
      return {
        type, id, title: `${d.displayName} (${d.role})`,
        state: { email: d.email, role: d.role, status: d.status, mfaEnrolled: d.mfaEnrolled, activeSessions: d.activeSessions, effectivePermissions: d.effectivePermissions },
        related: [],
        history: await auditToHistory(await userAudit(db, id, 25)),
      };
    }
    case 'certificate': {
      const [c] = await db.select().from(certificates).where(eq(certificates.id, id));
      if (!c) throw ApiError.notFound('CERTIFICATE_NOT_FOUND', 'Certificate not found.');
      return {
        type, id, title: c.certificatePublicId,
        // Never expose the raw verification token beyond a masked hint.
        state: { certificateType: c.type, publicId: c.certificatePublicId, tokenMasked: `${c.verificationToken.slice(0, 4)}…`, status: (c as Record<string, unknown>)['status'] ?? 'ISSUED' },
        related: c.accountId ? [{ type: 'account', id: c.accountId, label: 'Account' }] : [],
        history: [],
      };
    }
    case 'affiliate': {
      const [a] = await db.select().from(affiliates).where(eq(affiliates.id, id));
      if (!a) throw ApiError.notFound('AFFILIATE_NOT_FOUND', 'Affiliate not found.');
      return {
        type, id, title: `${a.displayName} (${a.publicId})`,
        state: { status: a.status, tier: a.tier, effectiveRateBps: a.effectiveRateBps, email: a.email, activatedAt: a.activatedAt },
        related: a.userId ? [{ type: 'customer', id: a.userId, label: 'Linked customer' }] : [],
        history: await auditToHistory(await userAudit(db, a.userId ?? id, 25)).catch(() => []),
      };
    }
    case 'support_ticket': {
      const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, id));
      if (!t || t.organizationId !== organizationId) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
      const links = await listLinks(db, id).catch(() => []);
      const related: RelatedLink[] = [{ type: 'customer', id: t.customerUserId, label: 'Customer' }];
      for (const l of links) {
        const lt = String((l as Record<string, unknown>)['objectType'] ?? '').toLowerCase();
        const lid = String((l as Record<string, unknown>)['objectId'] ?? '');
        if (lt && lid) related.push({ type: lt, id: lid, label: `Linked ${lt}` });
      }
      return {
        type, id, title: t.publicRef,
        state: { subject: t.subject, status: t.status, priority: t.priority, category: t.categoryKey, team: t.team, assigneeUserId: t.assigneeUserId, resolutionCode: t.resolutionCode, csatRating: t.csatRating },
        related,
        history: await auditToHistory(await userAudit(db, t.customerUserId, 25)).catch(() => []),
      };
    }
    default:
      throw ApiError.badRequest('UNSUPPORTED_OBJECT', `Object type ${type} is not supported by the explorer.`);
  }
}
