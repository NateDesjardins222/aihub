/**
 * Affiliate commission engine + append-only ledger (M11-D/F).
 *
 * A commission is created exactly once per commercial order (unique conversion
 * index + a per-order advisory lock). It snapshots the qualified revenue, the
 * applied rate (bps), the rate source, the tier, the product version and the
 * config version, so changing configuration later never rewrites history.
 * Commissions mature after the configured window (refund/chargeback risk clears)
 * and only then become available. Money is micros; nothing is floating-point.
 *
 * The ledger is the money source of truth. availableMicros = sum(all ledger
 * amounts). Balance-moving events carry a signed amount; lifecycle-only events
 * (COMMISSION_CREATED/HELD/RELEASED) carry 0 so the sum stays exact.
 */
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  affiliateCommissions, affiliateConversions, affiliateLedger, affiliateRiskSignals, affiliates,
  commercialOrders, customerIdentities,
} from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from './audit.js';
import { getAffiliateConfig, commissionMicrosFor } from './affiliate-config.js';
import { resolveAttribution } from './affiliate-attribution.js';
import { computeEffectiveRateBps } from './affiliates.js';
import type { Actor } from './actor.js';

const ORDER_LOCK_CLASS = 0x41434f4d; // 'ACOM'

export const LEDGER_BALANCE_TYPES = ['COMMISSION_MATURED', 'COMMISSION_REVERSED', 'PAYOUT_PAID', 'PAYOUT_RETURNED', 'MANUAL_ADJUSTMENT'] as const;

async function ledgerEntry(
  tx: Database,
  e: { organizationId: string; affiliateId: string; entryType: string; amountMicros: number; commissionId?: string | null; payoutId?: string | null; commercialOrderId?: string | null; reasonCode?: string | null; explanation?: string | null; actor?: Actor; correlationId?: string | null },
): Promise<void> {
  await tx.insert(affiliateLedger).values({
    organizationId: e.organizationId, affiliateId: e.affiliateId, entryType: e.entryType, amountMicros: e.amountMicros,
    commissionId: e.commissionId ?? null, payoutId: e.payoutId ?? null, commercialOrderId: e.commercialOrderId ?? null,
    reasonCode: e.reasonCode ?? null, explanation: e.explanation ?? null, actorUserId: e.actor?.userId ?? null,
    correlationId: e.correlationId ?? null,
  });
}

export interface ProcessConversionInput {
  readonly orderId: string;
  readonly sessionRef?: string | null;
  readonly explicitCode?: string | null;
  readonly discountMicros?: number | null;
  readonly isReset?: boolean;
  readonly actor?: Actor;
}

export interface ProcessConversionResult {
  readonly created: boolean;
  readonly reason: string;
  readonly conversionId?: string;
  readonly commissionId?: string;
  readonly affiliateId?: string;
  readonly commissionMicros?: number;
}

/**
 * Create the affiliate conversion + commission for a settled commercial order,
 * exactly once. Idempotent: a repeat call (duplicate webhook, replay, race)
 * returns the existing result and never double-commissions.
 */
export async function processConversion(db: Database, input: ProcessConversionInput): Promise<ProcessConversionResult> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(${ORDER_LOCK_CLASS}, hashtext(${input.orderId}))`);

    const [order] = await tx.select().from(commercialOrders).where(eq(commercialOrders.id, input.orderId));
    if (!order) throw ApiError.notFound('ORDER_NOT_FOUND', 'Commercial order not found.');

    // Already processed? (unique conversion per order)
    const [existing] = await tx.select().from(affiliateConversions).where(eq(affiliateConversions.commercialOrderId, order.id));
    if (existing) {
      const [comm] = await tx.select({ id: affiliateCommissions.id, commissionMicros: affiliateCommissions.commissionMicros }).from(affiliateCommissions).where(eq(affiliateCommissions.conversionId, existing.id));
      return { created: false, reason: 'ALREADY_PROCESSED', conversionId: existing.id, commissionId: comm?.id, affiliateId: existing.affiliateId, commissionMicros: comm?.commissionMicros };
    }

    // The commerce event must be authoritative: only settled orders commission.
    if (!['COMPLETED', 'PROVISIONED'].includes(order.status)) return { created: false, reason: `ORDER_NOT_SETTLED:${order.status}` };
    if (order.refundedAt) return { created: false, reason: 'ORDER_REFUNDED' };

    const cfg = await getAffiliateConfig(tx, order.organizationId);
    const q = cfg.settings.qualifyingRevenue;

    // Qualifying-revenue policy.
    const isCourtesy = order.source !== 'PURCHASE';
    if (isCourtesy && !q.courtesy) return { created: false, reason: 'NOT_QUALIFYING:COURTESY' };
    if (input.isReset && !q.reset && cfg.settings.resetCommissionPolicy === 'NONE') return { created: false, reason: 'NOT_QUALIFYING:RESET' };

    // Attribution (deterministic precedence).
    const attribution = await resolveAttribution(tx, order.organizationId, { sessionRef: input.sessionRef, explicitCode: input.explicitCode });
    if (!attribution) return { created: false, reason: 'NO_ATTRIBUTION' };

    const [aff] = await tx.select().from(affiliates).where(eq(affiliates.id, attribution.affiliateId));
    if (!aff) return { created: false, reason: 'AFFILIATE_NOT_FOUND' };
    if (aff.status !== 'ACTIVE') return { created: false, reason: `AFFILIATE_NOT_ACTIVE:${aff.status}` };

    // Self-referral guard (§16): same user or same verified identity.
    const [buyerIdentity] = await tx.select({ id: customerIdentities.id }).from(customerIdentities).where(eq(customerIdentities.userId, order.userId));
    const selfByUser = aff.userId != null && aff.userId === order.userId;
    const selfByIdentity = aff.customerIdentityId != null && buyerIdentity?.id != null && aff.customerIdentityId === buyerIdentity.id;
    if (selfByUser || selfByIdentity) {
      await tx.insert(affiliateRiskSignals).values({
        organizationId: order.organizationId, affiliateId: aff.id, signalType: 'SELF_REFERRAL_ATTEMPT', severity: 'WARNING',
        detail: { orderId: order.id, selfByUser, selfByIdentity } as never, status: 'OPEN',
      });
      return { created: false, reason: 'SELF_REFERRAL_DENIED' };
    }

    // Qualified revenue: net after discount by default, excluding tax/refunds.
    const gross = order.amountMicros ?? 0;
    if (gross <= 0) return { created: false, reason: 'NO_REVENUE' };
    const discount = Math.max(0, input.discountMicros ?? 0);
    const qualified = cfg.settings.commissionBasis === 'NET_AFTER_DISCOUNT' ? Math.max(0, gross - discount) : gross;

    // Applied rate: reset REDUCED policy overrides; else the affiliate effective rate.
    const eff = computeEffectiveRateBps(aff);
    let rateBps = eff.bps;
    let rateSource: string = eff.source;
    if (input.isReset && cfg.settings.resetCommissionPolicy === 'REDUCED' && cfg.settings.resetCommissionRateBps != null) {
      rateBps = cfg.settings.resetCommissionRateBps;
      rateSource = 'RESET_REDUCED';
    }
    const commissionMicros = commissionMicrosFor(qualified, rateBps);

    const [conv] = await tx.insert(affiliateConversions).values({
      organizationId: order.organizationId, affiliateId: aff.id, codeId: attribution.codeId, commercialOrderId: order.id,
      customerUserId: order.userId, customerIdentityId: buyerIdentity?.id ?? null, source: attribution.source,
      firstTouchAffiliateId: attribution.firstTouchAffiliateId, lastTouchAffiliateId: attribution.lastTouchAffiliateId,
      finalAttributionReason: attribution.finalAttributionReason, qualifiedRevenueMicros: qualified, discountMicros: discount,
      productVersionId: order.productVersionId,
    }).onConflictDoNothing({ target: [affiliateConversions.commercialOrderId] }).returning();
    if (!conv) return { created: false, reason: 'RACE_ALREADY_PROCESSED' };

    const maturityAt = new Date((order.completedAt ?? new Date()).getTime() + cfg.settings.commissionMaturityDays * 86_400_000);
    const [comm] = await tx.insert(affiliateCommissions).values({
      organizationId: order.organizationId, affiliateId: aff.id, conversionId: conv.id, commercialOrderId: order.id,
      customerUserId: order.userId, qualifiedRevenueMicros: qualified, rateBps, rateSource, tierAtEvent: aff.tier,
      commissionMicros, productVersionId: order.productVersionId, configVersion: cfg.version, status: 'TRACKED', maturityAt,
    }).returning();

    await ledgerEntry(tx, { organizationId: order.organizationId, affiliateId: aff.id, entryType: 'COMMISSION_CREATED', amountMicros: 0, commissionId: comm!.id, commercialOrderId: order.id, actor: input.actor, correlationId: order.id });
    await recordAudit(tx, {
      organizationId: order.organizationId, actor: input.actor ?? { type: 'SYSTEM', userId: null, label: 'affiliate-engine' },
      subjectType: 'AFFILIATE', subjectId: null, action: 'affiliate.commission.created',
      newState: { affiliateId: aff.id, orderId: order.id, commissionMicros, rateBps, rateSource }, reason: attribution.finalAttributionReason,
    });
    return { created: true, reason: 'CREATED', conversionId: conv.id, commissionId: comm!.id, affiliateId: aff.id, commissionMicros };
  });
}

/** Mature commissions whose window has elapsed (idempotent per row). */
export async function matureCommissions(db: Database, organizationId: string, now: Date = new Date()): Promise<number> {
  const due = await db.select().from(affiliateCommissions)
    .where(and(eq(affiliateCommissions.organizationId, organizationId), inArray(affiliateCommissions.status, ['TRACKED', 'PENDING']), lte(affiliateCommissions.maturityAt, now)));
  let matured = 0;
  for (const c of due) {
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      // Guard by status so two workers converge to one transition.
      const [updated] = await tx.update(affiliateCommissions)
        .set({ status: 'PAYABLE', maturedAt: now })
        .where(and(eq(affiliateCommissions.id, c.id), inArray(affiliateCommissions.status, ['TRACKED', 'PENDING'])))
        .returning({ id: affiliateCommissions.id });
      if (!updated) return;
      // Refund guard: if the order was refunded in the meantime, cancel instead.
      const [order] = await tx.select({ refundedAt: commercialOrders.refundedAt }).from(commercialOrders).where(eq(commercialOrders.id, c.commercialOrderId));
      if (order?.refundedAt) {
        await tx.update(affiliateCommissions).set({ status: 'CANCELED', reversalReason: 'order refunded before maturity' }).where(eq(affiliateCommissions.id, c.id));
        await ledgerEntry(tx, { organizationId, affiliateId: c.affiliateId, entryType: 'COMMISSION_REVERSED', amountMicros: 0, commissionId: c.id, commercialOrderId: c.commercialOrderId, reasonCode: 'REFUND', explanation: 'refunded before maturity' });
        return;
      }
      await ledgerEntry(tx, { organizationId, affiliateId: c.affiliateId, entryType: 'COMMISSION_MATURED', amountMicros: c.commissionMicros, commissionId: c.id, commercialOrderId: c.commercialOrderId });
      matured += 1;
    });
  }
  return matured;
}

/** Reverse the commission for an order (refund/chargeback). Idempotent. */
export async function reverseCommissionForOrder(db: Database, orderId: string, reason: string, actor?: Actor): Promise<{ reversed: boolean; state?: string }> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    const [comm] = await tx.select().from(affiliateCommissions).where(eq(affiliateCommissions.commercialOrderId, orderId));
    if (!comm) return { reversed: false };
    if (['REVERSED', 'CANCELED'].includes(comm.status)) return { reversed: false, state: comm.status };
    const wasAvailable = ['PAYABLE', 'PAID'].includes(comm.status); // money had matured/paid → remove from balance
    const nextStatus = ['TRACKED', 'PENDING', 'HELD'].includes(comm.status) ? 'CANCELED' : 'REVERSED';
    await tx.update(affiliateCommissions).set({ status: nextStatus, reversedAt: new Date(), reversalReason: reason.slice(0, 200) }).where(eq(affiliateCommissions.id, comm.id));
    await ledgerEntry(tx, {
      organizationId: comm.organizationId, affiliateId: comm.affiliateId, entryType: 'COMMISSION_REVERSED',
      amountMicros: wasAvailable ? -comm.commissionMicros : 0, commissionId: comm.id, commercialOrderId: orderId,
      reasonCode: 'REVERSAL', explanation: reason.slice(0, 200), actor,
    });
    await recordAudit(tx, {
      organizationId: comm.organizationId, actor: actor ?? { type: 'SYSTEM', userId: null, label: 'affiliate-engine' },
      subjectType: 'AFFILIATE', subjectId: null, action: 'affiliate.commission.reversed',
      prevState: { status: comm.status }, newState: { status: nextStatus }, reason,
    });
    return { reversed: true, state: nextStatus };
  });
}

/** Manual, reason-coded, append-only commission adjustment (owner correction). */
export async function manualAdjustment(db: Database, input: { organizationId: string; affiliateId: string; amountMicros: number; reasonCode: string; explanation: string; actor: Actor }): Promise<void> {
  if (!Number.isInteger(input.amountMicros) || input.amountMicros === 0) throw ApiError.badRequest('INVALID_AMOUNT', 'A non-zero integer amount is required.');
  if (!input.explanation || input.explanation.trim().length < 5) throw ApiError.badRequest('EXPLANATION_REQUIRED', 'A written explanation is required.');
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    await ledgerEntry(tx, { organizationId: input.organizationId, affiliateId: input.affiliateId, entryType: 'MANUAL_ADJUSTMENT', amountMicros: Math.trunc(input.amountMicros), reasonCode: input.reasonCode, explanation: input.explanation.trim(), actor: input.actor });
    await recordAudit(tx, { organizationId: input.organizationId, actor: input.actor, subjectType: 'AFFILIATE', subjectId: null, action: 'affiliate.commission.adjusted', newState: { amountMicros: input.amountMicros, reasonCode: input.reasonCode }, reason: input.explanation.trim() });
  });
}

export interface AffiliateBalance {
  readonly availableMicros: number;
  readonly pendingMicros: number;
  readonly inFlightPayoutMicros: number;
  readonly withdrawableMicros: number;
  readonly lifetimePaidMicros: number;
  readonly reversalMicros: number;
}

/** Balances derived from the ledger + commission states + in-flight payouts. */
export async function affiliateBalance(db: Database, affiliateId: string): Promise<AffiliateBalance> {
  const [led] = await db.select({
    available: sql<number>`coalesce(sum(${affiliateLedger.amountMicros}),0)::bigint`,
    reversals: sql<number>`coalesce(sum(case when ${affiliateLedger.entryType} = 'COMMISSION_REVERSED' then -${affiliateLedger.amountMicros} else 0 end),0)::bigint`,
    paid: sql<number>`coalesce(sum(case when ${affiliateLedger.entryType} = 'PAYOUT_PAID' then -${affiliateLedger.amountMicros} else 0 end),0)::bigint`,
  }).from(affiliateLedger).where(eq(affiliateLedger.affiliateId, affiliateId));
  const [pend] = await db.select({
    pending: sql<number>`coalesce(sum(case when ${affiliateCommissions.status} in ('TRACKED','PENDING','HELD') then ${affiliateCommissions.commissionMicros} else 0 end),0)::bigint`,
  }).from(affiliateCommissions).where(eq(affiliateCommissions.affiliateId, affiliateId));
  const available = Number(led?.available ?? 0);
  // In-flight payouts are handled in the payouts module; imported lazily to avoid a cycle.
  const { inFlightPayoutMicros } = await import('./affiliate-payouts.js').then((m) => m.inFlightPayoutTotal(db, affiliateId)).catch(() => ({ inFlightPayoutMicros: 0 }));
  return {
    availableMicros: available,
    pendingMicros: Number(pend?.pending ?? 0),
    inFlightPayoutMicros,
    withdrawableMicros: available - inFlightPayoutMicros,
    lifetimePaidMicros: Number(led?.paid ?? 0),
    reversalMicros: Number(led?.reversals ?? 0),
  };
}
