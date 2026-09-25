# Payout Operations Architecture V1 (Milestone 8)

M8 builds the **operational delivery layer** that sits *after* the existing
payout eligibility/economics engine. It does not change who qualifies for a
payout or how much they get. It answers one question:

> Once a trader is legitimately eligible and requests a payout, how does Happy
> Trader safely get that payout submitted to the configured provider **as fast as
> possible** — targeting P95 clean-request → provider-submission **under 5
> minutes** — without ever paying twice, and without making profitable traders
> wait for a human?

**"Under 5 minutes" is an internal processing/submission target for clean
eligible payouts. It is NOT a guarantee that funds land in the customer's bank
within 5 minutes** — provider settlement is outside Happy Trader's control.

---

## What already exists (audit)

The M5/M6 payout engine (`payout-core.ts`, `payouts.ts`, `payout-queries.ts`) is
authoritative and unchanged by M8:

- **Eligibility & economics** — `evaluatePayoutEligibility` + `resolvePayoutRequest`:
  90/10 split, caps per ordinal, minimums, the 50% rule, protected buffer,
  winning-day / consistency requirements, the DAILY progressive qualifying-balance
  rule, and the **five payout-cycle** maximum (`MAX_PAYOUT_CYCLES = 5`).
- **State machine** — `payoutRequests.state`:
  `REQUESTED → UNDER_REVIEW → APPROVED → PROCESSING → PAID`
  (+ `REJECTED`, `CANCELLED`, `FAILED`), guarded by an `ALLOWED` transition map.
- **The debit boundary is APPROVED.** `approvePayout` re-verifies eligibility
  under an account advisory lock, computes the split, **debits the balance once**,
  writes the append-only `payout_ledger` `DEBIT` row (unique on
  `(request, entry_type)` — a duplicate approval cannot double-debit), snapshots
  the qualifying balance, and advances the cycle (`advanceCycleAfterPayout`).
- **PAID** — `markPaid` writes the append-only `SETTLEMENT` marker (moves no
  balance), publishes `payout.paid`, and — when the Nth (max) payout reaches PAID
  — marks the account `COMPLETED` and publishes `account.completed`.
- **Rewards** — `recognition.ts` issues the payout certificate on `payout.paid`
  and the account-completion certificate on `account.completed`, **exactly once**
  each (idempotent). These fire only from authoritative PAID.
- **Enforcement holds (M7)** — `requestPayout` and `approvePayout` already consult
  `holdBlocking` for `PAYOUT_REQUEST` / `PAYOUT_APPROVAL` holds (incl. a hold
  scoped to the specific request); a held payout is never debited.
- **Supporting infrastructure** — `outbox.ts` (durable `OutboxWorker`,
  `FOR UPDATE SKIP LOCKED`, backoff, dead-letter), `events.ts`, `notifications.ts`
  (+ providers/outbox), `customer-identity.ts` + `identity-verification.ts` (KYC),
  `commerce`/payment provenance, `ledger-audit.ts`, `recordAudit` (hash-chained),
  and the owner Payouts console (`admin/pages/PayoutsPage.tsx`) + trader
  `PayoutModule.tsx`.

There is **no** payout-destination model, **no** provider abstraction for
disbursement, **no** submission-attempt / provider-event / reconciliation
tables, **no** treasury/circuit-breaker controls, and **no** SLA
instrumentation. `markPaid` is currently a manual/mock admin action. M8 adds all
of this.

---

## What M8 adds (and what it deliberately does NOT touch)

M8 is **additive**. It does not add values to the `payoutRequests.state` enum, so
every existing payout test, ledger invariant and UI keeps working. Instead the
operational lifecycle lives in a new **1:1 `payout_operations`** record that
overlays the economic state:

| Economic `state` (unchanged, authoritative) | Operational `opState` (new, M8) |
|---|---|
| REQUESTED | `RECEIVED → AUTOMATED_CHECKS` |
| REQUESTED / UNDER_REVIEW | `EXCEPTION` (+ category) — not debited |
| APPROVED | `PAYABLE → SUBMITTING → SUBMITTED` |
| PROCESSING | `PROCESSING` |
| PAID | `PAID → RECONCILED` |
| FAILED | `FAILED` / `RETURNED` |
| CANCELLED | `CANCELED` |

The economic `state` is still the money spine: **debit at APPROVED, settle at
PAID.** The operational layer decides *when* those transitions happen (fast lane
vs. exception lane) and drives them automatically for clean payouts.

### The fast lane (straight-through processing)

`runFastLane(payoutRequestId)` runs deterministic server-side checks — economic
eligibility (re-verified), account ownership, identity state, a verified/active
payout **destination**, no applicable **enforcement hold**, no duplicate movement,
account state, amount within the canonical available, the **treasury** gate,
provider health/configuration, and clean idempotency — and, when **all** pass,
automatically:

`REQUESTED → AUTOMATED_CHECKS → APPROVED (debit) → PAYABLE → submission queue`

with **no human approval**. A durable worker then submits to the provider. Target
is seconds; five minutes is the upper product target.

### The exception lane

Any failed check routes the payout to `opState = EXCEPTION` with an explicit
internal category (`IDENTITY_REVIEW`, `DESTINATION_REVIEW`, `ENFORCEMENT_REVIEW`,
`TREASURY_REVIEW`, `PROVIDER_UNAVAILABLE`, `PROVIDER_REJECTED`,
`DUPLICATE_CONFLICT`, `ACCOUNT_STATE_CONFLICT`, `AMOUNT_CONFLICT`,
`SECURITY_REVIEW`, `RETURNED_PAYMENT`, `UNKNOWN_PROVIDER_STATE`) and a
customer-safe category. The payout is never silently failed, and an economically
ineligible request is **not** an operational exception — it is simply refused at
request time by the existing engine.

**A treasury delay or a provider outage never makes a trader ineligible** — the
payout is approved/owed and merely operationally delayed.

### Provider abstraction

`PayoutProvider` (provider-neutral): `id`, `health()`, `validateDestination()`,
`submitPayout()` (idempotent), `getPayout()`, `cancelPayout?()`,
`normalizeWebhook()`, `reconcile()`, with normalized status/error/event enums so
no vendor state leaks into the domain. Implementations: a deterministic,
scriptable **MockPayoutProvider** (for dev/test only), a **registry**, and an
**UNCONFIGURED** production seam that **fails closed** — no production payout ever
falls back to mock.

### Exactly-once money movement & lost-ack safety

Every payout has a **stable, immutable idempotency key**
(`payoutRequestId : payoutOrdinal : provider`) that is *never* regenerated on
retry. `payout_submission_attempts` is append-only and durable. On a lost
acknowledgement (provider received it but the response was lost) the system
retains the same key, calls `provider.getPayout()` / `reconcile()`, and only
retries with the same key or routes to `UNKNOWN_PROVIDER_STATE` — it never blindly
resubmits. This mirrors the Atlas execution-provider philosophy.

### Webhooks, provider events & reconciliation

Provider-neutral webhook ingestion with a signature-verification seam, idempotent
on `(provider, providerEventId)`, normalized into `PAYOUT_ACCEPTED / PROCESSING /
PAID / FAILED / RETURNED / CANCELED / UNKNOWN`. **HTTP 200 never means PAID; only
an authoritative `PAYOUT_PAID` event (webhook or reconcile) drives `markPaid`.**
The reconciliation engine compares expected vs. provider-authoritative state,
auto-resolves safe deterministic transitions, and routes ambiguous mismatches to
exception review. Reconciliation runs immediately post-submit, on webhooks,
periodically, and on manual owner trigger — it never depends on webhooks alone.

### Treasury gate & circuit breaker

A server-authoritative treasury submission gate (reserve threshold, max single /
aggregate automatic amount, provider health, reconciliation health) — an
operational control, not a hidden trader rule. A circuit breaker pauses **new**
external submissions without deleting requests, erasing liabilities, rewriting
paid history, or making anyone ineligible. Both are owner-configured, audited, and
default to **production payouts disabled until configured**.

### SLA instrumentation

`payout_operations` carries `requestedAt / checksStartedAt / checksCompletedAt /
approvedAt / payableAt / submissionStartedAt / submittedAt / providerProcessingAt
/ paidAt / reconciledAt`, from which the pipeline computes REQUEST→APPROVAL,
REQUEST→SUBMISSION, SUBMISSION→ACK and SUBMISSION→PAID durations. The primary
metric is **P95 clean request → provider-submitted < 5 min**; the owner overview
surfaces median/P90/P95/P99, fast-lane %, exception %, provider-failure % and
reconciliation-mismatch rate. A clean fast-lane payout that exceeds 5 minutes
raises an operational **SLA breach** alert — it never accuses the customer or
alters eligibility.

---

## Data model (migration 0028, additive, no destructive change)

- `payout_destinations` — provider-tokenized destinations (never raw credentials).
- `payout_operations` — 1:1 overlay: opState, exception category, fast-lane flag,
  provider/destination refs, stable idempotency key, the SLA timestamp set,
  `slaBreached`, version.
- `payout_operational_checks` — append-only per-check results.
- `payout_submission_attempts` — append-only durable attempts.
- `payout_provider_events` — append-only, unique `(provider, providerEventId)`.
- `payout_reconciliation_records` — append-only reconciliation outcomes.
- `payout_operations_config` — per-org treasury + provider + circuit-breaker
  configuration (singleton), version-guarded.
- `payout_circuit_breaker_events` — append-only breaker open/close audit.

All immutable IDs, FKs, timestamps, idempotency, safe indexes, version/concurrency
protection, append-only provider events + audit.

## M7 integration (consume, don't duplicate)

M8 consumes M7 hold decisions before fast-lane approval/submission and may emit
M7 *signals* (destination mismatch, suspicious duplicate attempt, provider-reported
ownership issue, payout tampering) — **a signal is not a finding**, and M8 never
independently terminates a customer or builds a second fraud engine.

## Certificates / rewards / completion (unchanged)

Certificates and lifetime-club progression still trigger only from authoritative
PAID, exactly once, via the existing `payout.paid` / `account.completed` events.
A RETURNED payment never deletes historical certificate issuance. Account
completion still counts at the established boundary; a provider failure never
creates a sixth cycle.
