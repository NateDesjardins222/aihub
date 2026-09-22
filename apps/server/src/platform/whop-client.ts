/**
 * Whop REST client — SANDBOX ONLY.
 *
 * The one place Atlas talks to Whop's servers. It exists to create a checkout
 * SESSION so the embedded checkout can carry our Atlas order id as metadata,
 * which the payment webhook then echoes back. Atlas takes no payment here and
 * never sees a card; it asks Whop for a session and hands the session id to the
 * embed.
 *
 * There is deliberately NO production host in this file. The base URL is always
 * `sandbox-api.whop.com`, and `WHOP_SANDBOX` must be `true`, so this milestone
 * cannot reach real money however it is configured. Going to production is a
 * later, explicit change, not a flag flip.
 */
import { env } from '../config/env.js';

/** The Whop SANDBOX REST base. There is no production base in this build. */
const SANDBOX_API_BASE = 'https://sandbox-api.whop.com/api/v2';

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

class SandboxWhopClient implements WhopClient {
  readonly environment = 'sandbox' as const;
  constructor(private readonly apiKey: string) {}

  async createCheckoutSession(input: {
    planId: string;
    metadata: Record<string, string>;
    redirectUrl?: string | null;
  }): Promise<WhopCheckoutSession> {
    const res = await fetch(`${SANDBOX_API_BASE}/checkout_sessions`, {
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
      throw new WhopApiError(res.status, `Whop sandbox rejected the checkout session: ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as { id?: string; plan_id?: string; purchase_url?: string | null };
    if (!body.id) throw new WhopApiError(502, 'Whop returned no checkout session id.');
    return { id: body.id, planId: body.plan_id ?? input.planId, purchaseUrl: body.purchase_url ?? null };
  }
}
