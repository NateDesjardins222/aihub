# Payout Idempotency & Reconciliation (Milestone 8)

The single most important safety property of a payout system: **never pay a
customer twice.** The second: **never mark a payout PAID unless the provider says
it is.** This document describes the exactly-once machinery and the reconciliation
engine that closes the gap webhooks leave.

Source: `apps/server/src/platform/payout-operations.ts`
(`idempotencyKeyFor`, `submitPayable`, `handleSubmitResult`, `ingestProviderEvent`,
`applyProviderPaid`, `reconcilePayout`), `payout-ops-worker.ts`.

---

## The idempotency key

```
idempotencyKeyFor(payoutRequestId, ordinal, provider) = `${payoutRequestId}:${ordinal}:${provider}`
```

It is derived from the **Happy Trader payout id + cycle + provider** and is
**stable for the life of the payout** — computed once, persisted on
`payout_operations.idempotencyKey` (unique per `(org, key)`), and passed to the
provider on *every* submission attempt and retry. It is **never regenerated** on a
retry. Because the provider is contractually idempotent on this key, re-submitting
it — after a crash, a timeout, a double click, or two workers — cannot create a
second external payout.

---

## Exactly-once submission

Three layers stack:

1. **Row lock.** `submitPayable` claims the op row `FOR UPDATE` and no-ops unless
   it is `PAYABLE`. Two concurrent submitters serialize; the loser sees a
   non-`PAYABLE` row and does nothing.
2. **Same key.** Every attempt (`payout_submission_attempts`, append-only, unique
   `(request, attemptNumber)`) reuses the one stable key.
3. **Provider idempotency.** The provider dedupes on that key and returns
   `DUPLICATE` with the original `providerPayoutId` if it has seen it.

The torture suite proves it: two `submitPayable` calls in parallel, and two
`submitPayableBatch` workers racing the same row, both yield exactly **one**
provider payout and **one** attempt.

---

## HTTP 200 ≠ PAID. SUBMITTED ≠ PAID. PROCESSING ≠ PAID.

A successful HTTP call to the provider means "the provider accepted the request",
not "the money arrived". The pipeline encodes this:

- A successful submit lands in `SUBMITTED` / `PROCESSING` (economic `PROCESSING`),
  never `PAID`.
- `PAID` is reached **only** from authoritative evidence: a `PAYOUT_PAID` webhook
  or a reconciliation that observes the provider status `PAID`. Both funnel through
  `applyProviderPaid` → the unchanged `markPaid`, which writes the `SETTLEMENT`
  marker (moving no money — the debit already happened at APPROVED) and triggers
  the certificate exactly once.

---

## Lost acknowledgement — the dangerous case

The classic double-pay bug: we submit, the network drops the response, and we
"retry" — paying twice. The interface makes the provider tell us the truth instead:

- An ambiguous submit returns `LOST_ACK` or `TIMEOUT`, **not** a blind failure.
- `handleSubmitResult` never blindly retries these. It calls `getPayout(key)` to
  find out what actually happened:
  - provider has it and it is `PAID`/`PROCESSING`/`ACCEPTED` → adopt that truth.
  - provider does not know it → park in `UNKNOWN_PROVIDER_STATE` for reconciliation
    (which will resolve it with the same key — still not a blind re-send).

The test `lost-ack reconcile → no blind retry` asserts a single provider payout
survives a lost acknowledgement.

---

## Webhooks: idempotent, out-of-order safe, not the only truth

`ingestProviderEvent` (behind `POST /api/v1/webhooks/payout/:provider`):

- **Signature seam** — the provider's `normalizeWebhook` verifies the signature and
  parses the body; an unverified/unparseable body → `null` → the route returns
  `202` and does nothing.
- **Idempotent** — inserts into `payout_provider_events` with
  `onConflictDoNothing` on `(provider, providerEventId)`. A duplicate event is a
  no-op (`deduped: true`). The HTTP test sends the same event twice and asserts the
  second is deduped and never double-settles.
- **Out-of-order safe** — a terminal `PAID`/`RECONCILED` op is never moved
  backwards by a late `PROCESSING`/`ACCEPTED` event.
- **Resolves by provider payout id** — an event whose payout we can't match is
  recorded (`processingState = FAILED`) for investigation, never applied blindly.
- Only `PAYOUT_PAID` settles (`applyProviderPaid`); `PAYOUT_RETURNED` records a
  reconciliation and routes a `RETURNED_PAYMENT` exception; failures route the
  appropriate exception.

Webhooks are **best-effort**, so they are never the only path to truth — which is
why reconciliation exists.

---

## The reconciliation engine

`reconcilePayout(db, payoutRequestId, { trigger })` asks the provider for the
authoritative state and repairs any drift. Triggers:

- **IMMEDIATE** — right after an ambiguous submit.
- **WEBHOOK** — on receipt of an event.
- **PERIODIC** — `reconcileStaleBatch` sweeps `SUBMITTED`/`PROCESSING` payouts older
  than the configurable stale threshold (`reconStaleThresholdSeconds`, default
  900s), org-scoped, claimed durably.
- **MANUAL** — an operator's "Reconcile now" button.

Outcomes recorded append-only in `payout_reconciliation_records`
(`mismatchType`, `resolution`, `autoResolved`, detail):

- **Provider ahead** (provider `PAID`, we still show processing) → auto-resolve to
  `PAID` (settlement applied once).
- **Amount mismatch** (provider reports a different amount than the trader share)
  → recorded as `AMOUNT_MISMATCH`, routed to review, and an M7 signal
  (`PAYOUT_AMOUNT_MISMATCH`) is emitted. It never silently overwrites the ledger.
- **Return** → `RETURNED` + review.
- No drift → `NONE`, no action.

The account balance is never double-debited: the debit is the APPROVED boundary in
the economics engine; reconciliation and PAID move no balance. The
`no double-debit` and `reconcile provider-ahead → one settlement` tests prove it.
