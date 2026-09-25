/**
 * A deterministic, scriptable mock payout provider (Milestone 8).
 *
 * It powers the deterministic torture tests: every scenario the pipeline must
 * survive — immediate accept, processing, paid, hard reject, transient failure,
 * timeout, lost acknowledgement, returned payment, duplicate/out-of-order
 * webhooks, amount mismatch, and provider outage — is expressed by `program`ming a
 * key, with sane defaults otherwise. It is idempotent on the idempotency key: a
 * second submit of the same key returns the SAME provider payout, never a second
 * payment. It NEVER runs in production (the registry enforces `isMock`).
 */
import { createHash } from 'node:crypto';
import type {
  DestinationValidation, GetPayoutResult, NormalizedEventType, NormalizedPayoutStatus,
  NormalizedWebhook, PayoutProvider, ProviderHealth, ProviderHealthState, ReconcileResult,
  SubmitPayoutInput, SubmitPayoutResult,
} from './payout-provider.js';

export type MockSubmitBehavior =
  | 'ACCEPTED'
  | 'PROCESSING'
  | 'PAID'
  | 'HARD_REJECT'
  | 'TRANSIENT'
  | 'TIMEOUT'
  | 'LOST_ACK'
  | 'DESTINATION_INVALID'
  | 'AMOUNT_INVALID';

interface Program {
  onSubmit?: MockSubmitBehavior;
  /** What a later getPayout / reconcile reports (defaults to what submit produced). */
  settleTo?: NormalizedPayoutStatus;
  /** Provider-reported amount, for amount-mismatch scenarios. */
  reportAmountMicros?: number;
  /** Provider-reported destination, for destination-mismatch scenarios. */
  reportDestinationRef?: string;
}

interface StoredPayout {
  providerPayoutId: string;
  idempotencyKey: string;
  status: NormalizedPayoutStatus;
  amountMicros: number;
  destinationRef: string;
}

export class MockPayoutProvider implements PayoutProvider {
  readonly id = 'MOCK';
  readonly isMock = true;

  private healthState: ProviderHealthState = 'HEALTHY';
  private readonly programs = new Map<string, Program>();
  private readonly byKey = new Map<string, StoredPayout>();
  private readonly byId = new Map<string, StoredPayout>();
  private readonly mismatchDestinations = new Set<string>();

  /** Simulate a provider outage / degradation. */
  setHealth(state: ProviderHealthState): void {
    this.healthState = state;
  }

  /** Script a specific idempotency key's behavior. */
  program(idempotencyKey: string, program: Program): void {
    this.programs.set(idempotencyKey, program);
  }

  /** Mark a destination ref as failing ownership validation. */
  setDestinationMismatch(destinationRef: string): void {
    this.mismatchDestinations.add(destinationRef);
  }

  reset(): void {
    this.healthState = 'HEALTHY';
    this.programs.clear();
    this.byKey.clear();
    this.byId.clear();
    this.mismatchDestinations.clear();
  }

  private pid(key: string): string {
    return `mock_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
  }

  async health(): Promise<ProviderHealth> {
    return { configured: true, state: this.healthState, detail: `mock provider ${this.healthState.toLowerCase()}` };
  }

  async validateDestination(input: { destinationRef: string }): Promise<DestinationValidation> {
    if (this.mismatchDestinations.has(input.destinationRef)) {
      return { ok: false, ownership: 'MISMATCH', reason: 'Destination ownership could not be confirmed.' };
    }
    if (input.destinationRef.includes('invalid')) {
      return { ok: false, ownership: 'UNKNOWN', reason: 'Destination is not valid for payout.' };
    }
    return { ok: true, ownership: 'CONFIRMED', maskedDisplay: 'Bank ****6789', capability: { instant: false } };
  }

  async submitPayout(input: SubmitPayoutInput): Promise<SubmitPayoutResult> {
    if (this.healthState === 'DOWN') {
      return { outcome: 'TIMEOUT', status: 'UNKNOWN', errorCategory: 'TRANSIENT', retryable: true, message: 'provider down' };
    }
    // Idempotency: the same key never pays twice.
    const seen = this.byKey.get(input.idempotencyKey);
    if (seen) {
      return { outcome: 'DUPLICATE', providerPayoutId: seen.providerPayoutId, status: seen.status, errorCategory: 'NONE', retryable: false };
    }
    const program = this.programs.get(input.idempotencyKey) ?? {};
    const behavior = program.onSubmit ?? 'ACCEPTED';
    const providerPayoutId = this.pid(input.idempotencyKey);

    const store = (status: NormalizedPayoutStatus): StoredPayout => {
      const rec: StoredPayout = {
        providerPayoutId, idempotencyKey: input.idempotencyKey, status,
        amountMicros: program.reportAmountMicros ?? input.amountMicros,
        destinationRef: program.reportDestinationRef ?? input.destinationRef,
      };
      this.byKey.set(input.idempotencyKey, rec);
      this.byId.set(providerPayoutId, rec);
      return rec;
    };

    switch (behavior) {
      case 'HARD_REJECT':
        return { outcome: 'FAILED', status: 'FAILED', errorCategory: 'HARD', retryable: false, message: 'hard rejection' };
      case 'DESTINATION_INVALID':
        return { outcome: 'FAILED', status: 'FAILED', errorCategory: 'DESTINATION', retryable: false, message: 'invalid destination' };
      case 'AMOUNT_INVALID':
        return { outcome: 'FAILED', status: 'FAILED', errorCategory: 'AMOUNT', retryable: false, message: 'invalid amount' };
      case 'TRANSIENT':
        return { outcome: 'FAILED', status: 'UNKNOWN', errorCategory: 'TRANSIENT', retryable: true, message: 'transient error' };
      case 'TIMEOUT':
        return { outcome: 'TIMEOUT', status: 'UNKNOWN', errorCategory: 'TIMEOUT', retryable: false, message: 'timeout' };
      case 'LOST_ACK': {
        // The provider DID receive and accept it, but the caller never learns the
        // provider payout id from this call — it must reconcile by key.
        store(program.settleTo ?? 'ACCEPTED');
        return { outcome: 'LOST_ACK', status: 'UNKNOWN', errorCategory: 'TIMEOUT', retryable: false, message: 'acknowledgement lost' };
      }
      case 'PAID': {
        store(program.settleTo ?? 'PAID');
        return { outcome: 'PAID', providerPayoutId, status: 'PAID', errorCategory: 'NONE', retryable: false };
      }
      case 'PROCESSING': {
        store(program.settleTo ?? 'PROCESSING');
        return { outcome: 'PROCESSING', providerPayoutId, status: 'PROCESSING', errorCategory: 'NONE', retryable: false, estimatedSettlement: 'T+1' };
      }
      case 'ACCEPTED':
      default: {
        store(program.settleTo ?? 'ACCEPTED');
        return { outcome: 'ACCEPTED', providerPayoutId, status: 'ACCEPTED', errorCategory: 'NONE', retryable: false, estimatedSettlement: 'T+1' };
      }
    }
  }

  async getPayout(ref: { providerPayoutId?: string; idempotencyKey?: string }): Promise<GetPayoutResult> {
    const rec = ref.providerPayoutId ? this.byId.get(ref.providerPayoutId) : ref.idempotencyKey ? this.byKey.get(ref.idempotencyKey) : undefined;
    if (!rec) return { found: false, status: 'UNKNOWN' };
    return { found: true, providerPayoutId: rec.providerPayoutId, status: rec.status, amountMicros: rec.amountMicros, destinationRef: rec.destinationRef };
  }

  async cancelPayout(providerPayoutId: string): Promise<{ ok: boolean; status: NormalizedPayoutStatus }> {
    const rec = this.byId.get(providerPayoutId);
    if (!rec) return { ok: false, status: 'UNKNOWN' };
    if (rec.status === 'PAID') return { ok: false, status: 'PAID' }; // irreversible
    rec.status = 'CANCELED';
    return { ok: true, status: 'CANCELED' };
  }

  /** Move a stored payout to a new authoritative status and return a webhook for it. */
  advance(idempotencyKey: string, status: NormalizedPayoutStatus): NormalizedWebhook | null {
    const rec = this.byKey.get(idempotencyKey);
    if (!rec) return null;
    rec.status = status;
    const typeMap: Record<NormalizedPayoutStatus, NormalizedEventType> = {
      ACCEPTED: 'PAYOUT_ACCEPTED', PROCESSING: 'PAYOUT_PROCESSING', PAID: 'PAYOUT_PAID',
      FAILED: 'PAYOUT_FAILED', RETURNED: 'PAYOUT_RETURNED', CANCELED: 'PAYOUT_CANCELED', UNKNOWN: 'PAYOUT_UNKNOWN',
    };
    return {
      providerEventId: `evt_${createHash('sha256').update(`${idempotencyKey}:${status}`).digest('hex').slice(0, 20)}`,
      providerPayoutId: rec.providerPayoutId,
      normalizedType: typeMap[status],
      eventTs: Date.now(),
      amountMicros: rec.amountMicros,
    };
  }

  normalizeWebhook(raw: unknown): NormalizedWebhook | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : null;
    const type = typeof r.type === 'string' ? r.type : null;
    if (!id || !type) return null;
    const map: Record<string, NormalizedEventType> = {
      accepted: 'PAYOUT_ACCEPTED', processing: 'PAYOUT_PROCESSING', paid: 'PAYOUT_PAID',
      failed: 'PAYOUT_FAILED', returned: 'PAYOUT_RETURNED', canceled: 'PAYOUT_CANCELED',
    };
    const normalizedType = map[type.toLowerCase()] ?? 'PAYOUT_UNKNOWN';
    return {
      providerEventId: id,
      providerPayoutId: typeof r.payoutId === 'string' ? r.payoutId : undefined,
      normalizedType,
      eventTs: typeof r.ts === 'number' ? r.ts : undefined,
      amountMicros: typeof r.amountMicros === 'number' ? r.amountMicros : undefined,
    };
  }

  async reconcile(input: { providerPayoutId?: string; idempotencyKey?: string }): Promise<ReconcileResult> {
    const got = await this.getPayout(input);
    return { found: got.found, providerPayoutId: got.providerPayoutId, status: got.status, amountMicros: got.amountMicros, destinationRef: got.destinationRef };
  }
}
