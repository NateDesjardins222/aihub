/**
 * Portal payout history — a READ-ONLY, owner-scoped projection of the customer's own
 * payout requests (Experience Layer Phase 2).
 *
 * PRESENTATION ONLY: this reads authoritative `payout_requests` rows the customer
 * owns and projects the customer-safe fields. It computes NO eligibility, moves NO
 * money, and changes NO payout business rule — those remain in payout-core/payouts.
 * It exists so the portal can show real payout history (and Analytics can chart it)
 * instead of reconstructing it from certificates.
 */
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, payoutRequests } from '../db/schema.js';

export interface PortalPayoutRow {
  id: string;
  accountId: string;
  accountName: string | null;
  state: string;
  requestedGrossMicros: number;
  grossEligibleMicros: number | null;
  traderShareMicros: number | null;
  firmShareMicros: number | null;
  feesMicros: number;
  payoutOrdinal: number;
  requestedAt: number;
  decidedAt: number | null;
  paidAt: number | null;
}

/** The caller's own payout requests, newest first. Owner-scoped by user id. */
export async function listPayoutHistoryForUser(db: Database, userId: string): Promise<PortalPayoutRow[]> {
  const rows = await db
    .select({
      id: payoutRequests.id,
      accountId: payoutRequests.accountId,
      accountName: accounts.name,
      state: payoutRequests.state,
      requestedGrossMicros: payoutRequests.requestedGrossMicros,
      grossEligibleMicros: payoutRequests.grossEligibleMicros,
      traderShareMicros: payoutRequests.traderShareMicros,
      firmShareMicros: payoutRequests.firmShareMicros,
      feesMicros: payoutRequests.feesMicros,
      payoutOrdinal: payoutRequests.payoutOrdinal,
      createdAt: payoutRequests.createdAt,
      decidedAt: payoutRequests.decidedAt,
      paidAt: payoutRequests.paidAt,
    })
    .from(payoutRequests)
    .leftJoin(accounts, eq(payoutRequests.accountId, accounts.id))
    .where(eq(payoutRequests.userId, userId))
    .orderBy(desc(payoutRequests.createdAt));

  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    accountName: r.accountName ?? null,
    state: r.state,
    requestedGrossMicros: Number(r.requestedGrossMicros),
    grossEligibleMicros: r.grossEligibleMicros == null ? null : Number(r.grossEligibleMicros),
    traderShareMicros: r.traderShareMicros == null ? null : Number(r.traderShareMicros),
    firmShareMicros: r.firmShareMicros == null ? null : Number(r.firmShareMicros),
    feesMicros: Number(r.feesMicros),
    payoutOrdinal: r.payoutOrdinal,
    requestedAt: r.createdAt.getTime(),
    decidedAt: r.decidedAt ? r.decidedAt.getTime() : null,
    paidAt: r.paidAt ? r.paidAt.getTime() : null,
  }));
}
