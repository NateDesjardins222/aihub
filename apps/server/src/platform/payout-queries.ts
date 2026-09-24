/**
 * Read side of the payout engine — owner queues, the payout case, and firm
 * exposure. Everything is hard-filtered by organization; tenancy is never a
 * client-supplied argument. No mutation happens here.
 */
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  accountProfileVersions,
  accountProfiles,
  accounts,
  auditLog,
  payoutLedger,
  payoutRequests,
  users,
} from '../db/schema.js';
import { getPayoutEligibility, type PayoutState } from './payouts.js';

const NON_TERMINAL: PayoutState[] = ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING'];

export interface PayoutListRow {
  id: string;
  state: string;
  accountId: string;
  accountPublicId: string | null;
  accountName: string;
  accountStatus: string;
  adminHold: string | null;
  productName: string | null;
  accountType: string;
  traderEmail: string | null;
  requestedGrossMicros: number;
  traderShareMicros: number | null;
  firmShareMicros: number | null;
  balanceMicros: number;
  protectedBufferMicros: number | null;
  withdrawableBeforeMicros: number | null;
  payoutOrdinal: number;
  holdKind: string | null;
  createdAt: string;
}

/** A page of payout requests for the owner queue, filtered by org (+ state). */
export async function listPayouts(
  db: Database,
  organizationId: string,
  opts: { state?: string; limit?: number; before?: string } = {},
): Promise<{ rows: PayoutListRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const filters = [eq(payoutRequests.organizationId, organizationId)];
  if (opts.state) filters.push(eq(payoutRequests.state, opts.state));
  if (opts.before) filters.push(lt(payoutRequests.createdAt, new Date(opts.before)));

  const rows = await db
    .select({
      p: payoutRequests,
      accountPublicId: accounts.publicId,
      accountName: accounts.name,
      accountStatus: accounts.status,
      adminHold: accounts.adminHold,
      accountType: accounts.accountType,
      balanceMicros: accounts.balanceMicros,
      traderEmail: users.email,
      productName: accountProfiles.name,
    })
    .from(payoutRequests)
    .innerJoin(accounts, eq(payoutRequests.accountId, accounts.id))
    .leftJoin(users, eq(payoutRequests.userId, users.id))
    .leftJoin(accountProfileVersions, eq(payoutRequests.productVersionId, accountProfileVersions.id))
    .leftJoin(accountProfiles, eq(accountProfileVersions.profileId, accountProfiles.id))
    .where(and(...filters))
    .orderBy(desc(payoutRequests.createdAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1]!.p.createdAt.toISOString() : null;
  return {
    rows: page.map((r) => ({
      id: r.p.id,
      state: r.p.state,
      accountId: r.p.accountId,
      accountPublicId: r.accountPublicId,
      accountName: r.accountName,
      accountStatus: r.accountStatus,
      adminHold: r.adminHold,
      productName: r.productName,
      accountType: r.accountType,
      traderEmail: r.traderEmail,
      requestedGrossMicros: r.p.requestedGrossMicros,
      traderShareMicros: r.p.traderShareMicros,
      firmShareMicros: r.p.firmShareMicros,
      balanceMicros: r.balanceMicros,
      protectedBufferMicros: r.p.protectedBufferMicros,
      withdrawableBeforeMicros: r.p.withdrawableBeforeMicros,
      payoutOrdinal: r.p.payoutOrdinal,
      holdKind: r.p.holdKind,
      createdAt: r.p.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

/** The full payout case: request, live eligibility recompute, ledger, audit. */
export async function getPayoutCase(db: Database, organizationId: string, payoutId: string) {
  const [row] = await db
    .select()
    .from(payoutRequests)
    .where(and(eq(payoutRequests.id, payoutId), eq(payoutRequests.organizationId, organizationId)));
  if (!row) return null;

  const ctx = await getPayoutEligibility(db, row.accountId);
  const ledger = await db
    .select()
    .from(payoutLedger)
    .where(eq(payoutLedger.payoutRequestId, payoutId))
    .orderBy(payoutLedger.createdAt);
  const audit = await db
    .select({ action: auditLog.action, reason: auditLog.reason, newState: auditLog.newState, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.subjectType, 'PAYOUT'), eq(auditLog.subjectId, payoutId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(50);

  return {
    request: {
      id: row.id,
      state: row.state,
      requestedGrossMicros: row.requestedGrossMicros,
      grossEligibleMicros: row.grossEligibleMicros,
      traderShareMicros: row.traderShareMicros,
      firmShareMicros: row.firmShareMicros,
      balanceAdjustmentMicros: row.balanceAdjustmentMicros,
      protectedBufferMicros: row.protectedBufferMicros,
      withdrawableBeforeMicros: row.withdrawableBeforeMicros,
      payoutOrdinal: row.payoutOrdinal,
      holdKind: row.holdKind,
      reason: row.reason,
      eligibilitySnapshot: row.eligibilitySnapshot,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      paidAt: row.paidAt?.toISOString() ?? null,
    },
    account: {
      id: ctx.account.id,
      publicId: ctx.account.publicId,
      name: ctx.account.name,
      accountType: ctx.account.accountType,
      status: ctx.account.status,
      adminHold: ctx.account.adminHold,
      balanceMicros: ctx.account.balanceMicros,
      startingBalanceMicros: ctx.account.startingBalanceMicros,
    },
    policy: ctx.policy,
    liveEligibility: ctx.eligibility,
    ledger: ledger.map((l) => ({
      entryType: l.entryType,
      amountMicros: l.amountMicros,
      balanceBeforeMicros: l.balanceBeforeMicros,
      balanceAfterMicros: l.balanceAfterMicros,
      traderShareMicros: l.traderShareMicros,
      firmShareMicros: l.firmShareMicros,
      createdAt: l.createdAt.toISOString(),
    })),
    audit: audit.map((a) => ({ action: a.action, reason: a.reason, newState: a.newState, createdAt: a.createdAt.toISOString() })),
  };
}

export interface FirmExposure {
  /** Money already paid out (ledger settlements). */
  realizedPaid: { today: number; last7d: number; last30d: number; allTime: number };
  /** Gross of all non-terminal requests — the current requested liability. */
  requestedLiabilityMicros: number;
  approvedUnpaidMicros: number;
  /** If every eligible funded account withdrew its maximum — a ceiling. */
  eligibleWithdrawableMicros: number;
  byModel: Record<string, { requestedLiabilityMicros: number; paidAllTimeMicros: number }>;
}

/** Firm-wide payout exposure, keeping the three distinct numbers distinct. */
export async function firmExposure(db: Database, organizationId: string): Promise<FirmExposure> {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const settlements = await db
    .select({ amount: payoutLedger.traderShareMicros, createdAt: payoutLedger.createdAt })
    .from(payoutLedger)
    .where(and(eq(payoutLedger.organizationId, organizationId), eq(payoutLedger.entryType, 'SETTLEMENT')));
  const realizedPaid = { today: 0, last7d: 0, last30d: 0, allTime: 0 };
  for (const s of settlements) {
    const amt = s.amount ?? 0;
    const age = now - s.createdAt.getTime();
    realizedPaid.allTime += amt;
    if (age <= day) realizedPaid.today += amt;
    if (age <= 7 * day) realizedPaid.last7d += amt;
    if (age <= 30 * day) realizedPaid.last30d += amt;
  }

  const pending = await db
    .select({ state: payoutRequests.state, requested: payoutRequests.requestedGrossMicros, gross: payoutRequests.grossEligibleMicros })
    .from(payoutRequests)
    .where(and(eq(payoutRequests.organizationId, organizationId), inArray(payoutRequests.state, NON_TERMINAL)));
  let requestedLiabilityMicros = 0;
  let approvedUnpaidMicros = 0;
  for (const p of pending) {
    requestedLiabilityMicros += p.requested;
    if (p.state === 'APPROVED' || p.state === 'PROCESSING') approvedUnpaidMicros += p.gross ?? p.requested;
  }

  // Eligible withdrawable ceiling across funded accounts (bounded scan).
  const funded = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.accountType, 'FUNDED_SIM'), eq(accounts.status, 'ACTIVE')))
    .limit(2000);
  let eligibleWithdrawableMicros = 0;
  const byModel: Record<string, { requestedLiabilityMicros: number; paidAllTimeMicros: number }> = {};
  for (const f of funded) {
    try {
      const ctx = await getPayoutEligibility(db, f.id);
      if (ctx.eligibility.state === 'ELIGIBLE') {
        eligibleWithdrawableMicros += Math.min(ctx.eligibility.grossWithdrawableMicros, ctx.eligibility.maxRequestMicros);
      }
      const m = ctx.policy.model;
      byModel[m] ??= { requestedLiabilityMicros: 0, paidAllTimeMicros: 0 };
    } catch {
      // An account without a payout policy is simply not counted.
    }
  }

  return { realizedPaid, requestedLiabilityMicros, approvedUnpaidMicros, eligibleWithdrawableMicros, byModel };
}
