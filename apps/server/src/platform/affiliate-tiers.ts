/**
 * Affiliate tier qualification (M11-E).
 *
 * Tier is qualified by QUALIFIED REFERRED REVENUE in a monthly period — never by
 * clicks, signups, pending/failed/refunded purchases. A month's qualified revenue
 * is the sum of qualified revenue on that month's non-reversed conversions.
 * Recalculation is deterministic and never rewrites earlier commission events;
 * it only changes the affiliate's forward-looking tier/rate and records a
 * transition. A custom rate override (STRATEGIC) suppresses automatic tiering.
 *
 * V1 uses UTC calendar-month boundaries as the authoritative business period; the
 * configured business timezone is stored for future precision (documented).
 */
import { and, eq, gte, lt, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { affiliateCommissions, affiliateConversions, affiliateTierHistory, affiliates } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { getAffiliateConfig, tierForRevenue, tierRateBps, type AffiliateTier } from './affiliate-config.js';
import { computeEffectiveRateBps } from './affiliates.js';
import type { Actor } from './actor.js';

/** [start, end) UTC instants for a 'YYYY-MM' period. */
export function periodBounds(period: string): { start: Date; end: Date } {
  const [y, m] = period.split('-').map((n) => Number(n));
  const start = new Date(Date.UTC(y!, m! - 1, 1));
  const end = new Date(Date.UTC(m! === 12 ? y! + 1 : y!, m! === 12 ? 0 : m!, 1));
  return { start, end };
}

export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Sum of qualified revenue on non-reversed/canceled conversions in the period. */
export async function monthlyQualifiedRevenue(db: Database, affiliateId: string, period: string): Promise<number> {
  const { start, end } = periodBounds(period);
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${affiliateConversions.qualifiedRevenueMicros}),0)::bigint` })
    .from(affiliateConversions)
    .innerJoin(affiliateCommissions, eq(affiliateCommissions.conversionId, affiliateConversions.id))
    .where(and(
      eq(affiliateConversions.affiliateId, affiliateId),
      gte(affiliateConversions.createdAt, start),
      lt(affiliateConversions.createdAt, end),
      ne(affiliateCommissions.status, 'REVERSED'),
      ne(affiliateCommissions.status, 'CANCELED'),
    ));
  return Number(row?.total ?? 0);
}

export interface TierProgress {
  readonly tier: AffiliateTier;
  readonly effectiveRateBps: number;
  readonly monthlyQualifiedMicros: number;
  readonly nextTier: AffiliateTier | null;
  readonly nextThresholdMicros: number | null;
  readonly remainingMicros: number | null;
}

export async function tierProgress(db: Database, affiliateId: string, period = currentPeriod()): Promise<TierProgress> {
  const [aff] = await db.select().from(affiliates).where(eq(affiliates.id, affiliateId));
  const cfg = await getAffiliateConfig(db, aff!.organizationId);
  const monthly = await monthlyQualifiedRevenue(db, affiliateId, period);
  const order: Array<Exclude<AffiliateTier, 'STRATEGIC'>> = ['AFFILIATE', 'PARTNER', 'GOLD', 'PLATINUM'];
  const currentIdx = order.indexOf((aff!.tier === 'STRATEGIC' ? tierForRevenue(cfg.settings, monthly) : aff!.tier) as Exclude<AffiliateTier, 'STRATEGIC'>);
  const nextTier = currentIdx >= 0 && currentIdx < order.length - 1 ? order[currentIdx + 1]! : null;
  const nextThreshold = nextTier ? cfg.settings.tierThresholdsMicros[nextTier] : null;
  return {
    tier: aff!.tier as AffiliateTier,
    effectiveRateBps: aff!.effectiveRateBps,
    monthlyQualifiedMicros: monthly,
    nextTier,
    nextThresholdMicros: nextThreshold,
    remainingMicros: nextThreshold != null ? Math.max(0, nextThreshold - monthly) : null,
  };
}

/** Recalculate and apply an affiliate's tier for a period. A custom-rate
 * (STRATEGIC) affiliate is never auto-tiered. Idempotent when the tier is unchanged. */
export async function recalculateTier(db: Database, affiliateId: string, period = currentPeriod(), actor?: Actor): Promise<{ changed: boolean; tier: AffiliateTier }> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    const [aff] = await tx.select().from(affiliates).where(eq(affiliates.id, affiliateId));
    if (!aff) return { changed: false, tier: 'AFFILIATE' };
    // A live custom override owns the rate; never auto-tier it.
    const eff = computeEffectiveRateBps(aff);
    if (eff.source === 'CUSTOM') return { changed: false, tier: aff.tier as AffiliateTier };
    const cfg = await getAffiliateConfig(tx, aff.organizationId);
    const monthly = await monthlyQualifiedRevenue(tx, affiliateId, period);
    const newTier = tierForRevenue(cfg.settings, monthly);
    if (newTier === aff.tier) return { changed: false, tier: newTier };
    const newRate = tierRateBps(cfg.settings, newTier);
    await tx.update(affiliates).set({ tier: newTier, tierRateBps: newRate, effectiveRateBps: newRate, updatedAt: new Date() }).where(eq(affiliates.id, affiliateId));
    await tx.insert(affiliateTierHistory).values({
      organizationId: aff.organizationId, affiliateId, priorTier: aff.tier, newTier, qualificationPeriod: period,
      qualifiedRevenueMicros: monthly, reason: 'automatic tier recalculation', automatic: true, staffActorUserId: actor?.userId ?? null,
    });
    await recordAudit(tx, { organizationId: aff.organizationId, actor: actor ?? { type: 'SYSTEM', userId: null, label: 'affiliate-tiers' }, subjectType: 'AFFILIATE', subjectId: null, action: 'affiliate.tier.changed', prevState: { tier: aff.tier }, newState: { tier: newTier, qualifiedRevenueMicros: monthly } , reason: `tier ${aff.tier}→${newTier}` });
    return { changed: true, tier: newTier };
  });
}

/** Owner-driven manual tier assignment (audited; records history). */
export async function setTierManual(db: Database, affiliateId: string, tier: AffiliateTier, actor: Actor, reason: string): Promise<void> {
  const [aff] = await db.select().from(affiliates).where(eq(affiliates.id, affiliateId));
  if (!aff) return;
  const cfg = await getAffiliateConfig(db, aff.organizationId);
  const rate = tier === 'STRATEGIC' ? aff.effectiveRateBps : tierRateBps(cfg.settings, tier);
  await db.update(affiliates).set({ tier, tierRateBps: rate, effectiveRateBps: aff.customRateBps ?? rate, updatedAt: new Date() }).where(eq(affiliates.id, affiliateId));
  await db.insert(affiliateTierHistory).values({ organizationId: aff.organizationId, affiliateId, priorTier: aff.tier, newTier: tier, reason, automatic: false, staffActorUserId: actor.userId ?? null });
  await recordAudit(db, { organizationId: aff.organizationId, actor, subjectType: 'AFFILIATE', subjectId: null, action: 'affiliate.tier.manual', prevState: { tier: aff.tier }, newState: { tier }, reason });
}

export async function recalcAllTiers(db: Database, organizationId: string, period = currentPeriod()): Promise<number> {
  const rows = await db.select({ id: affiliates.id }).from(affiliates).where(and(eq(affiliates.organizationId, organizationId), eq(affiliates.status, 'ACTIVE')));
  let changed = 0;
  for (const r of rows) { const res = await recalculateTier(db, r.id, period); if (res.changed) changed += 1; }
  return changed;
}
