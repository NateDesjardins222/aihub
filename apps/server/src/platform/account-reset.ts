/**
 * Account reset — re-purchase a failed evaluation at its original price to start
 * a fresh trading account, through the existing commerce path
 * (docs/account-lifecycle-ux-v1.md §3).
 *
 * A reset is NOT a discount, a balance edit, or a history rewrite: it is a normal
 * purchase (source RESET) of the failed account's own immutable product version
 * at that version's original price. The failed account is never erased — it stays
 * terminal in Account History, and the new account records `resetOfAccountId`
 * back to it (set during fulfillment). Idempotent by an order key derived from the
 * failed account, and subject to the five-active-account invariant like any
 * purchase (the failed account is terminal and has already freed its slot).
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { resolveProfileVersion } from './profiles.js';
import { createPendingOrder, resetOfReference } from './commerce.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';

export class ResetError extends Error {
  constructor(
    readonly code: 'ACCOUNT_NOT_FOUND' | 'NOT_RESETTABLE' | 'NO_PRODUCT' | 'NO_PRICE' | 'ORDER_NOT_PENDING',
    message: string,
  ) {
    super(message);
    this.name = 'ResetError';
  }
}

/** The account states a reset is offered for: a breached/failed evaluation. */
function isResettable(accountType: string, status: string): boolean {
  return accountType === 'EVALUATION' && status === 'FAILED';
}

export interface ResetQuote {
  failedAccountId: string;
  productKey: string;
  productName: string;
  productVersionId: string;
  priceMicros: number;
}

/**
 * The reset price and terms for a failed account: the exact original purchase
 * price of that account's immutable product version. No discount. Owner-scoped
 * by the caller passing the trader's userId.
 */
export async function resetQuote(
  db: Database,
  userId: string,
  failedAccountId: string,
): Promise<ResetQuote> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, failedAccountId));
  if (!account || account.userId !== userId) {
    throw new ResetError('ACCOUNT_NOT_FOUND', 'No such account.');
  }
  if (!isResettable(account.accountType, account.status)) {
    throw new ResetError('NOT_RESETTABLE', 'Only a failed evaluation can be reset.');
  }
  if (!account.profileVersionId) {
    throw new ResetError('NO_PRODUCT', 'This account has no product version to reset from.');
  }
  const product = await resolveProfileVersion(db, account.profileVersionId);
  if (!product) throw new ResetError('NO_PRODUCT', 'The original product version no longer exists.');
  const priceMicros = product.config.display.priceMicros;
  if (priceMicros == null || priceMicros <= 0) {
    throw new ResetError('NO_PRICE', 'The original product has no purchase price to charge for a reset.');
  }
  return {
    failedAccountId,
    productKey: product.profileKey,
    productName: product.profileName,
    productVersionId: product.versionId,
    priceMicros,
  };
}

/**
 * Create the PENDING reset order (source RESET), pinned to the original immutable
 * product version and price, carrying the failed-account linkage. The trader then
 * pays it through the same checkout the first purchase used; a verified
 * server-side payment event completes and provisions it (setting
 * `resetOfAccountId`). Idempotent: `reset:<failedAccountId>` yields one order.
 */
export async function createResetOrder(
  db: Database,
  input: { organizationId: string; userId: string; failedAccountId: string; actor?: Actor },
): Promise<{ orderId: string; priceMicros: number; productVersionId: string }> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const quote = await resetQuote(db, input.userId, input.failedAccountId);
  const order = await createPendingOrder(db, {
    organizationId: input.organizationId,
    userId: input.userId,
    productVersionId: quote.productVersionId,
    source: 'RESET',
    amountMicros: quote.priceMicros,
    currency: 'USD',
    externalReference: resetOfReference(input.failedAccountId),
    idempotencyKey: `reset:${input.failedAccountId}`,
    actor,
  });
  // A concurrent completion could have already advanced the order; the portal
  // still surfaces its current state via the order-status route.
  if (order.status !== 'PENDING' && order.status !== 'COMPLETED') {
    // Not fatal — the order exists; just report it.
    if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
      throw new ResetError('ORDER_NOT_PENDING', `The reset order is ${order.status}.`);
    }
  }
  return { orderId: order.id, priceMicros: quote.priceMicros, productVersionId: quote.productVersionId };
}
