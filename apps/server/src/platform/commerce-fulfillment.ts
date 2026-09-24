/**
 * Gated automatic provisioning — the layer between a money-success order and a
 * provisioned evaluation account.
 *
 * A COMPLETED order (money settled server-side) does NOT provision until the
 * customer's identity, contact, and agreements gate is satisfied. If it is not,
 * the order parks recoverably in PROVISION_BLOCKED — the payment is never lost,
 * and a browser success screen (which never reaches here) can never provision. A
 * provisioning error after payment parks in PROVISION_FAILED. Both are re-drivable
 * by the sweep (a cleared gate, a transient failure resolved) or an owner retry,
 * and because grant + provision are idempotent, re-running converges to exactly
 * one account.
 *
 * The gate applies to PURCHASE orders; an ADMIN_GRANT / PROMO is a deliberate,
 * audited owner action that bypasses it.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { commercialOrders, entitlements } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';
import { CommerceError, fulfillCompletedOrder } from './commerce.js';
import { evaluateProvisioningGate } from './provisioning-gate.js';

type CommercialOrderRow = typeof commercialOrders.$inferSelect;

export type FulfillmentResult =
  | { status: 'PROVISIONED'; orderId: string; accountId: string; entitlementId?: string; reused: boolean }
  | { status: 'PROVISION_BLOCKED'; orderId: string; blockedReasons: string[] }
  | { status: 'PROVISION_FAILED'; orderId: string; error: string };

/** The account an order's entitlement provisioned, if any. */
export async function orderAccountId(db: Database, orderId: string): Promise<string | null> {
  const [ent] = await db
    .select({ accountId: entitlements.consumedByAccountId })
    .from(entitlements)
    .where(and(eq(entitlements.commercialOrderId, orderId), eq(entitlements.kind, 'EVALUATION')));
  return ent?.accountId ?? null;
}

async function setProvisionState(
  db: Database,
  order: CommercialOrderRow,
  status: 'PROVISION_BLOCKED' | 'PROVISION_FAILED',
  note: string,
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    // Never clobber a PROVISIONED order (a concurrent success won).
    await tx
      .update(commercialOrders)
      .set({ status, provisionNote: note.slice(0, 2000) })
      .where(and(eq(commercialOrders.id, order.id), inArray(commercialOrders.status, ['COMPLETED', 'PROVISION_BLOCKED', 'PROVISION_FAILED'])));
    await recordAudit(scoped, {
      organizationId: order.organizationId,
      actor,
      subjectType: 'COMMERCE',
      subjectId: order.id,
      userId: order.userId,
      action: status === 'PROVISION_BLOCKED' ? 'commerce.provisioning_blocked' : 'commerce.provisioning_failed',
      newState: { orderId: order.id, note: note.slice(0, 200) },
      reason: null,
    });
    await events.publish(scoped, {
      type: status === 'PROVISION_BLOCKED' ? 'entitlement.provisioning_blocked' : 'entitlement.provisioning_failed',
      organizationId: order.organizationId,
      userId: order.userId,
      payload: { orderId: order.id, note: note.slice(0, 200) },
    });
  });
}

/**
 * Provision a COMPLETED order through the gate. Re-reads the order fresh so it is
 * safe to call from the webhook, the sweep, or an owner retry. Idempotent: a
 * PROVISIONED order returns its account; a blocked order re-checks the gate.
 */
export async function fulfillPurchaseGated(
  db: Database,
  orderId: string,
  opts: { actor?: Actor; enforceGate?: boolean } = {},
): Promise<FulfillmentResult> {
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const [order] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, orderId));
  if (!order) throw new CommerceError('PRODUCT_NOT_FOUND', 'No such order.');

  if (order.status === 'PROVISIONED') {
    const accountId = await orderAccountId(db, orderId);
    return { status: 'PROVISIONED', orderId, accountId: accountId ?? '', reused: true };
  }

  const enforce = opts.enforceGate ?? order.source === 'PURCHASE';
  if (enforce) {
    const gate = await evaluateProvisioningGate(db, order.organizationId, order.userId);
    if (!gate.satisfied) {
      await setProvisionState(db, order, 'PROVISION_BLOCKED', gate.blockedReasons.join(','), actor);
      return { status: 'PROVISION_BLOCKED', orderId, blockedReasons: gate.blockedReasons };
    }
  }

  try {
    const done = await fulfillCompletedOrder(db, order, { actor });
    await db.transaction(async (tx) => {
      const scoped = tx as unknown as Database;
      await tx
        .update(commercialOrders)
        .set({ status: 'PROVISIONED', provisionNote: null })
        .where(
          and(
            eq(commercialOrders.id, order.id),
            inArray(commercialOrders.status, ['COMPLETED', 'PROVISION_BLOCKED', 'PROVISION_FAILED']),
          ),
        );
      await recordAudit(scoped, {
        organizationId: order.organizationId,
        actor,
        subjectType: 'COMMERCE',
        subjectId: order.id,
        userId: order.userId,
        action: 'commerce.provisioned',
        newState: { orderId: order.id, accountId: done.accountId },
        reason: null,
      });
      await events.publish(scoped, {
        type: 'entitlement.provisioned',
        organizationId: order.organizationId,
        userId: order.userId,
        accountId: done.accountId,
        payload: { orderId: order.id, entitlementId: done.entitlementId, accountId: done.accountId },
      });
    });
    return {
      status: 'PROVISIONED',
      orderId,
      accountId: done.accountId,
      entitlementId: done.entitlementId,
      reused: done.reused,
    };
  } catch (err) {
    await setProvisionState(db, order, 'PROVISION_FAILED', String(err), actor);
    return { status: 'PROVISION_FAILED', orderId, error: String(err).slice(0, 200) };
  }
}

/**
 * Re-drive every purchase whose money settled but which is not yet provisioned
 * (COMPLETED / PROVISION_BLOCKED / PROVISION_FAILED). The recovery net for a gate
 * that has since cleared, a transient provisioning failure, or a crash between
 * payment and provisioning. Idempotent; returns how many became PROVISIONED.
 */
export async function retryPendingProvisioning(db: Database): Promise<number> {
  const rows = await db
    .select({ id: commercialOrders.id })
    .from(commercialOrders)
    .where(
      and(
        eq(commercialOrders.source, 'PURCHASE'),
        inArray(commercialOrders.status, ['COMPLETED', 'PROVISION_BLOCKED', 'PROVISION_FAILED']),
      ),
    );
  let provisioned = 0;
  for (const row of rows) {
    const result = await fulfillPurchaseGated(db, row.id, {
      actor: { type: 'SYSTEM', label: 'provisioning-sweep' },
    }).catch(() => null);
    if (result?.status === 'PROVISIONED') provisioned += 1;
  }
  return provisioned;
}

/**
 * When a customer clears identity or accepts agreements, re-drive their blocked
 * purchases so a buyer who finishes onboarding right after paying is provisioned
 * promptly without an operator. A bystander: a failure never fails the event.
 */
export function registerProvisioningRecovery(db: Database): () => void {
  return events.subscribe((event) => {
    if (event.type !== 'identity.verified' && event.type !== 'agreement.accepted') return;
    if (!event.userId) return;
    const userId = event.userId;
    // Defer the DB work off the publishing call stack. events.publish awaits its
    // handlers inside the caller's transaction, which already holds the org audit
    // advisory lock; doing org-locked work here synchronously would deadlock. As a
    // bystander (events.ts), we schedule the recovery to run after that tx commits.
    setTimeout(() => {
      void (async () => {
        const rows = await db
          .select({ id: commercialOrders.id })
          .from(commercialOrders)
          .where(
            and(
              eq(commercialOrders.userId, userId),
              eq(commercialOrders.source, 'PURCHASE'),
              inArray(commercialOrders.status, ['COMPLETED', 'PROVISION_BLOCKED', 'PROVISION_FAILED']),
            ),
          )
          .catch(() => []);
        for (const row of rows) {
          await fulfillPurchaseGated(db, row.id, {
            actor: { type: 'SYSTEM', label: 'gate-cleared-recovery' },
          }).catch(() => undefined);
        }
      })();
    }, 0);
  });
}
