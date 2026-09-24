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
import { CommerceError, fulfillCompletedOrder, markOrderCompleted } from './commerce.js';
import { evaluateProvisioningGate } from './provisioning-gate.js';
import { AccountLimitError, countActiveAccounts, MAX_ACTIVE_ACCOUNTS } from './account-limit.js';
import { MockCommerceProvider, signMockCommerceEvent } from './commerce-provider.js';
import { markCommerceEventProcessed, recordCommerceEvent } from './commerce-events.js';

type CommercialOrderRow = typeof commercialOrders.$inferSelect;

/** The blocked-reason token when a purchase parks against the active-account limit. */
export const ACTIVE_LIMIT_REASON = 'ACTIVE_LIMIT_REACHED';

export type FulfillmentResult =
  | { status: 'PROVISIONED'; orderId: string; accountId: string; entitlementId?: string; reused: boolean }
  | { status: 'PROVISION_BLOCKED'; orderId: string; blockedReasons: string[] }
  | { status: 'PROVISION_FAILED'; orderId: string; error: string };

/**
 * The account an order's entitlement provisioned, if any. An order grants exactly
 * one entitlement (EVALUATION for a purchase/grant, RESET for a reset
 * re-purchase), so this matches on the order alone rather than a fixed kind — a
 * reset order's provisioned account must resolve too.
 */
export async function orderAccountId(db: Database, orderId: string): Promise<string | null> {
  const [ent] = await db
    .select({ accountId: entitlements.consumedByAccountId })
    .from(entitlements)
    .where(eq(entitlements.commercialOrderId, orderId));
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

  // Both a first purchase and a reset re-purchase are customer-paid orders that
  // must clear the identity/contact/agreements gate before provisioning.
  const enforce = opts.enforceGate ?? (order.source === 'PURCHASE' || order.source === 'RESET');
  if (enforce) {
    const gate = await evaluateProvisioningGate(db, order.organizationId, order.userId);
    if (!gate.satisfied) {
      await setProvisionState(db, order, 'PROVISION_BLOCKED', gate.blockedReasons.join(','), actor);
      return { status: 'PROVISION_BLOCKED', orderId, blockedReasons: gate.blockedReasons };
    }
  }

  // The five-active-account invariant, checked BEFORE we attempt provisioning so
  // an at-limit trader parks in a clean recoverable state (PROVISION_BLOCKED /
  // ACTIVE_LIMIT_REACHED) rather than a hard failure. This read-only check is
  // advisory — the authoritative guard is the per-user advisory lock inside
  // provisionAccount, which the catch below maps to the same blocked state. The
  // entitlement is granted and durable, so the purchase provisions once a slot
  // frees (the sweep re-drives it). Applies to every order that provisions an
  // evaluation, since that path enforces the limit for all sources.
  const activeCount = await countActiveAccounts(db, order.userId);
  if (activeCount >= MAX_ACTIVE_ACCOUNTS) {
    await setProvisionState(db, order, 'PROVISION_BLOCKED', ACTIVE_LIMIT_REASON, actor);
    return { status: 'PROVISION_BLOCKED', orderId, blockedReasons: [ACTIVE_LIMIT_REASON] };
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
    // A concurrent purchase took the last slot between the read-only check and
    // the transactional guard: not a failure, a recoverable block. Park it as
    // ACTIVE_LIMIT_REACHED so the sweep re-drives it once a slot frees.
    if (err instanceof AccountLimitError) {
      await setProvisionState(db, order, 'PROVISION_BLOCKED', ACTIVE_LIMIT_REASON, actor);
      return { status: 'PROVISION_BLOCKED', orderId, blockedReasons: [ACTIVE_LIMIT_REASON] };
    }
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
        inArray(commercialOrders.source, ['PURCHASE', 'RESET']),
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
 * Simulate a provider PAYMENT_SUCCEEDED for an order — the SERVER-SIDE stand-in
 * for the provider webhook, used by the mock onboarding flow (non-production).
 * It mints a genuinely signed mock event and routes it through the SAME
 * record -> dedup -> gated-fulfillment path the real webhook uses, so a browser
 * "pay" click triggers a verified SERVER event (never a browser-side provision),
 * and the reconciliation ledger records it. The browser cannot forge this: the
 * mock secret lives only on the server.
 */
export async function simulateProviderPayment(
  db: Database,
  input: { organizationId: string; orderId: string; actor?: Actor },
): Promise<FulfillmentResult & { eventStatus: string }> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const provider = new MockCommerceProvider();
  const rawBody = JSON.stringify({
    id: `sim_${input.orderId}_${Date.now()}`,
    type: 'payment.succeeded',
    atlasOrderId: input.orderId,
  });
  const raw = { rawBody, headers: signMockCommerceEvent(rawBody) };
  const outcome = await recordCommerceEvent(db, { organizationId: input.organizationId, provider, raw, actor });
  if (outcome.kind !== 'ACCEPTED') {
    // A duplicate/rejected event: return the order's current provisioning state.
    const existing = await fulfillPurchaseGated(db, input.orderId, { actor });
    return { ...existing, eventStatus: outcome.kind };
  }
  await markOrderCompleted(db, input.orderId, { actor });
  const result = await fulfillPurchaseGated(db, input.orderId, { actor });
  await markCommerceEventProcessed(db, outcome.row.id, { atlasOrderId: input.orderId });
  return { ...result, eventStatus: 'ACCEPTED' };
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
              inArray(commercialOrders.source, ['PURCHASE', 'RESET']),
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
