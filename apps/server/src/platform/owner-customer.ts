/**
 * Owner Customer/Commerce console — read models + reconciliation.
 *
 * The operator's view of a customer's whole lifecycle (identity, contacts,
 * agreements, commerce, entitlements, accounts, notifications, audit) and the
 * exception queues that make operations exception-driven. Read-only here; the
 * controlled actions live in the routes and delegate to the existing services.
 * Everything is org-scoped.
 */
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  accounts,
  agreementAcceptances,
  auditLog,
  commerceEvents,
  commercialOrders,
  customerIdentities,
  entitlements,
  identityVerifications,
  notificationMessages,
  users,
  verifiedContacts,
} from '../db/schema.js';
import { outstandingAgreements } from './agreements.js';
import { activeIdentityProviderName } from './identity-providers.js';
import { activeCommerceProviderName } from './commerce-provider.js';
import { activeEmailProviderName, activeSmsProviderName } from './notification-providers.js';

/** Search customers by email or display name (case-insensitive), org-scoped. */
export async function searchCustomers(db: Database, organizationId: string, query: string, limit = 50) {
  const q = `%${query.toLowerCase()}%`;
  return db
    .select({
      customerIdentityId: customerIdentities.id,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      identityStatus: customerIdentities.identityStatus,
      status: customerIdentities.status,
      createdAt: customerIdentities.createdAt,
    })
    .from(customerIdentities)
    .innerJoin(users, eq(users.id, customerIdentities.userId))
    .where(
      and(
        eq(customerIdentities.organizationId, organizationId),
        query.trim() === ''
          ? sql`true`
          : or(sql`lower(${users.email}) like ${q}`, sql`lower(${users.displayName}) like ${q}`),
      ),
    )
    .orderBy(desc(customerIdentities.createdAt))
    .limit(limit);
}

/** The full customer 360, org-scoped. Returns null if not in this org. */
export async function customerDetail(db: Database, organizationId: string, identityId: string) {
  const [identity] = await db
    .select()
    .from(customerIdentities)
    .where(and(eq(customerIdentities.id, identityId), eq(customerIdentities.organizationId, organizationId)));
  if (!identity) return null;

  const [user] = await db.select().from(users).where(eq(users.id, identity.userId));
  const contacts = await db
    .select()
    .from(verifiedContacts)
    .where(eq(verifiedContacts.customerIdentityId, identityId))
    .orderBy(desc(verifiedContacts.createdAt));
  const verifications = await db
    .select()
    .from(identityVerifications)
    .where(eq(identityVerifications.customerIdentityId, identityId))
    .orderBy(desc(identityVerifications.createdAt))
    .limit(10);
  const acceptances = await db
    .select()
    .from(agreementAcceptances)
    .where(eq(agreementAcceptances.customerIdentityId, identityId))
    .orderBy(desc(agreementAcceptances.acceptedAt));
  const outstanding = await outstandingAgreements(db, organizationId, identityId);
  const orders = await db
    .select()
    .from(commercialOrders)
    .where(eq(commercialOrders.userId, identity.userId))
    .orderBy(desc(commercialOrders.createdAt))
    .limit(50);
  const ents = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.userId, identity.userId))
    .orderBy(desc(entitlements.createdAt))
    .limit(50);
  const accts = await db
    .select({
      id: accounts.id,
      publicId: accounts.publicId,
      name: accounts.name,
      accountType: accounts.accountType,
      status: accounts.status,
      adminHold: accounts.adminHold,
      balanceMicros: accounts.balanceMicros,
    })
    .from(accounts)
    .where(eq(accounts.userId, identity.userId))
    .orderBy(desc(accounts.seq))
    .limit(50);
  const notifications = await db
    .select()
    .from(notificationMessages)
    .where(eq(notificationMessages.customerIdentityId, identityId))
    .orderBy(desc(notificationMessages.createdAt))
    .limit(50);
  const audit = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      subjectType: auditLog.subjectType,
      subjectId: auditLog.subjectId,
      createdAt: auditLog.createdAt,
      reason: auditLog.reason,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.organizationId, organizationId),
        or(eq(auditLog.subjectId, identityId), eq(auditLog.userId, identity.userId)),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(50);

  return {
    identity,
    user: user ? { id: user.id, email: user.email, displayName: user.displayName, role: user.role } : null,
    contacts,
    verifications,
    acceptances,
    outstandingAgreements: outstanding,
    orders,
    entitlements: ents,
    accounts: accts,
    notifications,
    audit,
    providers: {
      identity: activeIdentityProviderName(),
      commerce: activeCommerceProviderName(),
      email: activeEmailProviderName(),
      sms: activeSmsProviderName(),
    },
  };
}

// ---------------------------------------------------------------------------
// Exception queues — the operator's work list.
// ---------------------------------------------------------------------------

export async function identityReviewQueue(db: Database, organizationId: string, limit = 100) {
  return db
    .select({
      customerIdentityId: customerIdentities.id,
      userId: users.id,
      email: users.email,
      identityStatus: customerIdentities.identityStatus,
      updatedAt: customerIdentities.updatedAt,
    })
    .from(customerIdentities)
    .innerJoin(users, eq(users.id, customerIdentities.userId))
    .where(
      and(
        eq(customerIdentities.organizationId, organizationId),
        inArray(customerIdentities.identityStatus, ['UNDER_REVIEW', 'STEP_UP_REQUIRED']),
      ),
    )
    .orderBy(desc(customerIdentities.updatedAt))
    .limit(limit);
}

/** PAYMENT SUCCEEDED / PROVISIONING FAILED + AGREEMENT/IDENTITY BLOCK — one queue. */
export async function provisioningExceptionQueue(db: Database, organizationId: string, limit = 100) {
  return db
    .select({
      orderId: commercialOrders.id,
      userId: commercialOrders.userId,
      email: users.email,
      status: commercialOrders.status,
      provisionNote: commercialOrders.provisionNote,
      createdAt: commercialOrders.createdAt,
    })
    .from(commercialOrders)
    .innerJoin(users, eq(users.id, commercialOrders.userId))
    .where(
      and(
        eq(commercialOrders.organizationId, organizationId),
        inArray(commercialOrders.status, ['PROVISION_BLOCKED', 'PROVISION_FAILED']),
      ),
    )
    .orderBy(desc(commercialOrders.createdAt))
    .limit(limit);
}

/** Commerce events received/failed but not processed — nothing silently dropped. */
export async function unprocessedCommerceEventQueue(db: Database, organizationId: string, limit = 100) {
  return db
    .select()
    .from(commerceEvents)
    .where(
      and(
        eq(commerceEvents.organizationId, organizationId),
        inArray(commerceEvents.status, ['RECEIVED', 'FAILED']),
      ),
    )
    .orderBy(desc(commerceEvents.receivedAt))
    .limit(limit);
}

export async function disputeQueue(db: Database, organizationId: string, limit = 100) {
  return db
    .select()
    .from(commerceEvents)
    .where(
      and(
        eq(commerceEvents.organizationId, organizationId),
        inArray(commerceEvents.kind, ['DISPUTE_OPENED', 'DISPUTE_CLOSED']),
      ),
    )
    .orderBy(desc(commerceEvents.receivedAt))
    .limit(limit);
}

export async function refundReviewQueue(db: Database, organizationId: string, limit = 100) {
  return db
    .select({
      orderId: commercialOrders.id,
      userId: commercialOrders.userId,
      email: users.email,
      refundedAt: commercialOrders.refundedAt,
      refundReason: commercialOrders.refundReason,
    })
    .from(commercialOrders)
    .innerJoin(users, eq(users.id, commercialOrders.userId))
    .where(and(eq(commercialOrders.organizationId, organizationId), eq(commercialOrders.status, 'REFUNDED')))
    .orderBy(desc(commercialOrders.refundedAt))
    .limit(limit);
}

export async function notificationFailureQueue(db: Database, organizationId: string, limit = 100) {
  return db
    .select()
    .from(notificationMessages)
    .where(
      and(
        eq(notificationMessages.organizationId, organizationId),
        inArray(notificationMessages.status, ['FAILED', 'SUPPRESSED']),
      ),
    )
    .orderBy(desc(notificationMessages.updatedAt))
    .limit(limit);
}

/** Entitlements granted but never consumed and never revoked — potential orphans. */
export async function orphanedEntitlementQueue(db: Database, organizationId: string, limit = 100) {
  return db
    .select()
    .from(entitlements)
    .where(and(eq(entitlements.organizationId, organizationId), eq(entitlements.status, 'GRANTED')))
    .orderBy(desc(entitlements.createdAt))
    .limit(limit);
}

/** A count summary of every queue, for the console overview. */
export async function exceptionCounts(db: Database, organizationId: string) {
  const [ir, pe, uce, dq, rr, nf, oe] = await Promise.all([
    identityReviewQueue(db, organizationId, 1000),
    provisioningExceptionQueue(db, organizationId, 1000),
    unprocessedCommerceEventQueue(db, organizationId, 1000),
    disputeQueue(db, organizationId, 1000),
    refundReviewQueue(db, organizationId, 1000),
    notificationFailureQueue(db, organizationId, 1000),
    orphanedEntitlementQueue(db, organizationId, 1000),
  ]);
  return {
    identityReview: ir.length,
    provisioningExceptions: pe.length,
    unprocessedCommerceEvents: uce.length,
    disputes: dq.length,
    refunds: rr.length,
    notificationFailures: nf.length,
    orphanedEntitlements: oe.length,
  };
}

/**
 * Reconciliation — a payment must never silently disappear between the provider
 * and Atlas. Counts the provider's payment events against orders, entitlements,
 * and provisioned accounts, and surfaces the dangling rows.
 */
export async function reconciliation(db: Database, organizationId: string) {
  const count = async (where: ReturnType<typeof and>): Promise<number> => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(commercialOrders).where(where);
    return row?.n ?? 0;
  };
  const orgWhere = eq(commercialOrders.organizationId, organizationId);

  const [paymentEvents] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(commerceEvents)
    .where(and(eq(commerceEvents.organizationId, organizationId), eq(commerceEvents.kind, 'PAYMENT_SUCCEEDED')));

  const [processedEvents] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(commerceEvents)
    .where(
      and(
        eq(commerceEvents.organizationId, organizationId),
        eq(commerceEvents.kind, 'PAYMENT_SUCCEEDED'),
        eq(commerceEvents.status, 'PROCESSED'),
      ),
    );

  const [entCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(entitlements)
    .where(eq(entitlements.organizationId, organizationId));

  const provisioned = await count(and(orgWhere, eq(commercialOrders.status, 'PROVISIONED')));
  const completed = await count(and(orgWhere, eq(commercialOrders.status, 'COMPLETED')));
  const blocked = await count(and(orgWhere, eq(commercialOrders.status, 'PROVISION_BLOCKED')));
  const failed = await count(and(orgWhere, eq(commercialOrders.status, 'PROVISION_FAILED')));
  const refunded = await count(and(orgWhere, eq(commercialOrders.status, 'REFUNDED')));

  const [evalAccts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.accountType, 'EVALUATION')));
  const [fundedAccts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.accountType, ['FUNDED_SIM'])));

  const unprocessedEvents = await unprocessedCommerceEventQueue(db, organizationId, 100);
  const provisioningExceptions = await provisioningExceptionQueue(db, organizationId, 100);

  return {
    paymentEventsReceived: paymentEvents?.n ?? 0,
    paymentEventsProcessed: processedEvents?.n ?? 0,
    orders: { provisioned, completed, blocked, failed, refunded },
    entitlements: entCount?.n ?? 0,
    accounts: { evaluation: evalAccts?.n ?? 0, funded: fundedAccts?.n ?? 0 },
    discrepancies: {
      unprocessedCommerceEvents: unprocessedEvents.length,
      provisioningExceptions: provisioningExceptions.length,
      // A payment received but not processed is the "silently disappeared" case.
      unreconciledPayments: (paymentEvents?.n ?? 0) - (processedEvents?.n ?? 0),
    },
    balanced:
      (paymentEvents?.n ?? 0) === (processedEvents?.n ?? 0) &&
      unprocessedEvents.length === 0 &&
      provisioningExceptions.length === 0,
  };
}
