/**
 * Financial Operations (M10-J): operational financial observability (NOT formal
 * accounting). Every figure traces to source objects. No fabricated bank balance
 * or cash-available. Also the money-movement trace and the agreement center.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  adminAdjustments, agreementAcceptances, agreementVersions, commercialOrders, payoutLedger,
  payoutRequests,
} from '../db/schema.js';
import { inspectPayout } from './inspectors.js';

export interface FinancialSummary {
  readonly purchaseRevenueMicros: number;
  readonly resetRevenueMicros: number;
  readonly refundsMicros: number;
  readonly paidTraderPayoutMicros: number;
  readonly firmShareMicros: number;
  readonly outstandingPayoutLiabilityMicros: number;
  readonly adminAdjustmentNetMicros: number;
}

export async function financialSummary(db: Database, organizationId: string): Promise<FinancialSummary> {
  const [orders] = await db
    .select({
      purchase: sql<number>`coalesce(sum(${commercialOrders.amountMicros}) filter (where ${commercialOrders.status} = 'COMPLETED' and ${commercialOrders.source} <> 'RESET'),0)::bigint`,
      reset: sql<number>`coalesce(sum(${commercialOrders.amountMicros}) filter (where ${commercialOrders.status} = 'COMPLETED' and ${commercialOrders.source} = 'RESET'),0)::bigint`,
      refunds: sql<number>`coalesce(sum(${commercialOrders.amountMicros}) filter (where ${commercialOrders.refundedAt} is not null),0)::bigint`,
    })
    .from(commercialOrders)
    .where(eq(commercialOrders.organizationId, organizationId));
  const [payouts] = await db
    .select({
      paid: sql<number>`coalesce(sum(${payoutRequests.traderShareMicros}) filter (where ${payoutRequests.state} = 'PAID'),0)::bigint`,
      firm: sql<number>`coalesce(sum(${payoutRequests.firmShareMicros}) filter (where ${payoutRequests.state} = 'PAID'),0)::bigint`,
      liability: sql<number>`coalesce(sum(${payoutRequests.traderShareMicros}) filter (where ${payoutRequests.state} in ('REQUESTED','UNDER_REVIEW','APPROVED','PROCESSING')),0)::bigint`,
    })
    .from(payoutRequests)
    .where(eq(payoutRequests.organizationId, organizationId));
  const [adj] = await db
    .select({ net: sql<number>`coalesce(sum(case when ${adminAdjustments.type} = 'DEBIT' then -${adminAdjustments.amountMicros} else ${adminAdjustments.amountMicros} end),0)::bigint` })
    .from(adminAdjustments)
    .where(eq(adminAdjustments.organizationId, organizationId));
  return {
    purchaseRevenueMicros: Number(orders?.purchase ?? 0),
    resetRevenueMicros: Number(orders?.reset ?? 0),
    refundsMicros: Number(orders?.refunds ?? 0),
    paidTraderPayoutMicros: Number(payouts?.paid ?? 0),
    firmShareMicros: Number(payouts?.firm ?? 0),
    outstandingPayoutLiabilityMicros: Number(payouts?.liability ?? 0),
    adminAdjustmentNetMicros: Number(adj?.net ?? 0),
  };
}

/** Money-movement trace for one payout: eligibility → ledger → operations. */
export async function payoutMoneyTrace(db: Database, payoutId: string) {
  const inspection = await inspectPayout(db, payoutId);
  const [req] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, payoutId));
  const ledger = await db.select({ entryType: payoutLedger.entryType, amountMicros: payoutLedger.amountMicros, createdAt: payoutLedger.createdAt }).from(payoutLedger).where(eq(payoutLedger.payoutRequestId, payoutId)).orderBy(payoutLedger.createdAt);
  return {
    payoutId,
    state: req?.state,
    grossEligibleMicros: req?.grossEligibleMicros ?? null,
    traderShareMicros: req?.traderShareMicros ?? null,
    firmShareMicros: req?.firmShareMicros ?? null,
    requestedGrossMicros: req?.requestedGrossMicros ?? null,
    eligibility: inspection.eligibility,
    ledger,
    // Certificate-after-PAID and provider settlement live in payout-operations;
    // surfaced truthfully from the ledger + state, never fabricated.
    settled: req?.state === 'PAID',
  };
}

export async function agreementCenter(db: Database, organizationId: string) {
  const versions = await db
    .select({ id: agreementVersions.id, type: agreementVersions.agreementType, version: agreementVersions.version, contentHash: agreementVersions.contentHash, isRequired: agreementVersions.isRequired, publishedAt: agreementVersions.publishedAt })
    .from(agreementVersions)
    .where(eq(agreementVersions.organizationId, organizationId))
    .orderBy(desc(agreementVersions.publishedAt));
  const ids = versions.map((v) => v.id);
  const counts = ids.length
    ? await db.select({ versionId: agreementAcceptances.agreementVersionId, n: sql<number>`count(*)::int` }).from(agreementAcceptances).where(inArray(agreementAcceptances.agreementVersionId, ids)).groupBy(agreementAcceptances.agreementVersionId)
    : [];
  const map = new Map(counts.map((c) => [c.versionId, c.n]));
  return { versions: versions.map((v) => ({ ...v, acceptanceCount: map.get(v.id) ?? 0 })) };
}

void and;
