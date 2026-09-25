/**
 * Affiliate program configuration (M11), versioned and append-only.
 *
 * The active config is the highest version for the org. Every commission
 * snapshots the config version that produced it, so changing a rate or threshold
 * tomorrow never rewrites yesterday's commissions. Money is micros (integer);
 * rates are basis points (bps): 1500 = 15%, 1750 = 17.5%, 2000 = 20%, 2500 = 25%.
 * No floating-point money arithmetic anywhere.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { affiliateConfig } from '../db/schema.js';
import { recordAudit } from './audit.js';
import type { Actor } from './actor.js';

export const AFFILIATE_TIERS = ['AFFILIATE', 'PARTNER', 'GOLD', 'PLATINUM', 'STRATEGIC'] as const;
export type AffiliateTier = (typeof AFFILIATE_TIERS)[number];

export type ResetCommissionPolicy = 'NONE' | 'FULL' | 'REDUCED';
export type CommissionBasis = 'NET_AFTER_DISCOUNT' | 'GROSS';
export type SelfReferralPolicy = 'DENY' | 'REVIEW';
export type PayoutFrequency = 'ON_REQUEST' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';

const M = 1_000_000;

export interface AffiliateSettings {
  readonly applicationsEnabled: boolean;
  readonly attributionWindowDays: number;
  readonly referralCookieDays: number;
  readonly commissionMaturityDays: number;
  readonly defaultTier: AffiliateTier;
  /** Monthly qualified-revenue thresholds in micros, per tier (AFFILIATE = 0). */
  readonly tierThresholdsMicros: Record<Exclude<AffiliateTier, 'STRATEGIC'>, number>;
  /** Tier rates in bps. STRATEGIC has no automatic rate (manual/custom only). */
  readonly tierRatesBps: Record<Exclude<AffiliateTier, 'STRATEGIC'>, number>;
  readonly resetCommissionPolicy: ResetCommissionPolicy;
  readonly resetCommissionRateBps: number | null;
  readonly commissionBasis: CommissionBasis;
  readonly minPayoutMicros: number;
  readonly agreementRequired: boolean;
  readonly selfReferralPolicy: SelfReferralPolicy;
  readonly payoutFrequency: PayoutFrequency;
  readonly gracePeriodDays: number;
  /** Business timezone for monthly tier qualification periods. */
  readonly timezone: string;
  readonly qualifyingRevenue: {
    readonly newAccount: boolean;
    readonly additionalAccount: boolean;
    readonly courtesy: boolean;
    readonly refunded: boolean;
    readonly chargeback: boolean;
    readonly failed: boolean;
    readonly reset: boolean;
  };
}

/**
 * The documented V1 defaults. Every value is configurable via Owner OS.
 * - 15% base, 17.5/20/25% tiers at $10k/$30k/$75k monthly qualified revenue.
 * - 30-day attribution, 14-day commission maturity, $50 minimum payout.
 * - Commission basis: net after affiliate/promo discount, excluding tax/refunds.
 * - Reset purchases do NOT commission by default (configurable).
 * - Self-referral denied. Payouts on request. Business tz America/New_York.
 */
export const DEFAULT_AFFILIATE_SETTINGS: AffiliateSettings = {
  applicationsEnabled: true,
  attributionWindowDays: 30,
  referralCookieDays: 30,
  commissionMaturityDays: 14,
  defaultTier: 'AFFILIATE',
  tierThresholdsMicros: { AFFILIATE: 0, PARTNER: 10_000 * M, GOLD: 30_000 * M, PLATINUM: 75_000 * M },
  tierRatesBps: { AFFILIATE: 1500, PARTNER: 1750, GOLD: 2000, PLATINUM: 2500 },
  resetCommissionPolicy: 'NONE',
  resetCommissionRateBps: null,
  commissionBasis: 'NET_AFTER_DISCOUNT',
  minPayoutMicros: 50 * M,
  agreementRequired: true,
  selfReferralPolicy: 'DENY',
  payoutFrequency: 'ON_REQUEST',
  gracePeriodDays: 0,
  timezone: 'America/New_York',
  qualifyingRevenue: {
    newAccount: true,
    additionalAccount: true,
    courtesy: false,
    refunded: false,
    chargeback: false,
    failed: false,
    reset: false,
  },
};

export interface ActiveConfig {
  readonly version: number;
  readonly settings: AffiliateSettings;
}

/** Read the active config, seeding the default version 1 if none exists. */
export async function getAffiliateConfig(db: Database, organizationId: string): Promise<ActiveConfig> {
  const [row] = await db
    .select()
    .from(affiliateConfig)
    .where(and(eq(affiliateConfig.organizationId, organizationId), eq(affiliateConfig.isActive, true)))
    .orderBy(desc(affiliateConfig.version))
    .limit(1);
  if (row) return { version: row.version, settings: row.settings as AffiliateSettings };
  // Seed version 1 with the documented defaults.
  const [seeded] = await db
    .insert(affiliateConfig)
    .values({ organizationId, version: 1, settings: DEFAULT_AFFILIATE_SETTINGS as never, isActive: true })
    .onConflictDoNothing({ target: [affiliateConfig.organizationId, affiliateConfig.version] })
    .returning();
  if (seeded) return { version: seeded.version, settings: seeded.settings as AffiliateSettings };
  // A concurrent seed won; read it back.
  const [winner] = await db
    .select()
    .from(affiliateConfig)
    .where(and(eq(affiliateConfig.organizationId, organizationId), eq(affiliateConfig.isActive, true)))
    .orderBy(desc(affiliateConfig.version))
    .limit(1);
  return { version: winner!.version, settings: winner!.settings as AffiliateSettings };
}

/** Publish a new config version (append-only). Deep-merges a partial patch. */
export async function updateAffiliateConfig(
  db: Database,
  organizationId: string,
  patch: Partial<AffiliateSettings>,
  actor: Actor,
): Promise<ActiveConfig> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const current = await getAffiliateConfig(scoped, organizationId);
    const next: AffiliateSettings = {
      ...current.settings,
      ...patch,
      tierThresholdsMicros: { ...current.settings.tierThresholdsMicros, ...(patch.tierThresholdsMicros ?? {}) },
      tierRatesBps: { ...current.settings.tierRatesBps, ...(patch.tierRatesBps ?? {}) },
      qualifyingRevenue: { ...current.settings.qualifyingRevenue, ...(patch.qualifyingRevenue ?? {}) },
    };
    await tx.update(affiliateConfig).set({ isActive: false }).where(eq(affiliateConfig.organizationId, organizationId));
    const [row] = await tx
      .insert(affiliateConfig)
      .values({ organizationId, version: current.version + 1, settings: next as never, isActive: true, createdByUserId: actor.userId ?? null })
      .returning();
    await recordAudit(scoped, {
      organizationId,
      actor,
      subjectType: 'ORGANIZATION',
      subjectId: null,
      action: 'affiliate.config.changed',
      prevState: { version: current.version },
      newState: { version: row!.version },
      reason: 'affiliate program configuration updated',
    });
    return { version: row!.version, settings: row!.settings as AffiliateSettings };
  });
}

// --- money / rate helpers (integer only) -----------------------------------

/** commission = floor(qualifiedRevenueMicros * rateBps / 10000). Floors so we
 * never over-pay by a rounding cent. Uses BigInt to avoid any precision risk. */
export function commissionMicrosFor(qualifiedRevenueMicros: number, rateBps: number): number {
  if (qualifiedRevenueMicros <= 0 || rateBps <= 0) return 0;
  return Number((BigInt(Math.trunc(qualifiedRevenueMicros)) * BigInt(Math.trunc(rateBps))) / 10_000n);
}

/** The tier a given monthly qualified revenue qualifies for (highest threshold met). */
export function tierForRevenue(settings: AffiliateSettings, monthlyQualifiedMicros: number): Exclude<AffiliateTier, 'STRATEGIC'> {
  const order: Array<Exclude<AffiliateTier, 'STRATEGIC'>> = ['PLATINUM', 'GOLD', 'PARTNER', 'AFFILIATE'];
  for (const tier of order) {
    if (monthlyQualifiedMicros >= settings.tierThresholdsMicros[tier]) return tier;
  }
  return 'AFFILIATE';
}

/** The bps rate for a tier from config (STRATEGIC has no automatic rate). */
export function tierRateBps(settings: AffiliateSettings, tier: AffiliateTier): number {
  if (tier === 'STRATEGIC') return 0;
  return settings.tierRatesBps[tier];
}
