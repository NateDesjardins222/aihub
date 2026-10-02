/**
 * Whop REST client — SANDBOX ONLY.
 *
 * The one place Atlas talks to Whop's servers. It exists to create a CHECKOUT
 * CONFIGURATION so the hosted/embedded checkout can carry our Atlas order id as
 * metadata, which the payment webhook then echoes back (verified: "Payments and
 * memberships created from a checkout session inherit its metadata",
 * docs.whop.com/api-reference/checkout-configurations/create-checkout-configuration).
 * Atlas takes no payment here and never sees a card; it asks Whop for a checkout
 * and hands the id + purchase URL to the frontend.
 *
 * Endpoint per CURRENT official docs: `POST /api/v1/checkout_configurations`
 * (base `https://api.whop.com/api/v1`, sandbox `https://sandbox-api.whop.com/api/v1`)
 * → `{ id: "ch_…", plan: { id }, purchase_url: "/checkout/ch_…/" }`. This is a
 * CREDENTIAL-GATED entry point: it only runs with a sandbox API key, and it is
 * NOT on the money-truth path (that is the signature-verified webhook, which does
 * not depend on this call). The exact request/response must be confirmed against
 * the live sandbox during the canary — see docs/WHOP_CORE50_CANARY_RUNBOOK.md.
 *
 * There is deliberately NO production host in this file. The base URL is always
 * `sandbox-api.whop.com`, and `WHOP_SANDBOX` must be `true`, so this milestone
 * cannot reach real money however it is configured. Going to production is a
 * later, explicit change, not a flag flip.
 */
import { env } from '../config/env.js';

/** The Whop SANDBOX REST base (current v1 API). No production base in this build. */
const SANDBOX_API_BASE = 'https://sandbox-api.whop.com/api/v1';

/** Whop's checkout web host, used to absolutize a relative `purchase_url`. */
const WHOP_CHECKOUT_HOST = 'https://whop.com';

export class WhopNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhopNotConfiguredError';
  }
}

export class WhopApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WhopApiError';
  }
}

export interface WhopCheckoutSession {
  readonly id: string; // ch_...
  readonly planId: string;
  readonly purchaseUrl: string | null;
}

export interface WhopClient {
  readonly environment: 'sandbox';
  createCheckoutSession(input: {
    planId: string;
    metadata: Record<string, string>;
    redirectUrl?: string | null;
  }): Promise<WhopCheckoutSession>;
}

/**
 * A live sandbox client, or null when the sandbox is not configured.
 *
 * Null (not a throw) is the "payments not set up yet" state, so the checkout
 * route can report it honestly instead of erroring. A present client always
 * points at the sandbox.
 */
export function whopClientFromEnv(): WhopClient | null {
  const apiKey = env().WHOP_COMPANY_API_KEY;
  if (!env().WHOP_SANDBOX || !apiKey) return null;
  return new SandboxWhopClient(apiKey);
}

/**
 * Whop returns `purchase_url` as a relative path (`/checkout/ch_…/`); make it an
 * absolute URL the frontend can navigate to. Absolute values pass through
 * unchanged. Null stays null (the frontend then uses the embedded component).
 */
function absolutizePurchaseUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${WHOP_CHECKOUT_HOST}${url.startsWith('/') ? '' : '/'}${url}`;
}

class SandboxWhopClient implements WhopClient {
  readonly environment = 'sandbox' as const;
  constructor(private readonly apiKey: string) {}

  async createCheckoutSession(input: {
    planId: string;
    metadata: Record<string, string>;
    redirectUrl?: string | null;
  }): Promise<WhopCheckoutSession> {
    const res = await fetch(`${SANDBOX_API_BASE}/checkout_configurations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        plan_id: input.planId,
        metadata: input.metadata,
        ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new WhopApiError(res.status, `Whop sandbox rejected the checkout configuration: ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      id?: string;
      plan_id?: string;
      plan?: { id?: string } | null;
      purchase_url?: string | null;
    };
    if (!body.id) throw new WhopApiError(502, 'Whop returned no checkout configuration id.');
    const planId = body.plan?.id ?? body.plan_id ?? input.planId;
    return { id: body.id, planId, purchaseUrl: absolutizePurchaseUrl(body.purchase_url) };
  }
}
