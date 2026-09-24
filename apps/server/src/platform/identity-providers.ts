/**
 * The identity-verification provider boundary.
 *
 * The domain speaks to `IdentityVerificationProvider`; the abstraction has a
 * deterministic MOCK (the working default) and a Stripe Identity adapter that is
 * a SEAM ONLY — with no credentials it reports itself unconfigured and NEVER
 * fabricates a verified result. A mock decision is never presented as production.
 *
 * No live Stripe call is made in this build.
 */
import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import type { IdentityStatus } from './customer-identity.js';

/** A provider's normalised view of one verification. `status` is a domain state. */
export interface ProviderVerification {
  readonly ref: string;
  readonly status: IdentityStatus;
  readonly reasonCode?: string | null;
  readonly legalName?: string | null;
  readonly dob?: string | null;
  readonly address?: Record<string, unknown> | null;
}

export interface CreateVerificationInput {
  readonly identityId: string;
  readonly legalName?: string | null;
  readonly dob?: string | null;
  readonly country?: string | null;
  readonly email?: string | null;
}

export interface RawProviderEvent {
  readonly ref: string;
  /** For the mock: the raw provider event payload the harness/test posts. */
  readonly raw?: unknown;
}

export interface NormalizedIdentityEvent {
  readonly ref: string;
  readonly status: IdentityStatus;
  readonly reasonCode?: string | null;
}

export class ProviderUnconfiguredError extends Error {
  constructor(readonly provider: string) {
    super(`${provider} is not configured in this environment.`);
    this.name = 'ProviderUnconfiguredError';
  }
}

export interface IdentityVerificationProvider {
  readonly name: 'MOCK' | 'STRIPE';
  /** Is this provider actually wired to real credentials? */
  isConfigured(): boolean;
  createVerification(input: CreateVerificationInput): Promise<ProviderVerification>;
  getVerificationStatus(ref: string): Promise<ProviderVerification>;
  processProviderEvent(raw: RawProviderEvent): Promise<NormalizedIdentityEvent>;
  requestReverification(ref: string, reason: string): Promise<ProviderVerification>;
}

// ---------------------------------------------------------------------------
// Mock provider — deterministic, the working default.
// ---------------------------------------------------------------------------

type MockDecision = 'IDENTITY_VERIFIED' | 'UNDER_REVIEW' | 'STEP_UP_REQUIRED' | 'REJECTED';

/**
 * The eventual decision is derived from the legal name so tests and the browser
 * flow are reproducible, and encoded into the ref so the provider stays stateless
 * (no in-memory session store to lose on restart):
 *   name contains REVIEW → UNDER_REVIEW; STEP → STEP_UP_REQUIRED;
 *   REJECT → REJECTED; otherwise → IDENTITY_VERIFIED.
 */
function mockDecisionFor(legalName?: string | null): MockDecision {
  const n = (legalName ?? '').toUpperCase();
  if (n.includes('REJECT')) return 'REJECTED';
  if (n.includes('REVIEW')) return 'UNDER_REVIEW';
  if (n.includes('STEP')) return 'STEP_UP_REQUIRED';
  return 'IDENTITY_VERIFIED';
}

const REASON_FOR: Record<MockDecision, string | null> = {
  IDENTITY_VERIFIED: null,
  UNDER_REVIEW: 'MANUAL_REVIEW',
  STEP_UP_REQUIRED: 'STEP_UP',
  REJECTED: 'MANUAL_DECLINE',
};

// Single-character codes so the decision (which itself contains underscores) can
// be encoded into the ref without colliding with the `_` field separator.
const CODE_FOR: Record<MockDecision, string> = {
  IDENTITY_VERIFIED: 'V',
  UNDER_REVIEW: 'R',
  STEP_UP_REQUIRED: 'S',
  REJECTED: 'X',
};
const DECISION_FOR_CODE: Record<string, MockDecision> = {
  V: 'IDENTITY_VERIFIED',
  R: 'UNDER_REVIEW',
  S: 'STEP_UP_REQUIRED',
  X: 'REJECTED',
};

function decodeMockRef(ref: string): MockDecision {
  const code = ref.split('_')[1] ?? 'V';
  return DECISION_FOR_CODE[code] ?? 'IDENTITY_VERIFIED';
}

export class MockIdentityProvider implements IdentityVerificationProvider {
  readonly name = 'MOCK' as const;

  isConfigured(): boolean {
    return true; // the mock is always "configured" — as a mock.
  }

  async createVerification(input: CreateVerificationInput): Promise<ProviderVerification> {
    const decision = mockDecisionFor(input.legalName);
    const ref = `mock_${CODE_FOR[decision]}_${randomBytes(8).toString('hex')}`;
    // A verification starts PENDING; its decision resolves when the flow advances.
    return {
      ref,
      status: 'IDENTITY_PENDING',
      legalName: input.legalName ?? null,
      dob: input.dob ?? null,
      address: input.country ? { country: input.country } : null,
    };
  }

  async getVerificationStatus(ref: string): Promise<ProviderVerification> {
    const decision = decodeMockRef(ref);
    return { ref, status: decision, reasonCode: REASON_FOR[decision] };
  }

  async processProviderEvent(raw: RawProviderEvent): Promise<NormalizedIdentityEvent> {
    const decision = decodeMockRef(raw.ref);
    return { ref: raw.ref, status: decision, reasonCode: REASON_FOR[decision] };
  }

  async requestReverification(ref: string, _reason: string): Promise<ProviderVerification> {
    // A re-verification returns a fresh PENDING verification; the same decoded
    // decision applies (the name did not change) unless a new one is created.
    return { ref, status: 'STEP_UP_REQUIRED', reasonCode: 'STEP_UP' };
  }
}

// ---------------------------------------------------------------------------
// Stripe Identity adapter — SEAM ONLY. Reports unconfigured; makes no live call.
// ---------------------------------------------------------------------------

export class StripeIdentityProvider implements IdentityVerificationProvider {
  readonly name = 'STRIPE' as const;

  isConfigured(): boolean {
    const e = env();
    return Boolean(e.STRIPE_SECRET_KEY && e.STRIPE_IDENTITY_WEBHOOK_SECRET);
  }

  private guard(): void {
    if (!this.isConfigured()) throw new ProviderUnconfiguredError('STRIPE_IDENTITY');
    // Configured is not reachable in this build: no live call is wired. The
    // methods are shaped for the real Stripe Identity API but deliberately do
    // not contact it — a truthful "seam, not integration".
    throw new Error('Stripe Identity live calls are not enabled in this build.');
  }

  async createVerification(_input: CreateVerificationInput): Promise<ProviderVerification> {
    this.guard();
    throw new ProviderUnconfiguredError('STRIPE_IDENTITY');
  }
  async getVerificationStatus(_ref: string): Promise<ProviderVerification> {
    this.guard();
    throw new ProviderUnconfiguredError('STRIPE_IDENTITY');
  }
  async processProviderEvent(_raw: RawProviderEvent): Promise<NormalizedIdentityEvent> {
    this.guard();
    throw new ProviderUnconfiguredError('STRIPE_IDENTITY');
  }
  async requestReverification(_ref: string, _reason: string): Promise<ProviderVerification> {
    this.guard();
    throw new ProviderUnconfiguredError('STRIPE_IDENTITY');
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const mock = new MockIdentityProvider();
const stripe = new StripeIdentityProvider();

/** The active provider: Stripe when configured, else the deterministic mock. */
export function identityProviderFromEnv(): IdentityVerificationProvider {
  return stripe.isConfigured() ? stripe : mock;
}

/** What the owner console should display as the active provider. */
export function activeIdentityProviderName(): 'mock' | 'stripe' {
  return stripe.isConfigured() ? 'stripe' : 'mock';
}
