/**
 * Domain events, and the outbox they are written to.
 *
 * Something important happened to an account; whoever cares can find out. The
 * publisher writes a row and notifies whatever is subscribed in this process.
 * Nothing in the execution engine knows any of this exists: the engine emits
 * its own change and valuation events, and a subscriber in this layer turns
 * the ones that matter into domain events and audit records.
 *
 * That separation is the whole point. Payments, e-mail, Discord, a CRM and a
 * payout system attach HERE later, by subscribing or by draining the outbox -
 * never by a call inside the matcher.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { domainEvents } from '../db/schema.js';

export type DomainEventType =
  | 'account.created'
  | 'account.activated'
  | 'account.locked'
  | 'account.unlocked'
  | 'account.passed'
  | 'account.failed'
  | 'account.reset'
  | 'account.disabled'
  | 'account.enabled'
  | 'account.archived'
  | 'account.configuration_changed'
  | 'order.submitted'
  | 'order.modified'
  | 'order.cancelled'
  | 'order.filled'
  | 'position.liquidated'
  | 'rule.violated'
  | 'user.created'
  | 'user.disabled'
  | 'user.enabled'
  | 'profile.version_published'
  // Commercial account lifecycle (Commercial Account Lifecycle V1).
  | 'commercial_order.completed'
  | 'entitlement.granted'
  | 'entitlement.consumed'
  | 'evaluation.qualified'
  | 'funding.requested'
  | 'funding.approved'
  | 'funding.declined'
  | 'account.funded'
  | 'payout.eligibility_unlocked'
  | 'payout.requested'
  | 'payout.blocked'
  | 'payout.under_review'
  | 'payout.approved'
  | 'payout.rejected'
  | 'payout.cancelled'
  | 'payout.processing'
  | 'payout.paid'
  | 'payout.failed'
  | 'payout.hold_placed'
  | 'payout.hold_removed'
  // Customer identity + contact + agreements (Customer Identity V1).
  | 'customer_identity.created'
  | 'contact.challenge_started'
  | 'contact.verified'
  | 'identity.verification_started'
  | 'identity.step_up_required'
  | 'identity.under_review'
  | 'identity.verified'
  | 'identity.rejected'
  | 'agreement.accepted'
  // Commerce provisioning + notifications (Commerce Provisioning / Notifications V1).
  | 'commerce.event_received'
  | 'commerce.event_rejected'
  | 'entitlement.provisioned'
  | 'entitlement.provisioning_blocked'
  | 'entitlement.provisioning_failed'
  | 'commerce.refunded'
  | 'commerce.dispute_opened'
  | 'commerce.dispute_closed'
  | 'notification.sent'
  | 'notification.failed'
  // Customer portal lifecycle (Customer Portal V1).
  | 'account.inactivity_warning'
  | 'account.inactivity_closed'
  | 'account.completed'
  | 'certificate.issued'
  | 'certificate.revoked'
  | 'achievement.issued'
  // Native copy trading (Copy Trading V1).
  | 'copy.group.created'
  | 'copy.group.paused'
  | 'copy.group.resumed'
  | 'copy.group.disabled'
  | 'copy.group.leader_changed'
  | 'copy.intent.created'
  | 'copy.child.accepted'
  | 'copy.child.rejected'
  | 'copy.group.diverged'
  | 'copy.group.resynced'
  | 'copy.group.flattened'
  // Prohibited conduct + enforcement + appeals (M7).
  | 'enforcement.signal_ingested'
  | 'enforcement.case_opened'
  | 'enforcement.case_updated'
  | 'enforcement.hold_placed'
  | 'enforcement.hold_released'
  | 'enforcement.finding_recorded'
  | 'enforcement.action_recorded'
  | 'enforcement.information_requested'
  | 'enforcement.information_provided'
  | 'enforcement.appeal_submitted'
  | 'enforcement.appeal_decided';

export interface DomainEvent {
  readonly type: DomainEventType;
  readonly organizationId: string | null;
  readonly accountId?: string | null;
  readonly userId?: string | null;
  readonly payload: Record<string, unknown>;
  readonly occurredAt?: Date;
}

export type EventHandler = (event: DomainEvent) => void | Promise<void>;

class EventBus {
  private readonly handlers = new Set<EventHandler>();

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Record an event and hand it to the subscribers.
   *
   * The row is written first: a subscriber that throws must not lose the
   * event, and a process that dies after the write still has it in the outbox
   * for a future delivery worker. Subscriber failures are swallowed on purpose
   * - a broken notifier must never fail the account action that caused it.
   */
  async publish(db: Database, event: DomainEvent): Promise<void> {
    await db.insert(domainEvents).values({
      organizationId: event.organizationId,
      type: event.type,
      accountId: event.accountId ?? null,
      userId: event.userId ?? null,
      payload: event.payload as never,
      occurredAt: event.occurredAt ?? new Date(),
    });

    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch {
        // A subscriber is a bystander. It does not get a vote on whether the
        // account action succeeded.
      }
    }
  }
}

export const events = new EventBus();

/** Undelivered events, oldest first. For the delivery worker that comes later. */
export async function pendingEvents(db: Database, limit = 100) {
  return db
    .select()
    .from(domainEvents)
    .where(isNull(domainEvents.deliveredAt))
    .orderBy(asc(domainEvents.occurredAt))
    .limit(limit);
}

export async function markDelivered(db: Database, id: string): Promise<void> {
  await db
    .update(domainEvents)
    .set({ deliveredAt: new Date(), attempts: sql`${domainEvents.attempts} + 1` })
    .where(and(eq(domainEvents.id, id), isNull(domainEvents.deliveredAt)));
}
