/**
 * Whop payment integration — the trigger, not the domain.
 *
 * Whop takes the money on its own hosted/embedded surface; Atlas never sees a
 * card. When a payment succeeds, Whop sends a signed webhook, and that is the
 * only thing this file is for: proving a webhook really came from Whop, and
 * reading out of it the two facts the lifecycle needs - which Atlas order was
 * paid, and the provider's own receipt id. Fulfilment itself lives in
 * `commerce.ts` (`fulfillOrder`); nothing here touches an account.
 *
 * Everything is optional. With no `WHOP_WEBHOOK_SECRET` configured, the webhook
 * route refuses every request rather than processing an unsigned one, and Atlas
 * has no money path at all. That is deliberate: the payment provider is a
 * trigger bolted onto a lifecycle that is complete without it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/** True only when a webhook secret is configured. No secret, no money path. */
export function whopConfigured(): boolean {
  return typeof env().WHOP_WEBHOOK_SECRET === 'string' && env().WHOP_WEBHOOK_SECRET!.length > 0;
}

/**
 * Verify a Whop webhook signature over the RAW request body.
 *
 * HMAC-SHA256 of the exact bytes Whop sent, compared timing-safe against the
 * signature header. The comparison is on the raw body, never a re-serialised
 * object, because a re-serialise would reorder keys and change the bytes the
 * HMAC was computed over. A `sha256=` prefix (as some providers send) is
 * tolerated. Any malformed input is a failed verification, never a throw: a
 * bad signature is a 401, not a 500.
 */
export function verifyWhopSignature(
  rawBody: string,
  signatureHeader: string | string[] | undefined,
  secret: string,
): boolean {
  const presented = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!presented || !secret) return false;
  // Some providers prefix the hex digest (e.g. "sha256=<hex>"); take the last
  // token after any "=" so both forms verify.
  const hex = presented.includes('=') ? presented.slice(presented.lastIndexOf('=') + 1) : presented;
  const cleaned = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleaned)) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(cleaned, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface WhopEvent {
  /** The provider event name, e.g. "payment.succeeded". */
  readonly type: string;
  /** True when this event means a payment has succeeded and should fulfil. */
  readonly isPaymentSuccess: boolean;
  /** The Atlas order id we passed to Whop as checkout metadata. */
  readonly atlasOrderId: string | null;
  /** Whop's own receipt/payment id, stored as the order's external reference. */
  readonly receiptId: string | null;
}

/**
 * The event names Whop uses for a completed payment. Kept as a set so a rename
 * or an additional success event is a one-line change, not a logic edit.
 */
const PAYMENT_SUCCESS_TYPES = new Set([
  'payment.succeeded',
  'payment_succeeded',
  'membership.went_valid',
  'membership_went_valid',
]);

/**
 * Read the two facts fulfilment needs out of a Whop webhook payload, defensively.
 *
 * Whop nests the resource under `data` and echoes checkout `metadata` back, so
 * the Atlas order id we set at checkout arrives at `data.metadata.atlasOrderId`.
 * Field names are read tolerantly (snake and camel case, a couple of nestings)
 * because a provider's exact shape is not a thing to hard-code a single path
 * to. Returns nulls rather than throwing on anything unexpected.
 */
export function parseWhopEvent(payload: unknown): WhopEvent {
  const root = isRecord(payload) ? payload : {};
  const type = str(root['type']) ?? str(root['action']) ?? str(root['event']) ?? '';
  const data = isRecord(root['data']) ? root['data'] : root;
  const metadata = isRecord(data['metadata'])
    ? data['metadata']
    : isRecord(root['metadata'])
      ? root['metadata']
      : {};

  const atlasOrderId =
    str(metadata['atlasOrderId']) ??
    str(metadata['atlas_order_id']) ??
    str(metadata['orderId']) ??
    str(metadata['order_id']) ??
    null;

  const receiptId = str(data['id']) ?? str(data['receipt_id']) ?? str(root['id']) ?? null;

  return {
    type,
    isPaymentSuccess: PAYMENT_SUCCESS_TYPES.has(type),
    atlasOrderId,
    receiptId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
