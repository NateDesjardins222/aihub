# Payout Provider Interface (Milestone 8)

Happy Trader never hard-codes a single payout vendor. Every external money-movement
provider is reached through one narrow, provider-neutral interface. This is what
lets us ship the entire operational delivery layer — fast lane, retries, webhooks,
reconciliation, SLA — **without a real provider credential**, and swap in a real
provider later without touching the pipeline.

Source: `apps/server/src/platform/payout-provider.ts`,
`payout-provider-mock.ts`, `payout-provider-registry.ts`.

---

## The interface

```ts
interface PayoutProvider {
  readonly id: string;         // 'MOCK' | 'UNCONFIGURED' | <vendor>
  readonly isMock: boolean;    // true only for the deterministic test provider

  health(): Promise<ProviderHealth>;
  validateDestination(input): Promise<DestinationValidation>;
  submitPayout(input: SubmitPayoutInput): Promise<SubmitPayoutResult>;
  getPayout(ref): Promise<GetPayoutResult>;
  cancelPayout?(providerPayoutId): Promise<{ ok; status }>;
  normalizeWebhook(raw: unknown): NormalizedWebhook | null;
  reconcile(ref): Promise<ReconcileResult>;
}
```

Every method returns a **normalized** shape. The pipeline never sees vendor JSON;
each adapter is responsible for mapping the vendor's fields, status strings and
error taxonomy onto ours.

### Normalized vocabularies

- **`NormalizedPayoutStatus`** — `ACCEPTED | PROCESSING | PAID | FAILED | RETURNED | CANCELED | UNKNOWN`.
- **`NormalizedEventType`** (webhooks) — `PAYOUT_ACCEPTED | PAYOUT_PROCESSING | PAYOUT_PAID | PAYOUT_FAILED | PAYOUT_RETURNED | PAYOUT_CANCELED | PAYOUT_UNKNOWN`.
- **`ProviderErrorCategory`** — `NONE | RETRYABLE | HARD_REJECT | DESTINATION_INVALID | DUPLICATE | AUTH | RATE_LIMIT | TIMEOUT | UNKNOWN`.
- **`SubmitOutcome`** — `ACCEPTED | PROCESSING | PAID | FAILED | TIMEOUT | LOST_ACK | DUPLICATE`.

`TIMEOUT` and `LOST_ACK` are first-class: the interface forces every adapter to
tell us *"I don't know if this went through"* rather than throwing an opaque
error the pipeline would have to guess about. That is what makes lost-acknowledgement
handling possible (see `payout-idempotency-and-reconciliation.md`).

### submitPayout is idempotent by contract

`SubmitPayoutInput` always carries a stable `idempotencyKey`
(`happyTraderPayoutId:cycle:provider`, see the idempotency doc). The contract:
**submitting the same key twice must not create a second external payout.** A
compliant adapter re-submitting a known key returns `DUPLICATE` with the original
`providerPayoutId`, never a new one. The mock enforces this; a real adapter must
pass the key to the vendor's own idempotency mechanism.

`SubmitPayoutInput` carries only what a payout needs — amount (micros), currency,
the provider destination **token**, and the idempotency key. It never carries raw
bank numbers, card secrets or identity documents (see `payout-destinations.md`).

---

## The registry and the fail-closed seam

`resolvePayoutProvider(id)` maps a configured provider id to a live instance:

| Configured value | Not production | Production |
|---|---|---|
| `'MOCK'` | the mock singleton | **UNCONFIGURED** (mock refused) |
| unknown / `null` | **UNCONFIGURED** | **UNCONFIGURED** |
| a real vendor id | its adapter | its adapter (only if `productionEnabled`) |

`isProduction()` reads `NODE_ENV`. Two invariants fall out of this table:

1. **The mock never runs in production.** `treasuryGate` additionally refuses to
   submit through a mock when `isProduction()`.
2. **An unconfigured production provider fails closed.** `UnconfiguredPayoutProvider`
   reports `configured: false`, `state: 'DOWN'`, and its `submitPayout()` (which
   takes no input at all) returns `FAILED / HARD_REJECT / non-retryable`. Nothing
   can be submitted until an owner explicitly configures a provider and enables
   production. No silent money movement is possible.

---

## The mock provider

`MockPayoutProvider` is deterministic and scriptable — the backbone of the
deterministic tests and the seeded demo:

- `providerPayoutId = mock_<sha256(idempotencyKey)[:24]>` — stable per key.
- `program(key, { onSubmit, settleTo, reportAmountMicros, reportDestinationRef })`
  scripts an outcome: `PROCESSING` (default), `PAID`, `HARD_REJECT`,
  `DESTINATION_INVALID`, `LOST_ACK`, a transient failure, or a `DUPLICATE`.
- `advance(key, status)` returns a `NormalizedWebhook` for that payout, so a test
  can drive `PROCESSING → PAID` exactly, with no real time and no network.
- `setHealth(...)` / `setDestinationMismatch(...)` simulate an outage or a
  destination-ownership mismatch.
- Same key returns the same stored record; `byKey` and `byId` share one object;
  `LOST_ACK` stores the payout but returns no id (mirroring a real lost ack).

The mock is a **reference implementation of the contract**, not a stub: the
pipeline treats it exactly as it would a real provider.

---

## Writing a real adapter

A real adapter implements the same eight methods and:

1. Passes `idempotencyKey` to the vendor's idempotency header/field.
2. Verifies the webhook signature inside `normalizeWebhook` (the seam is already
   there — return `null` for an unverified or unparseable body → the route
   answers `202` and does nothing).
3. Maps vendor statuses and errors onto the normalized vocabularies above,
   including honest `TIMEOUT` / `LOST_ACK` on an ambiguous submit.
4. Stores **no** raw customer credentials; exchanges them for a provider token
   via `validateDestination`.

No vendor API is assumed or invented here. Until such an adapter exists and an
owner enables production, `UNCONFIGURED` is the production provider and the system
fails closed.
