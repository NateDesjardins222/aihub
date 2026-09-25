/**
 * Affiliate payouts (M11-G), provider-neutral.
 *
 * There is no real external affiliate payout provider configured, so the status
 * is reported truthfully as NOT_CONFIGURED and nothing is ever "sent". A payout
 * moves through REQUESTED → APPROVED → (SUBMITTED/PROCESSING) → PAID | FAILED |
 * RETURNED | CANCELED. Marking PAID is a manual, evidenced, audited action; only
 * then does the money leave the ledger (PAYOUT_PAID, negative). Double-withdrawal
 * is impossible: a per-affiliate advisory lock + an in-flight reservation check.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Database } from '../db/client.js';
import { affiliateLedger, affiliatePayouts, affiliates } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from './audit.js';
import { getAffiliateConfig } from './affiliate-config.js';
import { affiliateBalance } from './affiliate-commissions.js';
import type { Actor } from './actor.js';

const PAYOUT_LOCK_CLASS = 0x41504159; // 'APAY'
const IN_FLIGHT = ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PAYABLE', 'SUBMITTED', 'PROCESSING'] as const;

/** Truthful provider status. No provider is configured for affiliate payouts. */
export function affiliatePayoutProviderStatus(): { provider: string | null; configured: boolean; verified: boolean; status: string; note: string } {
  const provider = process.env['AFFILIATE_PAYOUT_PROVIDER'] ?? null;
  if (!provider) {
    return { provider: null, configured: false, verified: false, status: 'NOT_CONFIGURED', note: 'No affiliate payout provider is configured; payouts are recorded manually only.' };
  }
  // Even if a name is set, we never claim verified from config alone.
  return { provider, configured: true, verified: false, status: 'CONFIGURED_NOT_VERIFIED', note: 'Provider named but not verified.' };
}

export async function inFlightPayoutTotal(db: Database, affiliateId: string): Promise<{ inFlightPayoutMicros: number }> {
  const [row] = await db.select({ total: sql<number>`coalesce(sum(${affiliatePayouts.amountMicros}),0)::bigint` })
    .from(affiliatePayouts).where(and(eq(affiliatePayouts.affiliateId, affiliateId), inArray(affiliatePayouts.status, IN_FLIGHT as unknown as string[])));
  return { inFlightPayoutMicros: Number(row?.total ?? 0) };
}

export async function requestPayout(db: Database, input: { affiliateId: string; amountMicros: number; actor: Actor; note?: string }): Promise<{ id: string; publicRef: string }> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    const [aff] = await tx.select().from(affiliates).where(eq(affiliates.id, input.affiliateId));
    if (!aff) throw ApiError.notFound('AFFILIATE_NOT_FOUND', 'Affiliate not found.');
    await tx.execute(sql`select pg_advisory_xact_lock(${PAYOUT_LOCK_CLASS}, hashtext(${input.affiliateId}))`);
    const cfg = await getAffiliateConfig(tx, aff.organizationId);
    const amount = Math.trunc(input.amountMicros);
    if (amount <= 0) throw ApiError.badRequest('INVALID_AMOUNT', 'A positive amount is required.');
    if (amount < cfg.settings.minPayoutMicros) throw ApiError.badRequest('BELOW_MINIMUM', `Below the minimum payout of ${cfg.settings.minPayoutMicros} micros.`);
    const bal = await affiliateBalance(tx, input.affiliateId);
    if (amount > bal.withdrawableMicros) throw ApiError.badRequest('INSUFFICIENT_BALANCE', 'Requested amount exceeds the withdrawable balance.');
    const publicRef = `HT-APO-${randomBytes(4).toString('hex').toUpperCase().slice(0, 8)}`;
    const [row] = await tx.insert(affiliatePayouts).values({
      organizationId: aff.organizationId, affiliateId: input.affiliateId, publicRef, amountMicros: amount, status: 'REQUESTED',
      requestedByUserId: input.actor.userId ?? null, note: input.note ?? null,
    }).returning();
    await tx.insert(affiliateLedger).values({ organizationId: aff.organizationId, affiliateId: input.affiliateId, entryType: 'PAYOUT_CREATED', amountMicros: 0, payoutId: row!.id, actorUserId: input.actor.userId ?? null });
    await recordAudit(tx, { organizationId: aff.organizationId, actor: input.actor, subjectType: 'AFFILIATE', subjectId: null, action: 'affiliate.payout.requested', newState: { payoutId: row!.id, amountMicros: amount }, reason: 'payout requested' });
    return { id: row!.id, publicRef };
  });
}

async function transition(db: Database, payoutId: string, to: string, from: string[], actor: Actor, patch: Record<string, unknown> = {}): Promise<typeof affiliatePayouts.$inferSelect> {
  const [p] = await db.select().from(affiliatePayouts).where(eq(affiliatePayouts.id, payoutId));
  if (!p) throw ApiError.notFound('PAYOUT_NOT_FOUND', 'Payout not found.');
  if (!from.includes(p.status)) throw ApiError.badRequest('INVALID_TRANSITION', `Cannot move a payout from ${p.status} to ${to}.`);
  const [row] = await db.update(affiliatePayouts).set({ status: to, updatedAt: new Date(), ...patch }).where(eq(affiliatePayouts.id, payoutId)).returning();
  await recordAudit(db, { organizationId: p.organizationId, actor, subjectType: 'AFFILIATE', subjectId: null, action: `affiliate.payout.${to.toLowerCase()}`, prevState: { status: p.status }, newState: { status: to }, reason: `payout ${to.toLowerCase()}` });
  return row!;
}

export async function approvePayout(db: Database, payoutId: string, actor: Actor): Promise<void> {
  await transition(db, payoutId, 'APPROVED', ['REQUESTED', 'UNDER_REVIEW'], actor, { approvedByUserId: actor.userId ?? null });
}

export async function cancelPayout(db: Database, payoutId: string, actor: Actor, reason: string): Promise<void> {
  await transition(db, payoutId, 'CANCELED', ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'], actor, { failureReason: reason.slice(0, 200) });
}

export async function failPayout(db: Database, payoutId: string, actor: Actor, reason: string): Promise<void> {
  await transition(db, payoutId, 'FAILED', ['APPROVED', 'SUBMITTED', 'PROCESSING'], actor, { failureReason: reason.slice(0, 200) });
}

/** Manually mark a payout PAID with an external reference + evidence (§65).
 * Only here does money leave the ledger. Reauth/audit enforced upstream. */
export async function markPayoutPaid(db: Database, payoutId: string, input: { externalReference: string; method: string; evidenceRef?: string; actor: Actor }): Promise<void> {
  if (!input.externalReference || input.externalReference.trim().length < 3) throw ApiError.badRequest('REFERENCE_REQUIRED', 'An external payment reference is required.');
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    const [p] = await tx.select().from(affiliatePayouts).where(eq(affiliatePayouts.id, payoutId));
    if (!p) throw ApiError.notFound('PAYOUT_NOT_FOUND', 'Payout not found.');
    if (!['APPROVED', 'SUBMITTED', 'PROCESSING'].includes(p.status)) throw ApiError.badRequest('INVALID_TRANSITION', `Cannot pay a payout in ${p.status}.`);
    await tx.update(affiliatePayouts).set({
      status: 'PAID', paidAt: new Date(), updatedAt: new Date(), externalReference: input.externalReference.trim().slice(0, 200),
      method: input.method.slice(0, 40), evidenceRef: input.evidenceRef?.slice(0, 200) ?? null,
    }).where(eq(affiliatePayouts.id, payoutId));
    await tx.insert(affiliateLedger).values({ organizationId: p.organizationId, affiliateId: p.affiliateId, entryType: 'PAYOUT_PAID', amountMicros: -p.amountMicros, payoutId: p.id, actorUserId: input.actor.userId ?? null, explanation: `paid via ${input.method} ref ${input.externalReference}` });
    await recordAudit(tx, { organizationId: p.organizationId, actor: input.actor, subjectType: 'AFFILIATE', subjectId: null, action: 'affiliate.payout.paid', prevState: { status: p.status }, newState: { status: 'PAID', externalReference: input.externalReference }, reason: 'payout marked paid' });
  });
}

export async function listPayouts(db: Database, affiliateId: string) {
  return db.select().from(affiliatePayouts).where(eq(affiliatePayouts.affiliateId, affiliateId)).orderBy(sql`${affiliatePayouts.createdAt} desc`);
}
