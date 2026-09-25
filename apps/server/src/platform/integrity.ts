/**
 * Data Integrity Center (M10-G): "does our business data still make sense?"
 *
 * Deterministic invariant checks over real data. It DETECTS; it never silently
 * repairs a serious integrity failure. Results persist to
 * `integrity_check_results`. Separate from System Doctor (which asks whether the
 * infrastructure is operating).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, affiliateCommissions, affiliateConversions, affiliates, integrityCheckResults, payoutLedger, payoutRequests, supportRemediations, supportTickets } from '../db/schema.js';
import { verifyAuditChain } from './audit.js';

export type IntegrityStatus = 'PASS' | 'FAIL' | 'WARN';

export interface IntegrityCheck {
  readonly key: string;
  readonly status: IntegrityStatus;
  readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
  readonly affectedCount: number;
  readonly expected: string;
  readonly actual: string;
  readonly sampleRefs: string[];
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly runId: string;
  readonly checks: IntegrityCheck[];
  readonly at: string;
}

const ACTIVE_STATUSES = ['PENDING', 'ACTIVE', 'GOAL_REACHED', 'LOCKED'];
const MAX_ACTIVE = 5;
const MAX_CYCLES = 5;

/** ≤5 active accounts per identity (owner rule §78). */
async function checkActiveAccountsPerIdentity(db: Database, organizationId: string): Promise<IntegrityCheck> {
  const rows = await db
    .select({ userId: accounts.userId, n: sql<number>`count(*)::int` })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.status, ACTIVE_STATUSES)))
    .groupBy(accounts.userId)
    .having(sql`count(*) > ${MAX_ACTIVE}`);
  return {
    key: 'INV_ACTIVE_ACCOUNTS_PER_IDENTITY',
    status: rows.length ? 'FAIL' : 'PASS',
    severity: rows.length ? 'CRITICAL' : 'INFO',
    affectedCount: rows.length,
    expected: `≤ ${MAX_ACTIVE} active accounts per identity`,
    actual: rows.length ? `${rows.length} identity(ies) exceed the cap` : 'within cap',
    sampleRefs: rows.slice(0, 10).map((r) => `${r.userId}:${r.n}`),
  };
}

/** ≤5 PAID payout cycles per account (owner rule §78). */
async function checkPayoutCycles(db: Database, organizationId: string): Promise<IntegrityCheck> {
  const rows = await db
    .select({ accountId: payoutRequests.accountId, n: sql<number>`count(*)::int` })
    .from(payoutRequests)
    .where(and(eq(payoutRequests.organizationId, organizationId), eq(payoutRequests.state, 'PAID')))
    .groupBy(payoutRequests.accountId)
    .having(sql`count(*) > ${MAX_CYCLES}`);
  return {
    key: 'INV_PAYOUT_CYCLES',
    status: rows.length ? 'FAIL' : 'PASS',
    severity: rows.length ? 'CRITICAL' : 'INFO',
    affectedCount: rows.length,
    expected: `≤ ${MAX_CYCLES} PAID payouts per account`,
    actual: rows.length ? `${rows.length} account(s) exceed the cap` : 'within cap',
    sampleRefs: rows.slice(0, 10).map((r) => `${r.accountId}:${r.n}`),
  };
}

/** Every PAID payout has an authoritative ledger DEBIT. */
async function checkPaidPayoutHasDebit(db: Database, organizationId: string): Promise<IntegrityCheck> {
  const rows = await db.execute(sql`
    select pr.id as id from payout_requests pr
    where pr.organization_id = ${organizationId} and pr.state = 'PAID'
      and not exists (select 1 from payout_ledger pl where pl.payout_request_id = pr.id and pl.entry_type = 'DEBIT')
    limit 50
  `);
  const arr = rows as unknown as Array<{ id: string }>;
  return {
    key: 'INV_PAID_PAYOUT_HAS_DEBIT',
    status: arr.length ? 'FAIL' : 'PASS',
    severity: arr.length ? 'CRITICAL' : 'INFO',
    affectedCount: arr.length,
    expected: 'every PAID payout has a ledger DEBIT',
    actual: arr.length ? `${arr.length} PAID payout(s) missing a DEBIT` : 'all PAID payouts have a debit',
    sampleRefs: arr.slice(0, 10).map((r) => r.id),
  };
}

/** No payout has more than one DEBIT (double-debit). Structurally guarded, verified here. */
async function checkNoDoubleDebit(db: Database): Promise<IntegrityCheck> {
  const rows = await db
    .select({ payoutRequestId: payoutLedger.payoutRequestId, n: sql<number>`count(*)::int` })
    .from(payoutLedger)
    .where(eq(payoutLedger.entryType, 'DEBIT'))
    .groupBy(payoutLedger.payoutRequestId)
    .having(sql`count(*) > 1`);
  return {
    key: 'INV_NO_DOUBLE_DEBIT',
    status: rows.length ? 'FAIL' : 'PASS',
    severity: rows.length ? 'CRITICAL' : 'INFO',
    affectedCount: rows.length,
    expected: 'at most one DEBIT per payout',
    actual: rows.length ? `${rows.length} payout(s) with multiple debits` : 'no double debits',
    sampleRefs: rows.slice(0, 10).map((r) => String(r.payoutRequestId)),
  };
}

/** The audit chain is intact (hash-chained, tamper-evident). */
async function checkAuditChain(db: Database, organizationId: string): Promise<IntegrityCheck> {
  const v = await verifyAuditChain(db, organizationId, { limit: 5000 });
  return {
    key: 'INV_AUDIT_CHAIN_INTACT',
    status: v.ok ? 'PASS' : 'FAIL',
    severity: v.ok ? 'INFO' : 'CRITICAL',
    affectedCount: v.ok ? 0 : 1,
    expected: 'hash chain verifies end to end',
    actual: v.ok ? `verified ${v.checked} entries` : `broken at ${v.brokenAt}`,
    sampleRefs: v.brokenAt ? [v.brokenAt] : [],
  };
}

/** Every affiliate commission is backed by a conversion (no orphan commissions). */
async function checkAffiliateCommissionHasConversion(db: Database, organizationId: string): Promise<IntegrityCheck> {
  const rows = await db.execute(sql`
    select c.id from affiliate_commissions c
    where c.organization_id = ${organizationId}
      and not exists (select 1 from affiliate_conversions v where v.id = c.conversion_id)
    limit 50
  `);
  const arr = rows as unknown as Array<{ id: string }>;
  return {
    key: 'INV_AFFILIATE_COMMISSION_HAS_CONVERSION', status: arr.length ? 'FAIL' : 'PASS', severity: arr.length ? 'CRITICAL' : 'INFO',
    affectedCount: arr.length, expected: 'every affiliate commission has a conversion', actual: arr.length ? `${arr.length} orphan commission(s)` : 'all commissions have a conversion', sampleRefs: arr.slice(0, 10).map((r) => r.id),
  };
}

/** Every ACTIVE affiliate has accepted the required agreement (§69). */
async function checkActiveAffiliateHasAgreement(db: Database, organizationId: string): Promise<IntegrityCheck> {
  const rows = await db
    .select({ id: affiliates.id })
    .from(affiliates)
    .where(and(eq(affiliates.organizationId, organizationId), eq(affiliates.status, 'ACTIVE'), sql`${affiliates.agreementAcceptedVersionId} is null`))
    .limit(50);
  return {
    key: 'INV_ACTIVE_AFFILIATE_HAS_AGREEMENT', status: rows.length ? 'FAIL' : 'PASS', severity: rows.length ? 'CRITICAL' : 'INFO',
    affectedCount: rows.length, expected: 'every ACTIVE affiliate accepted the agreement', actual: rows.length ? `${rows.length} active affiliate(s) without acceptance` : 'all active affiliates accepted', sampleRefs: rows.slice(0, 10).map((r) => r.id),
  };
}

/** At most one commission per commercial order (no double-commission). */
async function checkOneCommissionPerOrder(db: Database, organizationId: string): Promise<IntegrityCheck> {
  const rows = await db
    .select({ orderId: affiliateCommissions.commercialOrderId, n: sql<number>`count(*)::int` })
    .from(affiliateCommissions)
    .where(eq(affiliateCommissions.organizationId, organizationId))
    .groupBy(affiliateCommissions.commercialOrderId)
    .having(sql`count(*) > 1`);
  return {
    key: 'INV_ONE_COMMISSION_PER_ORDER', status: rows.length ? 'FAIL' : 'PASS', severity: rows.length ? 'CRITICAL' : 'INFO',
    affectedCount: rows.length, expected: 'at most one commission per order', actual: rows.length ? `${rows.length} order(s) double-commissioned` : 'no double commissions', sampleRefs: rows.slice(0, 10).map((r) => String(r.orderId)),
  };
}

/**
 * Every executed remediation went through four-eyes: it has an approver, and the
 * approver is not the requester. This is the money-safety invariant of support —
 * support requests, someone else approves, and only then does anything execute.
 */
async function checkRemediationFourEyes(db: Database, organizationId: string): Promise<IntegrityCheck> {
  const rows = await db
    .select({ id: supportRemediations.id })
    .from(supportRemediations)
    .where(and(
      eq(supportRemediations.organizationId, organizationId),
      inArray(supportRemediations.status, ['EXECUTED', 'EXECUTING']),
      sql`(${supportRemediations.approvedByUserId} is null or ${supportRemediations.approvedByUserId} = ${supportRemediations.requestedByUserId})`,
    ))
    .limit(50);
  return {
    key: 'INV_REMEDIATION_FOUR_EYES', status: rows.length ? 'FAIL' : 'PASS', severity: rows.length ? 'CRITICAL' : 'INFO',
    affectedCount: rows.length, expected: 'every executed remediation was approved by a different actor', actual: rows.length ? `${rows.length} remediation(s) breach four-eyes` : 'four-eyes upheld', sampleRefs: rows.slice(0, 10).map((r) => r.id),
  };
}

/** Every resolved/closed ticket carries a customer-facing resolution summary. */
async function checkResolvedTicketHasSummary(db: Database, organizationId: string): Promise<IntegrityCheck> {
  const rows = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(and(
      eq(supportTickets.organizationId, organizationId),
      inArray(supportTickets.status, ['RESOLVED', 'CLOSED']),
      sql`(${supportTickets.resolutionSummaryCustomer} is null or length(trim(${supportTickets.resolutionSummaryCustomer})) = 0)`,
    ))
    .limit(50);
  return {
    key: 'INV_RESOLVED_TICKET_HAS_SUMMARY', status: rows.length ? 'WARN' : 'PASS', severity: rows.length ? 'WARNING' : 'INFO',
    affectedCount: rows.length, expected: 'every resolved ticket has a customer summary', actual: rows.length ? `${rows.length} resolved ticket(s) without a summary` : 'all resolved tickets summarised', sampleRefs: rows.slice(0, 10).map((r) => r.id),
  };
}

export async function runIntegrityChecks(db: Database, organizationId: string, persist = true): Promise<IntegrityReport> {
  const runId = randomUUID();
  const checks: IntegrityCheck[] = [
    await checkActiveAccountsPerIdentity(db, organizationId),
    await checkPayoutCycles(db, organizationId),
    await checkPaidPayoutHasDebit(db, organizationId),
    await checkNoDoubleDebit(db),
    await checkAuditChain(db, organizationId),
    await checkAffiliateCommissionHasConversion(db, organizationId),
    await checkActiveAffiliateHasAgreement(db, organizationId),
    await checkOneCommissionPerOrder(db, organizationId),
    await checkRemediationFourEyes(db, organizationId),
    await checkResolvedTicketHasSummary(db, organizationId),
  ];
  void affiliateConversions;
  if (persist) {
    for (const c of checks) {
      await db.insert(integrityCheckResults).values({
        organizationId, checkKey: c.key, status: c.status, severity: c.severity,
        affectedCount: c.affectedCount, expected: c.expected, actual: c.actual, sampleRefs: c.sampleRefs as never, runId,
      });
    }
  }
  return { ok: checks.every((c) => c.status !== 'FAIL'), runId, checks, at: new Date().toISOString() };
}
