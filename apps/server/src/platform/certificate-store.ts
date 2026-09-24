/**
 * Owner Certificate Store — operational visibility + manual fulfillment (M6-I).
 *
 * Read-mostly owner surface over physical certificate orders and the manual 100K
 * plaque queue. There is NO owner backdoor that issues an *earned* certificate;
 * the only mutations here are operational (mark shipped/delivered, advance the
 * manual plaque, record tracking, flag refund/replacement), each audited.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { certificates, customerIdentities, physicalCertificateOrders, physicalRewardFulfillment, users } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { type Actor, SYSTEM_ACTOR } from './actor.js';

export class CertificateStoreError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'INVALID_TRANSITION', message: string) {
    super(message);
    this.name = 'CertificateStoreError';
  }
}

const PAID_STATES = ['PAID', 'PREFLIGHT', 'SUBMITTED', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED', 'REPLACEMENT_PENDING', 'REPLACED'];

/** Store-wide summary: revenue, fulfillment cost, contribution, AOV, statuses. */
export async function certificateStoreSummary(db: Database, organizationId: string) {
  const rows = await db.select().from(physicalCertificateOrders).where(eq(physicalCertificateOrders.organizationId, organizationId));
  const byStatus: Record<string, number> = {};
  let revenueMicros = 0;
  let fulfillmentCostMicros = 0;
  let paidCount = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (PAID_STATES.includes(r.status)) {
      revenueMicros += r.retailAmountMicros;
      fulfillmentCostMicros += (r.providerQuoteAmountMicros ?? 0) + (r.shippingAmountMicros ?? 0);
      paidCount += 1;
    }
  }
  return {
    totalOrders: rows.length,
    paidOrders: paidCount,
    revenueMicros,
    fulfillmentCostMicros,
    estimatedContributionMicros: revenueMicros - fulfillmentCostMicros,
    averageOrderValueMicros: paidCount > 0 ? Math.round(revenueMicros / paidCount) : 0,
    needsAttention: (byStatus['FULFILLMENT_FAILED'] ?? 0) + (byStatus['REFUND_PENDING'] ?? 0) + (byStatus['REPLACEMENT_PENDING'] ?? 0),
    byStatus,
  };
}

/** Owner order list with customer + certificate context and a safe failure reason. */
export async function listStoreOrders(db: Database, organizationId: string, opts: { status?: string; limit?: number } = {}) {
  const conds = [eq(physicalCertificateOrders.organizationId, organizationId)];
  if (opts.status) conds.push(eq(physicalCertificateOrders.status, opts.status));
  const rows = await db
    .select({
      order: physicalCertificateOrders,
      email: users.email,
      certType: certificates.type,
      certPublicId: certificates.certificatePublicId,
    })
    .from(physicalCertificateOrders)
    .innerJoin(customerIdentities, eq(physicalCertificateOrders.customerIdentityId, customerIdentities.id))
    .innerJoin(users, eq(customerIdentities.userId, users.id))
    .leftJoin(certificates, eq(physicalCertificateOrders.certificateId, certificates.id))
    .where(and(...conds))
    .orderBy(desc(physicalCertificateOrders.createdAt))
    .limit(Math.min(opts.limit ?? 100, 200));
  return rows.map((r) => ({
    id: r.order.id,
    customerEmail: r.email,
    certificateType: r.certType,
    certificatePublicId: r.certPublicId,
    sku: r.order.sku,
    status: r.order.status,
    retailAmountMicros: r.order.retailAmountMicros,
    fulfillmentCostMicros: (r.order.providerQuoteAmountMicros ?? 0) + (r.order.shippingAmountMicros ?? 0),
    estimatedContributionMicros: r.order.estimatedContributionMicros,
    fulfillmentProvider: r.order.fulfillmentProvider,
    providerOrderId: r.order.providerOrderId,
    trackingCarrier: r.order.trackingCarrier,
    trackingNumber: r.order.trackingNumber,
    failureCode: r.order.failureCode,
    failureDetailSafe: r.order.failureDetailSafe,
    createdAt: r.order.createdAt.getTime(),
    shippedAt: r.order.shippedAt?.getTime() ?? null,
    deliveredAt: r.order.deliveredAt?.getTime() ?? null,
  }));
}

const ORDER_ACTIONS: Record<string, { to: string; from: string[] }> = {
  ship: { to: 'SHIPPED', from: ['SUBMITTED', 'IN_PRODUCTION'] },
  deliver: { to: 'DELIVERED', from: ['SHIPPED'] },
  refund: { to: 'REFUND_PENDING', from: ['PAID', 'SUBMITTED', 'IN_PRODUCTION', 'SHIPPED', 'FULFILLMENT_FAILED'] },
  replace: { to: 'REPLACEMENT_PENDING', from: ['SHIPPED', 'DELIVERED', 'FULFILLMENT_FAILED'] },
  cancel: { to: 'CANCELLED', from: ['PENDING_PAYMENT', 'PAID', 'FULFILLMENT_FAILED'] },
};

/** An audited operational transition on a physical order. */
export async function updateStoreOrder(
  db: Database,
  organizationId: string,
  orderId: string,
  action: keyof typeof ORDER_ACTIONS,
  tracking: { carrier?: string | null; trackingNumber?: string | null; trackingUrl?: string | null } | undefined,
  actor: Actor = SYSTEM_ACTOR,
) {
  const def = ORDER_ACTIONS[action];
  if (!def) throw new CertificateStoreError('INVALID_TRANSITION', 'Unknown action.');
  const [row] = await db.select().from(physicalCertificateOrders).where(and(eq(physicalCertificateOrders.id, orderId), eq(physicalCertificateOrders.organizationId, organizationId)));
  if (!row) throw new CertificateStoreError('NOT_FOUND', 'No such order.');
  if (!def.from.includes(row.status)) throw new CertificateStoreError('INVALID_TRANSITION', `A ${row.status} order cannot ${action}.`);
  const patch: Record<string, unknown> = { status: def.to, updatedAt: new Date() };
  if (action === 'ship') { patch['shippedAt'] = new Date(); patch['trackingCarrier'] = tracking?.carrier ?? row.trackingCarrier; patch['trackingNumber'] = tracking?.trackingNumber ?? row.trackingNumber; patch['trackingUrl'] = tracking?.trackingUrl ?? row.trackingUrl; }
  if (action === 'deliver') patch['deliveredAt'] = new Date();
  const [u] = await db.update(physicalCertificateOrders).set(patch).where(eq(physicalCertificateOrders.id, orderId)).returning();
  await recordAudit(db, { organizationId, actor, subjectType: 'COMMERCE', subjectId: orderId, action: `physical_order.${action}`, prevState: { status: row.status }, newState: { status: def.to } });
  return u!;
}

// ---- 100K plaque manual fulfillment ---------------------------------------

const PLAQUE_ACTIONS: Record<string, { to: string; from: string[] }> = {
  verify: { to: 'VERIFIED', from: ['PENDING_REVIEW'] },
  order: { to: 'ORDERED', from: ['VERIFIED'] },
  ship: { to: 'SHIPPED', from: ['ORDERED'] },
  deliver: { to: 'DELIVERED', from: ['SHIPPED'] },
  hold: { to: 'HOLD', from: ['PENDING_REVIEW', 'VERIFIED', 'ORDERED'] },
  cancel: { to: 'CANCELLED', from: ['PENDING_REVIEW', 'VERIFIED', 'ORDERED', 'HOLD'] },
};

export async function listPlaqueFulfillments(db: Database, organizationId: string) {
  const rows = await db
    .select({ f: physicalRewardFulfillment, email: users.email })
    .from(physicalRewardFulfillment)
    .innerJoin(customerIdentities, eq(physicalRewardFulfillment.customerIdentityId, customerIdentities.id))
    .innerJoin(users, eq(customerIdentities.userId, users.id))
    .where(eq(physicalRewardFulfillment.organizationId, organizationId))
    .orderBy(desc(physicalRewardFulfillment.createdAt));
  return rows.map((r) => ({
    id: r.f.id,
    customerEmail: r.email,
    type: r.f.type,
    status: r.f.status,
    shippingAddressStatus: r.f.shippingAddressStatus,
    trackingCarrier: r.f.trackingCarrier,
    trackingNumber: r.f.trackingNumber,
    fulfillmentNotes: r.f.fulfillmentNotes,
    createdAt: r.f.createdAt.getTime(),
    shippedAt: r.f.shippedAt?.getTime() ?? null,
    deliveredAt: r.f.deliveredAt?.getTime() ?? null,
  }));
}

/** An audited manual transition on a 100K plaque. NEVER calls any provider. */
export async function updatePlaqueFulfillment(
  db: Database,
  organizationId: string,
  id: string,
  action: keyof typeof PLAQUE_ACTIONS,
  extra: { notes?: string | null; trackingCarrier?: string | null; trackingNumber?: string | null } | undefined,
  actor: Actor = SYSTEM_ACTOR,
) {
  const def = PLAQUE_ACTIONS[action];
  if (!def) throw new CertificateStoreError('INVALID_TRANSITION', 'Unknown action.');
  const [row] = await db.select().from(physicalRewardFulfillment).where(and(eq(physicalRewardFulfillment.id, id), eq(physicalRewardFulfillment.organizationId, organizationId)));
  if (!row) throw new CertificateStoreError('NOT_FOUND', 'No such plaque fulfillment.');
  if (!def.from.includes(row.status)) throw new CertificateStoreError('INVALID_TRANSITION', `A ${row.status} plaque cannot ${action}.`);
  const patch: Record<string, unknown> = { status: def.to, updatedAt: new Date() };
  if (extra?.notes != null) patch['fulfillmentNotes'] = extra.notes.slice(0, 2000);
  if (action === 'ship') { patch['shippedAt'] = new Date(); patch['trackingCarrier'] = extra?.trackingCarrier ?? row.trackingCarrier; patch['trackingNumber'] = extra?.trackingNumber ?? row.trackingNumber; }
  if (action === 'deliver') patch['deliveredAt'] = new Date();
  const [u] = await db.update(physicalRewardFulfillment).set(patch).where(eq(physicalRewardFulfillment.id, id)).returning();
  await recordAudit(db, { organizationId, actor, subjectType: 'ACCOUNT', subjectId: id, action: `plaque.${action}`, prevState: { status: row.status }, newState: { status: def.to } });
  return u!;
}

void inArray;
