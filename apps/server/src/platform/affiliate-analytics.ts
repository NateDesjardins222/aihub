/**
 * Affiliate analytics + read models (M11-H/I): the affiliate dashboard, the
 * owner overview, Affiliate 360, and the (privacy-masked) conversion table.
 * Customer identity is never exposed to affiliates beyond a masked label.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  affiliateCommissions, affiliateConversions, affiliatePayouts, affiliateRateHistory,
  affiliateRiskSignals, affiliateTierHistory, affiliateApplications, affiliateCodes, affiliates, users,
} from '../db/schema.js';
import { affiliateBalance } from './affiliate-commissions.js';
import { clickStats } from './affiliate-attribution.js';
import { tierProgress } from './affiliate-tiers.js';
import { maskName, listAffiliateCodes } from './affiliates.js';

/** Affiliate-facing conversion rows (customer identity masked, §35/§84). */
export async function listConversionsForAffiliate(db: Database, affiliateId: string, opts: { limit?: number } = {}) {
  const rows = await db
    .select({
      id: affiliateConversions.id, createdAt: affiliateConversions.createdAt, customerName: users.displayName,
      qualifiedRevenueMicros: affiliateConversions.qualifiedRevenueMicros, source: affiliateConversions.source,
      rateBps: affiliateCommissions.rateBps, commissionMicros: affiliateCommissions.commissionMicros, status: affiliateCommissions.status,
    })
    .from(affiliateConversions)
    .leftJoin(affiliateCommissions, eq(affiliateCommissions.conversionId, affiliateConversions.id))
    .leftJoin(users, eq(users.id, affiliateConversions.customerUserId))
    .where(eq(affiliateConversions.affiliateId, affiliateId))
    .orderBy(desc(affiliateConversions.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500));
  return rows.map((r) => ({ ...r, customer: maskName(r.customerName ?? 'Customer'), customerName: undefined }));
}

/** The affiliate's own dashboard aggregate. */
export async function affiliateDashboard(db: Database, affiliateId: string) {
  const [aff] = await db.select().from(affiliates).where(eq(affiliates.id, affiliateId));
  if (!aff) return null;
  const since30 = new Date(Date.now() - 30 * 86_400_000);
  const [progress, balance, clicks, codes, convAgg] = await Promise.all([
    tierProgress(db, affiliateId),
    affiliateBalance(db, affiliateId),
    clickStats(db, affiliateId, since30),
    listAffiliateCodes(db, affiliateId),
    db.select({
      conversions: sql<number>`count(*)::int`,
      referredRevenue: sql<number>`coalesce(sum(${affiliateConversions.qualifiedRevenueMicros}),0)::bigint`,
    }).from(affiliateConversions).where(and(eq(affiliateConversions.affiliateId, affiliateId), gte(affiliateConversions.createdAt, since30))),
  ]);
  const conv = convAgg[0] ?? { conversions: 0, referredRevenue: 0 };
  return {
    affiliate: { id: aff.id, publicId: aff.publicId, displayName: aff.displayName, status: aff.status, tier: aff.tier, effectiveRateBps: aff.effectiveRateBps },
    tierProgress: progress,
    balance,
    last30: { clicks: clicks.clicks, uniqueSessions: clicks.uniqueSessions, conversions: conv.conversions, referredRevenueMicros: Number(conv.referredRevenue), conversionRate: clicks.clicks > 0 ? conv.conversions / clicks.clicks : 0 },
    codes: codes.map((c) => ({ code: c.code, kind: c.kind, status: c.status, discountBps: c.discountBps, campaignLabel: c.campaignLabel })),
  };
}

/** Owner program overview (all figures from source data). */
export async function ownerAffiliateOverview(db: Database, organizationId: string) {
  const [statusRows, apps, money, since] = await Promise.all([
    db.select({ status: affiliates.status, n: sql<number>`count(*)::int` }).from(affiliates).where(eq(affiliates.organizationId, organizationId)).groupBy(affiliates.status),
    db.select({ status: affiliateApplications.status, n: sql<number>`count(*)::int` }).from(affiliateApplications).where(eq(affiliateApplications.organizationId, organizationId)).groupBy(affiliateApplications.status),
    db.select({
      accrued: sql<number>`coalesce(sum(case when ${affiliateCommissions.status} in ('TRACKED','PENDING','HELD','PAYABLE','PAID') then ${affiliateCommissions.commissionMicros} else 0 end),0)::bigint`,
      payable: sql<number>`coalesce(sum(case when ${affiliateCommissions.status} = 'PAYABLE' then ${affiliateCommissions.commissionMicros} else 0 end),0)::bigint`,
      paid: sql<number>`coalesce(sum(case when ${affiliateCommissions.status} = 'PAID' then ${affiliateCommissions.commissionMicros} else 0 end),0)::bigint`,
      reversed: sql<number>`coalesce(sum(case when ${affiliateCommissions.status} in ('REVERSED','CANCELED') then ${affiliateCommissions.commissionMicros} else 0 end),0)::bigint`,
    }).from(affiliateCommissions).where(eq(affiliateCommissions.organizationId, organizationId)),
    db.select({ mtd: sql<number>`coalesce(sum(${affiliateConversions.qualifiedRevenueMicros}),0)::bigint` }).from(affiliateConversions).where(and(eq(affiliateConversions.organizationId, organizationId), gte(affiliateConversions.createdAt, new Date(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)))),
  ]);
  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, r.n]));
  const [liability] = await db.select({ owed: sql<number>`coalesce(sum(${affiliatePayouts.amountMicros}),0)::bigint` }).from(affiliatePayouts).where(and(eq(affiliatePayouts.organizationId, organizationId), inArray(affiliatePayouts.status, ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PAYABLE', 'SUBMITTED', 'PROCESSING'])));
  const m = money[0]!;
  return {
    activeAffiliates: byStatus['ACTIVE'] ?? 0,
    pendingApplications: (byStatus['SUBMITTED'] ?? 0) + (byStatus['UNDER_REVIEW'] ?? 0),
    approvedAwaitingAgreement: byStatus['APPROVED_PENDING_AGREEMENT'] ?? 0,
    suspended: byStatus['SUSPENDED'] ?? 0,
    byStatus,
    applicationsByStatus: Object.fromEntries(apps.map((r) => [r.status, r.n])),
    referredRevenueMtdMicros: Number(since[0]?.mtd ?? 0),
    commissionAccruedMicros: Number(m.accrued), commissionPayableMicros: Number(m.payable),
    commissionPaidMicros: Number(m.paid), commissionReversedMicros: Number(m.reversed),
    affiliatePayoutLiabilityMicros: Number(liability?.owed ?? 0),
  };
}

/** Full internal Affiliate 360. */
export async function affiliate360(db: Database, affiliateId: string) {
  const [aff] = await db.select().from(affiliates).where(eq(affiliates.id, affiliateId));
  if (!aff) return null;
  const [application, balance, codes, tiers, rates, payouts, risks, recentConv, recentComm] = await Promise.all([
    db.select().from(affiliateApplications).where(eq(affiliateApplications.affiliateId, affiliateId)).orderBy(desc(affiliateApplications.submittedAt)).limit(1),
    affiliateBalance(db, affiliateId),
    listAffiliateCodes(db, affiliateId),
    db.select().from(affiliateTierHistory).where(eq(affiliateTierHistory.affiliateId, affiliateId)).orderBy(desc(affiliateTierHistory.createdAt)).limit(50),
    db.select().from(affiliateRateHistory).where(eq(affiliateRateHistory.affiliateId, affiliateId)).orderBy(desc(affiliateRateHistory.createdAt)).limit(50),
    db.select().from(affiliatePayouts).where(eq(affiliatePayouts.affiliateId, affiliateId)).orderBy(desc(affiliatePayouts.createdAt)).limit(50),
    db.select().from(affiliateRiskSignals).where(eq(affiliateRiskSignals.affiliateId, affiliateId)).orderBy(desc(affiliateRiskSignals.createdAt)).limit(50),
    db.select().from(affiliateConversions).where(eq(affiliateConversions.affiliateId, affiliateId)).orderBy(desc(affiliateConversions.createdAt)).limit(50),
    db.select().from(affiliateCommissions).where(eq(affiliateCommissions.affiliateId, affiliateId)).orderBy(desc(affiliateCommissions.createdAt)).limit(50),
  ]);
  return {
    affiliate: aff,
    application: application[0] ?? null,
    balance,
    codes, tierHistory: tiers, rateHistory: rates, payouts, riskSignals: risks,
    recentConversions: recentConv, recentCommissions: recentComm,
  };
}
