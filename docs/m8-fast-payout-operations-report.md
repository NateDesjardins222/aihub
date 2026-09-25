# Milestone 8 — Fast Payout Operations + Provider Architecture + Reconciliation V1 — Completion Report

## What M8 delivered

M8 builds the production-grade **operational payout-delivery layer** that sits
*after* the existing eligibility/economics engine. It answers one question:

> Once a trader is legitimately eligible and requests a payout, how does Happy
> Trader safely get that payout submitted to the configured provider **as fast as
> possible** — targeting **P95 clean-request → provider-submission under five
> minutes**, with **no routine human approval** for normal traders — without ever
> paying twice?

**"Under five minutes" is an internal processing / provider-submission target for
clean eligible payouts. It is NOT a guarantee that funds land in a customer's bank
within five minutes** — provider settlement is outside Happy Trader's control.

M8 changed **nothing** about who qualifies or how much they get. The economics
engine (splits, caps, minimums, winning-days/consistency, the DAILY progressive
qualifying balance, the five-cycle maximum) remains authoritative and untouched.
The operational lifecycle is an additive 1:1 overlay (`payout_operations`) beside
the unchanged `payout_requests` economic spine.

---

## Non-negotiables — how each is met

| Requirement | How M8 meets it |
|---|---|
| Clean payouts need no routine human approval | `runFastLane` auto-approves and submits eligible, clean payouts (STP). |
| Eligibility ≠ operational delivery | `payoutRequests.state` (economics) is unchanged; `payout_operations.opState` is the operational overlay. |
| Enforcement holds come from M7; a hold ≠ fraud | `ENFORCEMENT_HOLD` check consults M7 `holdBlocking`; a hold parks `ENFORCEMENT_REVIEW`, never debits, never accuses. |
| Treasury delay ≠ ineligible; provider failure ≠ ineligible | Gate/provider blocks keep the payout `PAYABLE` (owed, delayed); the worker resumes it. |
| HTTP 200 / SUBMITTED / PROCESSING ≠ PAID | Submit lands in `SUBMITTED`/`PROCESSING`; `PAID` only from authoritative evidence via `applyProviderPaid`→`markPaid`. |
| No duplicate external payouts | Row lock (`FOR UPDATE`, no-op unless `PAYABLE`) + stable idempotency key + provider dedupe. |
| Lost ack never causes a blind duplicate | `LOST_ACK`/`TIMEOUT` → `getPayout` / reconcile, never a blind re-send. |
| Retries preserve idempotency | Same `happyTraderPayoutId:cycle:provider` key on every attempt; bounded, jittered; hard rejects not retried. |
| Webhooks idempotent + out-of-order safe | `onConflictDoNothing` on `(provider, eventId)`; terminal PAID never moved backward. |
| Reconciliation not webhook-only | Immediate / webhook / periodic (`reconcileStaleBatch`) / manual triggers. |
| Account balance not double-debited | Single DEBIT at APPROVED in the unchanged engine; PAID/recon move no balance. |
| Certificates only from authoritative PAID | Unchanged `recognition.ts` fires on `payout.paid`, exactly once. |
| Production fails closed when unconfigured | `UnconfiguredPayoutProvider` (submit takes no args → FAILED/HARD); `treasuryGate` refuses. |
| Mock never silently runs in production | Registry returns UNCONFIGURED for MOCK in production; gate refuses a mock in production. |
| Customer financial data minimized | Destinations store a provider token + masked display only — never raw credentials; never logged or returned. |
| Server authority always | Every check (eligibility, ownership, amount, hold, treasury) is recomputed server-side. |

---

## Deliverables

### Data model (migration `0028_payout_operations.sql`, additive)

`payout_destinations`, `payout_operations`, `payout_operational_checks`,
`payout_submission_attempts`, `payout_provider_events`,
`payout_reconciliation_records`, `payout_operations_config`,
`payout_circuit_breaker_events`. Applied to `atlas` and `atlas_test`.

### Server

- **Provider abstraction** — `payout-provider.ts` (interface + normalized
  vocabularies + `UnconfiguredPayoutProvider`), `payout-provider-mock.ts`
  (deterministic, scriptable), `payout-provider-registry.ts` (fail-closed seam).
- **Clock** — `clock.ts` (`systemClock` + `FakeClock`) for deterministic SLA tests.
- **Destinations** — `payout-destinations.ts` (token + masked display; ownership/
  status states; never raw credentials).
- **Pipeline** — `payout-operations.ts` (state machine, `runFastLane`,
  `runOperationalChecks`, `submitPayable`, `handleSubmitResult`, exactly-once,
  lost-ack, `ingestProviderEvent`, `applyProviderPaid`, `reconcilePayout`).
- **Treasury/config/breaker** — `payout-ops-config.ts` (`treasuryGate`, ceilings,
  circuit breaker, production off by default, audited, optimistic concurrency).
- **SLA + observability** — `payout-ops-metrics.ts` (P50/P90/P95/P99, breach alert,
  owner overview, list views).
- **Durable worker** — `payout-ops-worker.ts` (`SKIP LOCKED` claims, resume,
  retry, stale reconcile).
- **HTTP** — `http/routes/payout-ops.ts` (owner console RBAC; own-scoped portal;
  webhook with signature seam) + `events.ts` / `notifications.ts` additions;
  fast-lane wired into the trader payout-request route.

### Web

- **Owner** — `admin/pages/PayoutOperationsPage.tsx` (Overview/SLA, Fast Lane,
  Exceptions, Processing, Failed, Reconciliation, Provider Health, Treasury; the
  operation detail with checks/attempts/events/reconciliation; retry/reconcile;
  SUPER_ADMIN break-glass with evidence gate).
- **Trader** — `portal/pages/PayoutMethodsPage.tsx` (masked destinations, add via
  the provider/mock flow, disable, unconfigured state; recent payouts with
  customer-safe status and timeline).

### Docs

`payout-operations-architecture-v1.md`, `payout-provider-interface.md`,
`payout-fast-lane.md`, `payout-destinations.md`,
`payout-idempotency-and-reconciliation.md`, `payout-treasury-controls.md`,
`payout-operations-owner-guide.md`, and this report.

### Seed

`scripts/seed-m8-payout-ops.ts` — enables the MOCK provider for the demo org and
seeds operations across states for owner-console acceptance.

---

## Tests

- **Deterministic service tests** — `payout-operations.test.ts` (30) +
  `payout-ops-torture.test.ts` (17): fast-lane auto-approve/debit-once,
  SUBMITTED≠PAID, exact 5-minute SLA with `FakeClock`, enforcement-hold parking,
  circuit-breaker delay preserving liability, provider outage + worker resume,
  stable idempotency key, duplicate-submit → one payout, lost-ack no-blind-retry,
  webhook idempotency + out-of-order safety, no double-debit, reconcile
  provider-ahead / amount-mismatch / return, certificate-only-from-PAID, registry
  fail-closed.
- **Deterministic HTTP tests** — `http/payout-ops-http.test.ts` (28): owner RBAC
  (SUPPORT read / ADMIN act / SUPER_ADMIN break-glass), config optimistic
  concurrency (409), portal IDOR (A cannot read/disable B), webhook no-auth +
  idempotent + no-secret-leak, unconfigured fail-closed, break-glass audit.
- **Total deterministic M8 tests: 75.**
- **Browser acceptance** — `tests/browser/payout-ops-acceptance.spec.mjs`: **55**
  real-browser checks across the owner console and the trader Payout Methods page
  (masked destinations, customer-safe timeline, responsive, light/dark, no console
  errors, no raw reference or secret leak). Registered in `tests/browser/run.mjs`.

A React unique-key warning in `PayoutMethodsPage` was found by the
no-console-errors browser check and fixed.

---

## Validation

- Server typecheck: clean. Web typecheck: clean. Web production build: clean.
- Migrations applied to `atlas` and `atlas_test`.
- M8 service + HTTP tests: 75/75. M8 browser acceptance: 55/55.
- Payout economics, M7 enforcement, account lifecycle, identity, commerce, risk,
  copy trading and rewards regressions were re-run (see the commit history for the
  validation checkpoint). The known pre-existing trading cross-suite flakes
  (money-oracle / determinism / personal-risk-gate / execution-races / engine /
  projection-outbox — which fail only when run together in one process and pass
  individually) are unrelated to M8.

---

## Explicitly NOT built (per the spec's guardrails)

No change to economics/caps/DAILY/five-cycle/M7; no new fraud engine; no real-money
payouts without credentials; no invented provider API docs or hard-coded vendor
semantics; Prodigi / 100K plaque / Rithmic / Databento not activated; homepage not
redesigned. Real provider credentials are **not** required to complete the
provider-neutral M8 architecture — the entire pipeline runs and is proven against
the deterministic mock, and fails closed until an owner configures a real provider
and explicitly enables production.
