/**
 * Central provider-safety boundary (Phase 4).
 *
 * One place decides, per capability, whether the active provider is a real
 * integration (REAL), a deterministic development mock (MOCK), or nothing at all
 * (UNAVAILABLE). The single rule that makes unsafe fallbacks hard to reintroduce:
 *
 *   production NEVER silently selects a mock.
 *
 * A capability with no real provider configured in production resolves to
 * UNAVAILABLE and fails closed at the point of use — it never becomes a
 * successful mock transaction, a fabricated KYC pass, or a faked notification
 * delivery. Development and test may use mocks explicitly (that is their default).
 *
 * Provider factories consume the per-capability `*Mode()` helpers instead of
 * re-deriving `configured ? real : mock` themselves. The `configured` predicates
 * are duplicated here (not imported from the provider modules) so this module has
 * no dependency on them and cannot form an import cycle; each predicate mirrors
 * the provider's own `isConfigured()` and is covered by a drift test.
 */
import { env, type AppEnv } from './env.js';

export type ProviderMode = 'REAL' | 'MOCK' | 'UNAVAILABLE';

/**
 * The one rule. Real config present → REAL. Otherwise a mock is allowed only
 * outside production; in production the capability is UNAVAILABLE (fail closed).
 * Pure, so it is unit-tested without a process environment.
 */
export function resolveProviderMode(
  realConfigured: boolean,
  nodeEnv: AppEnv['NODE_ENV'],
): ProviderMode {
  if (realConfigured) return 'REAL';
  return nodeEnv === 'production' ? 'UNAVAILABLE' : 'MOCK';
}

// --- `configured` predicates (mirror each provider's own isConfigured) --------

/** Commerce (Whop): the webhook secret is what turns real fulfilment on. */
export function commerceConfigured(c: AppEnv): boolean {
  return typeof c.WHOP_WEBHOOK_SECRET === 'string' && c.WHOP_WEBHOOK_SECRET.length > 0;
}

/** Identity (Stripe Identity): both the secret key and the webhook secret. */
export function identityConfigured(c: AppEnv): boolean {
  return Boolean(c.STRIPE_SECRET_KEY && c.STRIPE_IDENTITY_WEBHOOK_SECRET);
}

/** Email (Resend): an API key and a from address. */
export function emailConfigured(c: AppEnv): boolean {
  return Boolean(c.RESEND_API_KEY && c.RESEND_FROM);
}

/** SMS (Twilio): account SID, auth token and a from number. */
export function smsConfigured(c: AppEnv): boolean {
  return Boolean(c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN && c.TWILIO_FROM);
}

// --- per-capability modes -----------------------------------------------------

export function commerceMode(c: AppEnv = env()): ProviderMode {
  return resolveProviderMode(commerceConfigured(c), c.NODE_ENV);
}
export function identityMode(c: AppEnv = env()): ProviderMode {
  return resolveProviderMode(identityConfigured(c), c.NODE_ENV);
}
export function emailMode(c: AppEnv = env()): ProviderMode {
  return resolveProviderMode(emailConfigured(c), c.NODE_ENV);
}
export function smsMode(c: AppEnv = env()): ProviderMode {
  return resolveProviderMode(smsConfigured(c), c.NODE_ENV);
}

// --- capability classifications that are DELIBERATE, not mock-fallbacks --------
// Market data and execution never fail open: the provider is chosen by an
// explicit env enum and reports its own mode/readiness. These are surfaced for
// the owner so a delayed/dev feed or the simulator is never read as "live".

export interface CapabilitySafety {
  readonly capability:
    | 'COMMERCE'
    | 'IDENTITY'
    | 'PAYOUTS'
    | 'MARKET_DATA'
    | 'EXECUTION'
    | 'EMAIL'
    | 'SMS';
  /** REAL / MOCK / UNAVAILABLE for mock-capable capabilities; a classifier otherwise. */
  readonly mode: ProviderMode | 'DELIBERATE';
  /** A short, secret-free description for logs and the owner console. */
  readonly detail: string;
  /**
   * True when the current selection is a safe production posture: a real
   * provider, a fail-closed UNAVAILABLE, or a deliberately-classified feed. A
   * MOCK in production is the one unsafe state and is never produced by the
   * factories after Phase 4 — this flag exists to prove that in health output.
   */
  readonly safeForProduction: boolean;
}

function modeDetail(mode: ProviderMode, realLabel: string): string {
  switch (mode) {
    case 'REAL':
      return `${realLabel} configured`;
    case 'MOCK':
      return 'development mock (non-production)';
    case 'UNAVAILABLE':
      return 'unconfigured — fail closed (unavailable)';
  }
}

/**
 * A secret-free safety summary of every environment-dependent capability, for
 * the startup log and the owner provider-health surface. Payout, market-data and
 * execution details that need runtime/DB state are filled by their own services;
 * here we report the env-derivable posture only.
 */
export function providerSafetySummary(c: AppEnv = env()): CapabilitySafety[] {
  const commerce = commerceMode(c);
  const identity = identityMode(c);
  const email = emailMode(c);
  const sms = smsMode(c);
  const isProd = c.NODE_ENV === 'production';
  const safe = (m: ProviderMode) => m !== 'MOCK' || !isProd;
  return [
    { capability: 'COMMERCE', mode: commerce, detail: modeDetail(commerce, 'Whop'), safeForProduction: safe(commerce) },
    { capability: 'IDENTITY', mode: identity, detail: modeDetail(identity, 'Stripe Identity'), safeForProduction: safe(identity) },
    {
      capability: 'PAYOUTS',
      mode: 'UNAVAILABLE',
      detail: 'no real payout rail; registry + treasury gate fail closed (no PAID via mock in production)',
      safeForProduction: true,
    },
    {
      capability: 'MARKET_DATA',
      mode: 'DELIBERATE',
      detail: `provider=${c.MARKET_DATA_PROVIDER} (explicit; a delayed/dev feed is labelled, never reported as live)`,
      safeForProduction: true,
    },
    {
      capability: 'EXECUTION',
      mode: 'DELIBERATE',
      detail: `provider=${c.EXECUTION_PROVIDER} externalLive=${c.EXTERNAL_LIVE_ENABLED} (simulator never masquerades as live)`,
      safeForProduction: true,
    },
    { capability: 'EMAIL', mode: email, detail: modeDetail(email, 'Resend'), safeForProduction: safe(email) },
    { capability: 'SMS', mode: sms, detail: modeDetail(sms, 'Twilio'), safeForProduction: safe(sms) },
  ];
}

/** A one-line-per-capability startup log body (no secrets). */
export function providerSafetyLogLines(c: AppEnv = env()): string[] {
  return providerSafetySummary(c).map(
    (s) => `  ${s.capability.padEnd(12)} ${String(s.mode).padEnd(12)} ${s.detail}`,
  );
}
