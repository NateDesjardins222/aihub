/**
 * Customer-portal billing service — authoritative purchase → entitlement → account
 * provenance (Customer Golden Path Phase 1, WEB-3).
 *
 * Before this, the Billing page synthesized one fake "order" per account, hard-coded
 * to PAID and showing the account's STARTING BALANCE as the amount — misleading (an
 * account size is not a price). This reads the real `commercial_orders` the customer
 * owns, joined to the product version (for the product name) and to the account the
 * order's entitlement provisioned (via entitlements.consumedByAccountId).
 *
 * It PRESENTS authoritative order state; it invents nothing. `amountMicros` is whatever
 * the order recorded (null for a $0 activation or an admin grant — never fabricated).
 * Ownership is enforced: only the caller's own orders. Read-only.
 */
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  accountProfileVersions, accountProfiles, accounts, commercialOrders, entitlements,
} from '../db/schema.js';

/** Customer-safe money state for a billing row. Operational/provisioning detail is
 *  deliberately NOT leaked here — this answers "what did I buy and did it settle?". */
export type PortalOrderState = 'PAID' | 'PENDING' | 'REFUNDED' | 'CANCELLED';

export interface PortalOrderSummary {
  id: string;
  /** Order creation time (ms since epoch). */
  dateMs: number;
  /** Product name at acquisition, or a safe fallback. */
  item: string;
  productKey: string | null;
  /** Authoritative amount in micro-dollars, or null when the order recorded none. */
  amountMicros: number | null;
  currency: string | null;
  /** How the order arose: PURCHASE | ADMIN_GRANT | PROMO | … (authoritative). */
  source: string;
  state: PortalOrderState;
  /** The account this order's entitlement provisioned, when it has one. */
  accountId: string | null;
  accountPublicId: string | null;
  refundedAtMs: number | null;
}

export interface PortalBillingView {
  orders: PortalOrderSummary[];
  /** Sum of authoritative amounts actually settled (PAID), micro-dollars. Never fabricated. */
  totalSpentMicros: number;
  orderCount: number;
}

/** Map the authoritative commercial-order status to a customer-safe money state. */
function toOrderState(status: string): PortalOrderState {
  switch (status) {
    case 'REFUNDED':
      return 'REFUNDED';
    case 'CANCELLED':
    case 'FAILED':
      return 'CANCELLED';
    case 'COMPLETED':
    case 'PROVISIONED':
    // Money is retained in the blocked/failed-provisioning states (see schema): from the
    // customer's billing view the purchase settled; provisioning status lives elsewhere.
    case 'PROVISION_BLOCKED':
    case 'PROVISION_FAILED':
      return 'PAID';
    default:
      return 'PENDING';
  }
}

/**
 * The customer's own commercial orders, newest first, with product name and the
 * provisioned account where one exists. Pure read; ownership-scoped by userId.
 */
export async function listPortalBilling(db: Database, userId: string): Promise<PortalBillingView> {
  const rows = await db
    .select({
      order: commercialOrders,
      profileName: accountProfiles.name,
      profileKey: accountProfiles.key,
      accountId: accounts.id,
      accountPublicId: accounts.publicId,
    })
    .from(commercialOrders)
    .leftJoin(accountProfileVersions, eq(commercialOrders.productVersionId, accountProfileVersions.id))
    .leftJoin(accountProfiles, eq(accountProfileVersions.profileId, accountProfiles.id))
    .leftJoin(entitlements, eq(entitlements.commercialOrderId, commercialOrders.id))
    .leftJoin(accounts, eq(entitlements.consumedByAccountId, accounts.id))
    .where(eq(commercialOrders.userId, userId))
    .orderBy(desc(commercialOrders.createdAt));

  const orders: PortalOrderSummary[] = [];
  let totalSpentMicros = 0;
  for (const r of rows) {
    const o = r.order;
    const state = toOrderState(o.status);
    if (state === 'PAID' && typeof o.amountMicros === 'number') totalSpentMicros += o.amountMicros;
    orders.push({
      id: o.id,
      dateMs: o.createdAt.getTime(),
      item: r.profileName ?? 'Account',
      productKey: r.profileKey ?? null,
      amountMicros: typeof o.amountMicros === 'number' ? o.amountMicros : null,
      currency: o.currency ?? null,
      source: o.source,
      state,
      accountId: r.accountId ?? null,
      accountPublicId: r.accountPublicId ?? null,
      refundedAtMs: o.refundedAt?.getTime() ?? null,
    });
  }
  return { orders, totalSpentMicros, orderCount: orders.length };
}
