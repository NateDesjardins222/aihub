# The Payout Fast Lane (Milestone 8)

The product promise: **clean, eligible payouts are fast.** The internal target is
**P95 of clean eligible requests submitted to the configured provider within five
minutes of the customer's request** — with **no routine human approval** for
normal traders. This document describes the straight-through-processing (STP) path
that delivers that, and the exception lane that everything else falls into.

> "Within five minutes" is the request → **provider-submission** target. It is not
> a promise about when the customer's bank settles the money. Settlement is the
> provider's and the banking network's timeline.

Source: `apps/server/src/platform/payout-operations.ts` (`runFastLane`,
`runOperationalChecks`, `submitPayable`, `routeException`, `customerSafeFor`),
`payout-ops-worker.ts`, `payout-ops-config.ts` (`treasuryGate`).

---

## Two lanes, one operational overlay

M8 adds a `payout_operations` row 1:1 with each `payout_requests` row. The
economic spine (`payoutRequests.state`) is unchanged; the operational lifecycle
lives in `payout_operations.opState`:

```
RECEIVED → AUTOMATED_CHECKS → APPROVED → PAYABLE → SUBMITTING → SUBMITTED
         → PROCESSING → PAID → RECONCILED
                     ↘ EXCEPTION (parked, never a dead end)
                     ↘ FAILED / RETURNED / CANCELED (terminal operational states)
```

`opState` is operational only. It never overrides eligibility and never moves
money by itself — money moves exactly where it always did: the single **DEBIT at
APPROVED** and the **SETTLEMENT marker at PAID**, both in the unchanged economics
engine.

Every request takes one of two lanes:

- **Fast lane (STP)** — clean, eligible, verified destination, no hold, provider
  healthy → auto-approved and submitted, no human.
- **Exception lane** — anything else is *parked with a reason*, visible to
  operators, and either auto-resumes (a delay) or waits for a human (a genuine
  exception). A parked payout is never denied and never silently dropped.

---

## The fast-lane sequence

`runFastLane(db, payoutRequestId)`:

1. **Ensure the operation** (idempotent). Stamps `requestedAt`.
2. **Run the automated checks** (`runOperationalChecks`), each recorded
   append-only in `payout_operational_checks` as `PASS | FAIL | SKIP`:
   - `ELIGIBILITY` — re-reads the authoritative economics engine (server
     authority; the client is never trusted).
   - `OWNERSHIP` / `IDENTITY` — the destination belongs to this customer identity.
   - `ENFORCEMENT_HOLD` — consults M7 (`holdBlocking` for `PAYOUT_REQUEST` /
     `PAYOUT_APPROVAL`). A hold parks the payout in `ENFORCEMENT_REVIEW`; **a hold
     is not a fraud finding** and never debits.
   - `ACCOUNT_STATE` — the account is in a payable state.
   - `DESTINATION` — a payable destination exists (else `DESTINATION_REVIEW`).
   - `DUPLICATE` / `AMOUNT` / `IDEMPOTENCY` — no conflicting external payout, the
     amount matches the authoritative computation, the idempotency key is stable.
   - `TREASURY` / `PROVIDER` — the treasury gate and provider health (below).
3. **A failed check routes to the exception lane** with a specific category and a
   customer-safe category — no debit, no submission.
4. **All clear → approve.** Calls the existing `approvePayout`, which is the debit
   boundary: it re-verifies eligibility under an account advisory lock, debits the
   balance **once**, writes the append-only `DEBIT`, and advances the cycle.
   `opState → APPROVED → PAYABLE`. Idempotent: re-running never double-approves or
   double-debits.

A `PAYABLE` payout is *approved and owed*. Submission is the next, separately
durable step.

---

## Submission: `submitPayable`

`submitPayable(db, payoutRequestId)` is safe to call from the request path, an
operator "Retry", or the durable worker — concurrently:

1. **Claim the op row `FOR UPDATE`** and no-op if it is not `PAYABLE`. Two callers
   (two workers, or a worker and a retry) can never both submit — the second sees
   a non-`PAYABLE` row and returns. This is the core "no duplicate external
   payout" guard.
2. **Re-check the treasury gate.** If the breaker is open, the provider is
   unavailable/unconfigured, or a ceiling is hit, the payout **stays `PAYABLE`**
   with an advisory `exceptionCategory` and a customer-safe `UNDER_REVIEW` — it is
   *delayed, not denied*. The durable worker resumes it automatically when the
   condition clears.
3. **Record a durable submission attempt** (`payout_submission_attempts`,
   append-only, unique on `(request, attemptNumber)`) with the **same** idempotency
   key every time.
4. **Submit through the provider** and route the normalized `SubmitOutcome`
   (`handleSubmitResult`):
   - `ACCEPTED | PROCESSING | PAID | DUPLICATE` → `SUBMITTED` + `markProcessing`
     (economic `PROCESSING`); a `DUPLICATE` reuses the original provider id.
   - `LOST_ACK | TIMEOUT` → **do not blindly retry.** Call `getPayout` to learn
     the truth; if still unknown, park in `UNKNOWN_PROVIDER_STATE` for
     reconciliation. HTTP 200 is never treated as PAID; SUBMITTED is never PAID.
   - `FAILED` retryable (< 5 attempts) → back to `PAYABLE` for a bounded, jittered
     retry with the same key; a hard reject → terminal exception
     (`PROVIDER_REJECTED`), never retried.

`PAID` is only ever reached from **authoritative provider evidence** — a
`PAYOUT_PAID` webhook or a reconciliation that finds the provider `PAID`
(`applyProviderPaid` → the unchanged `markPaid`). That is the single point that
triggers the certificate, exactly once.

---

## The durable worker

`PayoutOpsWorker` / `submitPayableBatch` claim `PAYABLE` rows with
`FOR UPDATE SKIP LOCKED` (disjoint claims across workers) and call `submitPayable`
for each. It resumes what no single request can guarantee: payouts a
treasury/breaker delay left `PAYABLE`, transient retries, and (via
`reconcileStaleBatch`) stale `SUBMITTED`/`PROCESSING` payouts. A server restart
simply picks the durable rows back up.

---

## Customer-safe status

Operators see the precise `opState` + `exceptionCategory`. Customers see a small,
reassuring vocabulary via `customerSafeFor` (`REQUESTED`, `IN_REVIEW`,
`APPROVED`, `ON_THE_WAY`, `PAID`, `ACTION_NEEDED`, `RETURNED`) — never an internal
state like `SUBMITTING`, and never an accusatory word for an operational delay.

---

## What "fast" is measured against

`payout-ops-metrics.ts` computes P50/P90/P95/P99 of **request → submission** from
authoritative timestamps on `payout_operations`. A clean fast-lane payout that
crosses five minutes raises an operational **SLA-breach alert** (`payout.sla_breach`)
— it never accuses the customer, never changes eligibility, and never delays the
money further. See `payout-operations-owner-guide.md`.
