/**
 * Provider-neutral payout disbursement interface (Milestone 8).
 *
 * Happy Trader never binds its payout operations to one vendor. Every provider —
 * the deterministic mock, a future ACH/bank rail, a supported payout platform —
 * implements this narrow interface, and the domain only ever speaks in NORMALIZED
 * statuses/events/errors so no vendor-specific state leaks through the system.
 *
 * Critical safety properties this interface is built around:
 *  - `submitPayout` is IDEMPOTENT on the stable idempotency key: submitting the
 *    same key twice returns the same provider payout, never a second payment.
 *  - a lost acknowledgement is a first-class outcome (`LOST_ACK`), distinct from a
 *    real failure, so the caller reconciles rather than blindly retrying.
 *  - HTTP success is never "paid": only an authoritative PAID status/event counts.
 */

export type NormalizedPayoutStatus =
  | 'ACCEPTED'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED'
  | 'RETURNED'
  | 'CANCELED'
  | 'UNKNOWN';

export type NormalizedEventType =
  | 'PAYOUT_ACCEPTED'
  | 'PAYOUT_PROCESSING'
  | 'PAYOUT_PAID'
  | 'PAYOUT_FAILED'
  | 'PAYOUT_RETURNED'
  | 'PAYOUT_CANCELED'
  | 'PAYOUT_UNKNOWN';

/** How a provider error should be treated by the retry/exception logic. */
export type ProviderErrorCategory =
  | 'NONE'
  | 'TRANSIENT' // retry with the same key
  | 'HARD' // do not retry — route to exception
  | 'DESTINATION' // bad destination — do not retry
  | 'AMOUNT' // invalid amount — do not retry
  | 'OWNERSHIP' // ownership problem — do not retry, emit signal
  | 'COMPLIANCE' // provider compliance rejection — do not retry
  | 'TIMEOUT'; // outcome unknown — reconcile, do not blind-retry

export type ProviderHealthState = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

export interface ProviderHealth {
  readonly configured: boolean;
  readonly state: ProviderHealthState;
  readonly detail?: string;
}

export interface DestinationValidation {
  readonly ok: boolean;
  readonly ownership: 'CONFIRMED' | 'PENDING' | 'MISMATCH' | 'UNKNOWN';
  readonly maskedDisplay?: string;
  readonly capability?: Record<string, unknown>;
  readonly reason?: string;
}

export interface SubmitPayoutInput {
  readonly idempotencyKey: string;
  readonly amountMicros: number;
  readonly currency: string;
  readonly destinationRef: string;
  readonly payoutRequestId: string;
  readonly correlationId: string;
}

/** The distilled outcome of a single submission attempt. */
export type SubmitOutcome =
  | 'ACCEPTED'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED'
  | 'TIMEOUT'
  | 'LOST_ACK'
  | 'DUPLICATE';

export interface SubmitPayoutResult {
  readonly outcome: SubmitOutcome;
  readonly providerPayoutId?: string;
  readonly status: NormalizedPayoutStatus;
  readonly errorCategory: ProviderErrorCategory;
  readonly retryable: boolean;
  readonly estimatedSettlement?: string;
  readonly message?: string;
}

export interface GetPayoutResult {
  readonly found: boolean;
  readonly providerPayoutId?: string;
  readonly status: NormalizedPayoutStatus;
  readonly amountMicros?: number;
  readonly destinationRef?: string;
}

export interface NormalizedWebhook {
  readonly providerEventId: string;
  readonly providerPayoutId?: string;
  readonly normalizedType: NormalizedEventType;
  readonly eventTs?: number;
  readonly amountMicros?: number;
}

export interface ReconcileResult {
  readonly found: boolean;
  readonly providerPayoutId?: string;
  readonly status: NormalizedPayoutStatus;
  readonly amountMicros?: number;
  readonly destinationRef?: string;
}

export interface PayoutProvider {
  readonly id: string;
  /** Mock providers may only run in non-production modes. Enforced by the registry. */
  readonly isMock: boolean;
  health(): Promise<ProviderHealth>;
  validateDestination(input: { destinationRef: string; customerRef?: string }): Promise<DestinationValidation>;
  submitPayout(input: SubmitPayoutInput): Promise<SubmitPayoutResult>;
  getPayout(ref: { providerPayoutId?: string; idempotencyKey?: string }): Promise<GetPayoutResult>;
  cancelPayout?(providerPayoutId: string): Promise<{ ok: boolean; status: NormalizedPayoutStatus }>;
  normalizeWebhook(raw: unknown): NormalizedWebhook | null;
  reconcile(input: { providerPayoutId?: string; idempotencyKey?: string }): Promise<ReconcileResult>;
}

// ---------------------------------------------------------------------------
// The UNCONFIGURED production seam — fails closed. No production payout ever
// silently falls back to the mock; an unconfigured production provider refuses
// to move money, loudly.
// ---------------------------------------------------------------------------
export class UnconfiguredPayoutProvider implements PayoutProvider {
  readonly id = 'UNCONFIGURED';
  readonly isMock = false;
  async health(): Promise<ProviderHealth> {
    return { configured: false, state: 'UNKNOWN', detail: 'No payout provider is configured.' };
  }
  async validateDestination(): Promise<DestinationValidation> {
    return { ok: false, ownership: 'UNKNOWN', reason: 'No payout provider is configured.' };
  }
  async submitPayout(): Promise<SubmitPayoutResult> {
    // Fail closed. This is never retryable and never a silent success.
    return { outcome: 'FAILED', status: 'UNKNOWN', errorCategory: 'HARD', retryable: false, message: 'No payout provider is configured; refusing to move money.' };
  }
  async getPayout(): Promise<GetPayoutResult> {
    return { found: false, status: 'UNKNOWN' };
  }
  normalizeWebhook(): NormalizedWebhook | null {
    return null;
  }
  async reconcile(): Promise<ReconcileResult> {
    return { found: false, status: 'UNKNOWN' };
  }
}
