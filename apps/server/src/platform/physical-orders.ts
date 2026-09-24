/**
 * Physical framed certificate orders (Milestone 6).
 *
 * Only an EARNED, RENDERED certificate can be ordered. Payment is
 * server-authoritative (a browser success never fulfills). After payment a strict
 * PREFLIGHT runs before any manufacturing order is created; any failure moves the
 * order to a safe exception state and submits nothing. The domain talks to the
 * FulfillmentProvider abstraction, never Prodigi directly.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { certificates, customerIdentities, physicalCertificateOrders } from '../db/schema.js';
import { isPhysicalEligibleType } from './certificates.js';
import { objectStore } from './object-store.js';
import {
  fulfillmentProvider,
  KNOWN_SKUS,
  type FulfillmentAddress,
} from './fulfillment-provider.js';

export const PHYSICAL_SKU = 'GLOBAL-CFP-11X14';
export const PHYSICAL_RETAIL_MICROS = 99_990_000; // $99.99

export class PhysicalOrderError extends Error {
  constructor(
    readonly code:
      | 'CERTIFICATE_NOT_FOUND'
      | 'NOT_ELIGIBLE'
      | 'INVALID_ADDRESS'
      | 'ORDER_NOT_FOUND'
      | 'INVALID_STATE'
      | 'MERCH_DISABLED',
    message: string,
  ) {
    super(message);
    this.name = 'PhysicalOrderError';
  }
}

export type PhysicalOrderRow = typeof physicalCertificateOrders.$inferSelect;

function validateAddress(a: unknown): FulfillmentAddress {
  const o = (a ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max = 120): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const name = str(o['name'], 80);
  const line1 = str(o['line1']);
  const city = str(o['city'], 80);
  const postalCode = str(o['postalCode'], 20);
  const country = str(o['country'], 2).toUpperCase();
  if (!name || !line1 || !city || !postalCode || country.length !== 2) {
    throw new PhysicalOrderError('INVALID_ADDRESS', 'A complete shipping address (name, line1, city, postal code, 2-letter country) is required.');
  }
  return {
    name, line1, city, postalCode, country,
    line2: str(o['line2']) || null,
    region: str(o['region'], 80) || null,
  };
}

async function identityFor(db: Database, userId: string): Promise<string | null> {
  const [row] = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(eq(customerIdentities.userId, userId));
  return row?.id ?? null;
}

/** The certificate must belong to the caller and be an earned, rendered, framable type. */
async function eligibleCertificate(db: Database, identityId: string, certificateId: string) {
  const [cert] = await db
    .select()
    .from(certificates)
    .where(and(eq(certificates.id, certificateId), eq(certificates.customerIdentityId, identityId)));
  if (!cert) throw new PhysicalOrderError('CERTIFICATE_NOT_FOUND', 'No such certificate.');
  if (cert.status !== 'ISSUED' || cert.renderStatus !== 'RENDERED' || !cert.imageStorageKey || !isPhysicalEligibleType(cert.type)) {
    throw new PhysicalOrderError('NOT_ELIGIBLE', 'This certificate cannot be ordered as a framed copy.');
  }
  return cert;
}

export interface CreatePhysicalOrderInput {
  readonly userId: string;
  readonly certificateId: string;
  readonly address: unknown;
  readonly idempotencyKey?: string | null;
}

/**
 * Create a PENDING_PAYMENT order for a framed copy of an owned certificate. Does
 * not move money or submit fulfillment — that happens only after an authoritative
 * payment event.
 */
export async function createPhysicalCertificateOrder(db: Database, input: CreatePhysicalOrderInput): Promise<PhysicalOrderRow> {
  const identityId = await identityFor(db, input.userId);
  if (!identityId) throw new PhysicalOrderError('CERTIFICATE_NOT_FOUND', 'No such certificate.');
  const cert = await eligibleCertificate(db, identityId, input.certificateId);
  const address = validateAddress(input.address);

  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(physicalCertificateOrders)
      .where(and(eq(physicalCertificateOrders.customerIdentityId, identityId), eq(physicalCertificateOrders.idempotencyKey, input.idempotencyKey)));
    if (existing) return existing;
  }

  const [row] = await db
    .insert(physicalCertificateOrders)
    .values({
      organizationId: cert.organizationId,
      customerIdentityId: identityId,
      certificateId: cert.id,
      sku: PHYSICAL_SKU,
      quantity: 1,
      retailAmountMicros: PHYSICAL_RETAIL_MICROS,
      currency: 'USD',
      status: 'PENDING_PAYMENT',
      fulfillmentProvider: fulfillmentProvider().name,
      shippingAddressSnapshot: address as unknown as Record<string, unknown>,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .returning();
  return row!;
}

/**
 * The server-authoritative payment confirmation + preflight + submission. Called
 * from a signature-verified webhook (or the non-prod simulate route). Idempotent:
 * an order already past PAID is returned unchanged. Preflight failures never
 * submit a manufacturing order.
 */
export async function confirmPhysicalCertificatePayment(
  db: Database,
  orderId: string,
  opts: { receiptId?: string | null } = {},
): Promise<PhysicalOrderRow> {
  const [order] = await db.select().from(physicalCertificateOrders).where(eq(physicalCertificateOrders.id, orderId));
  if (!order) throw new PhysicalOrderError('ORDER_NOT_FOUND', 'No such order.');
  if (order.status !== 'PENDING_PAYMENT') return order; // idempotent: already paid/submitted/failed

  void opts.receiptId;
  await db.update(physicalCertificateOrders).set({ status: 'PAID', paidAt: new Date(), updatedAt: new Date() }).where(eq(physicalCertificateOrders.id, orderId));

  // ---- PREFLIGHT ----------------------------------------------------------
  const fail = async (code: string, detail: string): Promise<PhysicalOrderRow> => {
    const [u] = await db
      .update(physicalCertificateOrders)
      .set({ status: 'FULFILLMENT_FAILED', failureCode: code, failureDetailSafe: detail.slice(0, 300), updatedAt: new Date() })
      .where(eq(physicalCertificateOrders.id, orderId))
      .returning();
    return u!;
  };

  const [cert] = await db.select().from(certificates).where(eq(certificates.id, order.certificateId));
  if (!cert) return fail('CERT_MISSING', 'Certificate no longer exists.');
  if (cert.customerIdentityId !== order.customerIdentityId) return fail('OWNER_MISMATCH', 'Certificate owner mismatch.');
  if (cert.status !== 'ISSUED' || cert.renderStatus !== 'RENDERED' || !cert.imageStorageKey || !isPhysicalEligibleType(cert.type)) {
    return fail('NOT_ELIGIBLE', 'Certificate is not eligible for physical fulfillment.');
  }
  if (!cert.renderHash) return fail('ARTIFACT_HASH_MISSING', 'Print artifact hash is missing.');
  const printKey = cert.printStorageKey ?? cert.imageStorageKey;
  const artifactExists = await objectStore().exists(printKey).catch(() => false);
  if (!artifactExists) return fail('ARTIFACT_MISSING', 'Print artifact is not available.');

  const provider = fulfillmentProvider();
  if (!KNOWN_SKUS.has(order.sku) || !(await provider.validateProduct(order.sku).catch(() => false))) {
    return fail('SKU_UNAVAILABLE', 'The product SKU is not available.');
  }
  let address: FulfillmentAddress;
  try {
    address = validateAddress(order.shippingAddressSnapshot);
  } catch {
    return fail('INVALID_ADDRESS', 'The shipping address is invalid.');
  }

  let quote;
  try {
    quote = await provider.quote({ sku: order.sku, quantity: order.quantity, address });
  } catch (e) {
    return fail('QUOTE_FAILED', e instanceof Error ? e.message : 'Quote failed.');
  }
  // Fulfillment-cost safety rule: never submit if the delivered cost would exceed
  // the retail we charged (a mispriced/quote anomaly is an exception, not a loss).
  if (quote.totalMicros >= order.retailAmountMicros) {
    return fail('COST_EXCEEDS_RETAIL', 'Fulfillment cost exceeds retail; held for review.');
  }

  // ---- SUBMIT (idempotent on our order id) --------------------------------
  try {
    const providerOrder = await provider.createOrder({
      idempotencyKey: order.id,
      sku: order.sku,
      quantity: order.quantity,
      address,
      assetRef: printKey,
    });
    const [u] = await db
      .update(physicalCertificateOrders)
      .set({
        status: 'SUBMITTED',
        submittedAt: new Date(),
        providerOrderId: providerOrder.providerOrderId,
        providerQuoteAmountMicros: quote.itemCostMicros,
        shippingAmountMicros: quote.shippingMicros,
        estimatedContributionMicros: order.retailAmountMicros - quote.totalMicros,
        failureCode: null,
        failureDetailSafe: null,
        updatedAt: new Date(),
      })
      .where(eq(physicalCertificateOrders.id, orderId))
      .returning();
    return u!;
  } catch (e) {
    return fail('SUBMIT_FAILED', e instanceof Error ? e.message : 'Provider order failed.');
  }
}

/** Provider tracking update (from a provider webhook or a poll). */
export async function markPhysicalShipped(
  db: Database,
  orderId: string,
  tracking: { carrier?: string | null; trackingNumber?: string | null; trackingUrl?: string | null },
): Promise<PhysicalOrderRow | null> {
  const [u] = await db
    .update(physicalCertificateOrders)
    .set({
      status: 'SHIPPED', shippedAt: new Date(),
      trackingCarrier: tracking.carrier ?? null, trackingNumber: tracking.trackingNumber ?? null, trackingUrl: tracking.trackingUrl ?? null,
      updatedAt: new Date(),
    })
    .where(eq(physicalCertificateOrders.id, orderId))
    .returning();
  return u ?? null;
}

export async function markPhysicalDelivered(db: Database, orderId: string): Promise<PhysicalOrderRow | null> {
  const [u] = await db
    .update(physicalCertificateOrders)
    .set({ status: 'DELIVERED', deliveredAt: new Date(), updatedAt: new Date() })
    .where(eq(physicalCertificateOrders.id, orderId))
    .returning();
  return u ?? null;
}

/** Present a physical order to its owner (safe fields; no provider internals leaked). */
function present(row: PhysicalOrderRow) {
  return {
    id: row.id,
    certificateId: row.certificateId,
    sku: row.sku,
    retailAmountMicros: row.retailAmountMicros,
    currency: row.currency,
    status: row.status,
    trackingCarrier: row.trackingCarrier,
    trackingNumber: row.trackingNumber,
    trackingUrl: row.trackingUrl,
    createdAt: row.createdAt.getTime(),
    paidAt: row.paidAt?.getTime() ?? null,
    submittedAt: row.submittedAt?.getTime() ?? null,
    shippedAt: row.shippedAt?.getTime() ?? null,
    deliveredAt: row.deliveredAt?.getTime() ?? null,
  };
}

export async function listPhysicalOrdersForUser(db: Database, userId: string) {
  const identityId = await identityFor(db, userId);
  if (!identityId) return [];
  const rows = await db
    .select()
    .from(physicalCertificateOrders)
    .where(eq(physicalCertificateOrders.customerIdentityId, identityId))
    .orderBy(desc(physicalCertificateOrders.createdAt));
  return rows.map(present);
}

export async function getPhysicalOrderForUser(db: Database, userId: string, orderId: string) {
  const identityId = await identityFor(db, userId);
  if (!identityId) return null;
  const [row] = await db
    .select()
    .from(physicalCertificateOrders)
    .where(and(eq(physicalCertificateOrders.id, orderId), eq(physicalCertificateOrders.customerIdentityId, identityId)));
  return row ? present(row) : null;
}
