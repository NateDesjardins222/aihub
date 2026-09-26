/**
 * The commerce provider boundary — so the domain never spreads Whop assumptions.
 *
 * The funnel speaks to `CommerceProvider`; the abstraction has a deterministic
 * MockCommerceProvider (the working default) and a WhopCommerceProvider that
 * wraps the existing `whop.ts` verification/parse and `whop-client.ts` checkout,
 * reporting itself unconfigured without a webhook secret. Passing the mock flow
 * is NOT evidence of a real payment integration.
 *
 * Both providers verify an inbound event with the Standard Webhooks scheme
 * (signature + timestamp tolerance) and normalise it into the provider-neutral
 * `NormalizedCommerceEvent`. The mock uses a fixed dev secret so the browser
 * harness and tests can post a SERVER-SIDE event that is genuinely verified —
 * which is exactly why a browser success screen (posting nothing signed) can
 * never provision.
 */
import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';
import { commerceMode } from '../config/provider-safety.js';
import {
  parseWhopEvent,
  verifyStandardWebhook,
  whopConfigured,
  type WebhookVerification,
} from './whop.js';
import { whopClientFromEnv, WhopApiError } from './whop-client.js';

export type CommerceEventKind =
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_FAILED'
  | 'REFUND'
  | 'DISPUTE_OPENED'
  | 'DISPUTE_CLOSED'
  | 'UNKNOWN';

type HeaderBag = Record<string, string | string[] | undefined>;

export interface RawCommerceEvent {
  readonly rawBody: string;
  readonly headers: HeaderBag;
}

export type CommerceEventVerification = WebhookVerification;

export interface NormalizedCommerceEvent {
  readonly providerEventId: string | null;
  readonly kind: CommerceEventKind;
  readonly atlasOrderId: string | null;
  readonly providerCustomerId: string | null;
  readonly receiptId: string | null;
  readonly amountMicros: number | null;
  readonly currency: string | null;
  readonly occurredAt: Date | null;
}

export interface CreateCheckoutInput {
  readonly orderId: string;
  readonly planId: string | null;
  readonly redirectUrl?: string | null;
}

export interface CheckoutConfig {
  readonly provider: 'MOCK' | 'WHOP';
  readonly configured: boolean;
  readonly mock: boolean;
  readonly orderId: string;
  readonly planId: string | null;
  readonly sessionId?: string | null;
  readonly purchaseUrl?: string | null;
}

export interface CommerceProvider {
  readonly name: 'MOCK' | 'WHOP';
  isConfigured(): boolean;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutConfig>;
  verifyEvent(raw: RawCommerceEvent): CommerceEventVerification;
  normalizeEvent(raw: RawCommerceEvent): NormalizedCommerceEvent;
}

function kindFromType(type: string): CommerceEventKind {
  switch (type) {
    case 'payment.succeeded':
    case 'payment_success':
      return 'PAYMENT_SUCCEEDED';
    case 'payment.failed':
    case 'payment_failed':
      return 'PAYMENT_FAILED';
    case 'refund':
    case 'refund.created':
    case 'payment.refunded':
      return 'REFUND';
    case 'dispute.created':
    case 'dispute.opened':
    case 'chargeback.created':
      return 'DISPUTE_OPENED';
    case 'dispute.closed':
    case 'dispute.resolved':
    case 'chargeback.resolved':
      return 'DISPUTE_CLOSED';
    default:
      return 'UNKNOWN';
  }
}

function header(headers: HeaderBag, name: string): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' && first.length > 0 ? first : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Mock provider — deterministic, the working default.
// ---------------------------------------------------------------------------

/**
 * A fixed dev secret so the harness/tests can produce a genuinely-verified
 * server-side event. This is a MOCK: the mock-event route is gated to
 * non-production, so this secret is never a real money path.
 */
export const MOCK_COMMERCE_SECRET = 'whsec_' + Buffer.from('happy-trader-mock-commerce-secret').toString('base64');

/**
 * Produce the Standard Webhooks headers for a mock event body, so a test or the
 * browser harness can post a server-side event that verifies. Signing requires
 * the secret — a browser cannot forge this, which is the point.
 */
export function signMockCommerceEvent(
  rawBody: string,
  opts: { id?: string; timestampMs?: number } = {},
): Record<string, string> {
  const id = opts.id ?? `mockev_${Math.random().toString(36).slice(2, 10)}`;
  const timestamp = String(Math.floor((opts.timestampMs ?? Date.now()) / 1000));
  const key = Buffer.from(MOCK_COMMERCE_SECRET.slice('whsec_'.length), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${sig}`,
  };
}

export class MockCommerceProvider implements CommerceProvider {
  readonly name = 'MOCK' as const;

  isConfigured(): boolean {
    return true; // configured as a mock.
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutConfig> {
    return {
      provider: 'MOCK',
      configured: true,
      mock: true,
      orderId: input.orderId,
      planId: input.planId,
      sessionId: `mockcs_${input.orderId}`,
      purchaseUrl: null,
    };
  }

  verifyEvent(raw: RawCommerceEvent): CommerceEventVerification {
    return verifyStandardWebhook(raw.rawBody, raw.headers, MOCK_COMMERCE_SECRET);
  }

  normalizeEvent(raw: RawCommerceEvent): NormalizedCommerceEvent {
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw.rawBody);
      if (isRecord(parsed)) body = parsed;
    } catch {
      body = {};
    }
    const type = str(body['type']) ?? str(body['kind']) ?? '';
    const occurred = num(body['occurredAtMs']);
    return {
      providerEventId: str(body['id']) ?? header(raw.headers, 'webhook-id'),
      kind: kindFromType(type),
      atlasOrderId: str(body['atlasOrderId']) ?? str(body['atlas_order_id']),
      providerCustomerId: str(body['providerCustomerId']) ?? str(body['customerId']),
      receiptId: str(body['receiptId']) ?? str(body['id']),
      amountMicros: num(body['amountMicros']),
      currency: str(body['currency']),
      occurredAt: occurred !== null ? new Date(occurred) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Whop provider — wraps the existing whop.ts / whop-client.ts.
// ---------------------------------------------------------------------------

export class WhopCommerceProvider implements CommerceProvider {
  readonly name = 'WHOP' as const;

  isConfigured(): boolean {
    return whopConfigured();
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutConfig> {
    const client = whopClientFromEnv();
    if (!client || !input.planId) {
      // Not set up (or no plan mapped): the order still exists and is fulfillable
      // later by an admin/mock event. Honest "not configured", not an error.
      return { provider: 'WHOP', configured: false, mock: false, orderId: input.orderId, planId: input.planId };
    }
    const session = await client.createCheckoutSession({
      planId: input.planId,
      metadata: { atlasOrderId: input.orderId },
      redirectUrl: input.redirectUrl ?? env().WHOP_CHECKOUT_RETURN_URL ?? null,
    });
    return {
      provider: 'WHOP',
      configured: true,
      mock: false,
      orderId: input.orderId,
      planId: session.planId,
      sessionId: session.id,
      purchaseUrl: session.purchaseUrl,
    };
  }

  verifyEvent(raw: RawCommerceEvent): CommerceEventVerification {
    const secret = env().WHOP_WEBHOOK_SECRET;
    if (!secret) return { ok: false, reason: 'no secret configured' };
    return verifyStandardWebhook(raw.rawBody, raw.headers, secret);
  }

  normalizeEvent(raw: RawCommerceEvent): NormalizedCommerceEvent {
    let payload: unknown = {};
    try {
      payload = JSON.parse(raw.rawBody);
    } catch {
      payload = {};
    }
    const whop = parseWhopEvent(payload);
    const root = isRecord(payload) ? payload : {};
    const data = isRecord(root['data']) ? root['data'] : root;
    return {
      providerEventId: header(raw.headers, 'webhook-id'),
      kind: kindFromType(whop.type),
      atlasOrderId: whop.atlasOrderId,
      providerCustomerId: str(data['user_id']) ?? str(data['customer_id']) ?? str(data['member_id']),
      receiptId: whop.receiptId,
      amountMicros: null, // Whop amounts are validated against the product, never trusted as a balance.
      currency: str(data['currency']),
      occurredAt: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const mock = new MockCommerceProvider();
const whop = new WhopCommerceProvider();

/**
 * The active provider, chosen by the central provider-safety boundary.
 *
 * - REAL (Whop webhook secret present) → the Whop provider.
 * - MOCK (development/test only) → the deterministic mock.
 * - UNAVAILABLE (production, no real config) → the Whop seam, which reports
 *   `isConfigured()===false` and refuses every unsigned event. The mock is NEVER
 *   selected in production, so a missing commerce config cannot become a fake
 *   PAYMENT_SUCCEEDED. See config/provider-safety.ts.
 */
export function commerceProviderFromEnv(): CommerceProvider {
  return commerceMode() === 'MOCK' ? mock : whop;
}

/** What the owner console should display as the active provider. */
export function activeCommerceProviderName(): 'mock' | 'whop' | 'unavailable' {
  const mode = commerceMode();
  return mode === 'REAL' ? 'whop' : mode === 'MOCK' ? 'mock' : 'unavailable';
}

export { WhopApiError };
