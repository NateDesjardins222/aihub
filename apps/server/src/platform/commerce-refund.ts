/**
 * Refunds & disputes — explicit state, never a history rewrite.
 *
 * A purchase and the account it produced are NEVER deleted. A refund records the
 * refund on the order and, depending on lifecycle state, revokes an unconsumed
 * entitlement or places the produced account on an owner-reviewable hold. A
 * dispute is a commerce RISK event: it holds the linked account and raises an
 * owner review — no auto-confiscation and no permanent ban on a single dispute.
 * `DISPUTE_CLOSED` is recorded for the owner to resolve the hold.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, commercialOrders, entitlements } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { enqueueOutbox } from './outbox.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';
import { orderAccountId } from './commerce-fulfillment.js';
import { reverseCommissionForOrder } from './affiliate-commissions.js';

type CommercialOrderRow = typeof commercialOrders.$inferSelect;

/** Place an owner-reviewable hold on an account without touching its balance. */
async function holdAccount(db: Database, accountId: string, reason: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [before] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for('update');
    if (!before) return;
    // Do not override a QUALIFIED/ARCHIVED hold; only add a commerce hold to an
    // otherwise-open account. The owner reviews and releases it.
    if (before.adminHold && before.adminHold !== 'PENDING') return;
    await tx
      .update(accounts)
      .set({ adminHold: 'LOCKED', updatedAt: new Date() })
      .where(eq(accounts.id, accountId));
    await recordAudit(scoped, {
      organizationId: before.organizationId,
      actor,
      subjectType: 'ACCOUNT',
      subjectId: accountId,
      accountId,
      userId: before.userId,
      action: 'commerce.account_held',
      prevState: { adminHold: before.adminHold },
      newState: { adminHold: 'LOCKED' },
      reason,
    });
    await enqueueOutbox(scoped, {
      aggregateId: accountId,
      type: 'account.changed',
      payload: { reason: 'commerce.hold' },
    });
  });
}

/**
 * Apply a refund to an order. Preserves history: the order is marked REFUNDED,
 * an unconsumed entitlement is REVOKED (no account ever existed), and a produced
 * account is held for owner review (never deleted, never auto-confiscated).
 */
export async function handleRefund(
  db: Database,
  input: { order: CommercialOrderRow; reason?: string; actor?: Actor },
): Promise<{ status: 'REFUNDED'; heldAccountId: string | null }> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const order = input.order;

  await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    await tx
      .update(commercialOrders)
      .set({ status: 'REFUNDED', refundedAt: new Date(), refundReason: input.reason ?? 'provider_refund' })
      .where(eq(commercialOrders.id, order.id));
    // Revoke an unconsumed entitlement so it can never later provision.
    await tx
      .update(entitlements)
      .set({ status: 'REVOKED' })
      .where(
        and(
          eq(entitlements.commercialOrderId, order.id),
          eq(entitlements.status, 'GRANTED'),
        ),
      );
    await recordAudit(scoped, {
      organizationId: order.organizationId,
      actor,
      subjectType: 'COMMERCE',
      subjectId: order.id,
      userId: order.userId,
      action: 'commerce.refunded',
      prevState: { status: order.status },
      newState: { status: 'REFUNDED' },
      reason: input.reason ?? null,
    });
    await events.publish(scoped, {
      type: 'commerce.refunded',
      organizationId: order.organizationId,
      userId: order.userId,
      payload: { orderId: order.id },
    });
  });

  // If an account was provisioned, hold it for owner review (outside the order tx).
  const accountId = await orderAccountId(db, order.id);
  if (accountId) await holdAccount(db, accountId, `Refund on order ${order.id}`, actor);
  // Reverse any affiliate commission for this order (idempotent; §18).
  await reverseCommissionForOrder(db, order.id, `refund: ${input.reason ?? 'provider_refund'}`, actor).catch(() => undefined);
  return { status: 'REFUNDED', heldAccountId: accountId };
}

/**
 * Apply a dispute/chargeback. On OPEN: hold the linked account (containment) and
 * raise an owner review. On CLOSE: record it; the owner resolves the hold. No
 * auto-confiscation, no permanent ban.
 */
export async function handleDispute(
  db: Database,
  input: { order: CommercialOrderRow; opened: boolean; reason?: string; actor?: Actor },
): Promise<{ status: 'DISPUTE_OPENED' | 'DISPUTE_CLOSED'; heldAccountId: string | null }> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const order = input.order;
  const accountId = await orderAccountId(db, order.id);

  await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    await recordAudit(scoped, {
      organizationId: order.organizationId,
      actor,
      subjectType: 'COMMERCE',
      subjectId: order.id,
      userId: order.userId,
      action: input.opened ? 'commerce.dispute_opened' : 'commerce.dispute_closed',
      newState: { orderId: order.id, accountId },
      reason: input.reason ?? null,
    });
    await events.publish(scoped, {
      type: input.opened ? 'commerce.dispute_opened' : 'commerce.dispute_closed',
      organizationId: order.organizationId,
      userId: order.userId,
      payload: { orderId: order.id, accountId },
    });
  });

  if (input.opened && accountId) {
    await holdAccount(db, accountId, `Dispute opened on order ${order.id}`, actor);
  }
  // A chargeback reverses any affiliate commission for this order (idempotent; §19).
  if (input.opened) {
    await reverseCommissionForOrder(db, order.id, `chargeback: ${input.reason ?? 'dispute_opened'}`, actor).catch(() => undefined);
  }
  return { status: input.opened ? 'DISPUTE_OPENED' : 'DISPUTE_CLOSED', heldAccountId: accountId };
}
