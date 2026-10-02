/**
 * Whop payment integration — the trigger, not the domain.
 *
 * Whop takes the money on its own hosted/embedded surface; Atlas never sees a
 * card. When a payment succeeds, Whop sends a webhook signed with the Standard
 * Webhooks scheme (https://www.standardwebhooks.com), and this file's job is to
 * prove a webhook really came from Whop and read out the two facts fulfilment
 * needs: which Atlas order was paid, and the provider's receipt id. Fulfilment
 * itself lives in `commerce.ts`; nothing here touches an account.
 *
 * Everything is optional. With no `WHOP_WEBHOOK_SECRET`, the webhook route
 * refuses every request rather than processing an unsigned one, and Atlas has
 * no money path at all. This milestone is sandbox-only: no production Whop, no
 * real charge.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/** True only when a webhook secret is configured. No secret, no money path. */
export function whopConfigured(): boolean {
  const secret = env().WHOP_WEBHOOK_SECRET;
  return typeof secret === 'string' && secret.length > 0;
}

/** Standard Webhooks recommends rejecting timestamps outside a few minutes. */
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' && first.length > 0 ? first : null;
}

/**
 * Derive the HMAC key from a Standard Webhooks secret.
 *
 * The secret is base64 with a scheme prefix (`ws_` for Whop, `whsec_` in the
 * base spec). The key is the base64-decoded bytes AFTER the prefix - the prefix
 * is not part of the key, and the remainder is decoded, not used as text. This
 * is what the official SDK does under `unwrapWebhook`; reproduced here so
 * verification has no SDK dependency and is fully testable offline.
 */
function deriveKey(secret: string): Buffer {
  const body = secret.startsWith('ws_')
    ? secret.slice(3)
    : secret.startsWith('whsec_')
      ? secret.slice(6)
      : secret;
  return Buffer.from(body, 'base64');
}

export type WebhookVerification = { ok: true } | { ok: false; reason: string };

/**
 * Verify a Whop (Standard Webhooks) signature over the RAW request body.
 *
 * Signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`, HMAC-SHA256
 * with the derived key, base64-encoded. The `webhook-signature` header is a
 * space-delimited list of `v1,<base64>` signatures (a secret can be rotated, so
 * more than one may be present); the body verifies if ANY listed v1 signature
 * matches, compared in constant time. The timestamp must be within tolerance,
 * so a captured webhook cannot be replayed forever. Any malformed input is a
 * failed verification, never a throw: a bad signature is a 401, not a 500.
 */
export function verifyStandardWebhook(
  rawBody: string,
  headers: HeaderBag,
  secret: string,
  opts: { toleranceSeconds?: number; nowMs?: number } = {},
): WebhookVerification {
  if (!secret) return { ok: false, reason: 'no secret configured' };
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signature = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing signature headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - ts) > tolerance) return { ok: false, reason: 'timestamp outside tolerance' };

  let key: Buffer;
  try {
    key = deriveKey(secret);
  } catch {
    return { ok: false, reason: 'bad secret' };
  }
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`, 'utf8')
    .digest(); // raw bytes, compared byte-for-byte

  // The header lists one or more space-separated "version,signature" pairs.
  for (const token of signature.split(' ')) {
    const comma = token.indexOf(',');
    if (comma < 0) continue;
    const version = token.slice(0, comma);
    if (version !== 'v1') continue; // only the symmetric HMAC scheme
    const provided = safeBase64(token.slice(comma + 1));
    if (provided && provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'no matching signature' };
}

function safeBase64(value: string): Buffer | null {
  try {
    return Buffer.from(value.trim(), 'base64');
  } catch {
    return null;
  }
}

export interface WhopEvent {
  /** The provider event name, e.g. "payment.succeeded". */
  readonly type: string;
  /** True when this event means a payment has succeeded and should fulfil. */
  readonly isPaymentSuccess: boolean;
  /** The Atlas order id we attached to the checkout session's metadata. */
  readonly atlasOrderId: string | null;
  /** Whop's own receipt/payment id, stored as the order's external reference. */
  readonly receiptId: string | null;
  /**
   * The stable Whop PLAN id the payment is for (verified v1 Payment object:
   * `data.plan.id`, e.g. `plan_XXXXXXXX`). This is the product-mapping key —
   * cross-checked against the order's expected plan so a payment for the wrong
   * product cannot provision the canary. `data.product.id` is the coarser
   * fallback. Null when the payload carries neither.
   */
  readonly productId: string | null;
  /**
   * The Whop CUSTOMER id (verified v1 Payment object: `data.user.id`, e.g.
   * `user_XXXXXXXX`; `data.member.id` as fallback). Stored for provenance and
   * owner correlation; identity binding is via the Atlas order, never this alone.
   */
  readonly customerId: string | null;
  /**
   * The confirmed amount the buyer was charged, in DECIMAL dollars exactly as
   * Whop reports it (the v1 Payment object expresses money as a decimal number,
   * e.g. `6.9` for $6.90 — NOT cents/micros). We read `subtotal` first (the
   * plan's own price before tax, which is what our list price equals), then
   * `total`, then `final_amount`. The caller converts to integer micro-dollars.
   * Null when the payload asserts no amount.
   */
  readonly amountDecimal: number | null;
  /** The ISO-4217 currency of the charge (verified v1: `data.currency`, e.g. "usd"). */
  readonly currency: string | null;
}

/** Whop's event name for a completed payment. */
const PAYMENT_SUCCESS_TYPES = new Set(['payment.succeeded']);

/**
 * Read the facts fulfilment needs out of a Whop webhook payload, defensively.
 *
 * Whop nests the resource under `data` and echoes the checkout configuration's
 * `metadata` back, so the Atlas order id we set when creating the checkout
 * arrives at `data.metadata.atlasOrderId`. The verified v1 Payment object also
 * carries `plan.id` / `product.id` (the mapping key), `user.id` (the customer),
 * `subtotal`/`total` (decimal-dollar amount) and `currency`. Field names are
 * read tolerantly (nested object `.id` and flat `_id`, snake and camel case).
 * Returns nulls rather than throwing on anything unexpected — a malformed
 * payload is a safe no-op, never a crash.
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

  const receiptId =
    str(data['id']) ?? str(data['receipt_id']) ?? str(data['payment_id']) ?? str(root['id']) ?? null;

  // The plan is the authoritative product-mapping key; the product id is coarser.
  const productId =
    nestedId(data['plan']) ??
    str(data['plan_id']) ??
    nestedId(data['product']) ??
    str(data['product_id']) ??
    null;

  const customerId =
    nestedId(data['user']) ??
    str(data['user_id']) ??
    nestedId(data['member']) ??
    str(data['member_id']) ??
    str(data['customer_id']) ??
    null;

  // Money as Whop reports it: a decimal number of dollars. Prefer the plan's own
  // pre-tax price (subtotal), which is what our list price equals.
  const amountDecimal = dec(data['subtotal']) ?? dec(data['total']) ?? dec(data['final_amount']);
  const currency = str(data['currency']);

  return {
    type,
    isPaymentSuccess: PAYMENT_SUCCESS_TYPES.has(type),
    atlasOrderId,
    receiptId,
    productId,
    customerId,
    amountDecimal,
    currency,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The `id` of a nested resource object (e.g. `data.plan.id`), or null. */
function nestedId(value: unknown): string | null {
  return isRecord(value) ? str(value['id']) : null;
}

/** A finite decimal number, or null. Strings are parsed; non-finite is null. */
function dec(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}
