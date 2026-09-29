# Crash-Point Matrix

**Engineering Resilience Phase 2** · Base `4c4570d` · 2026-09-29

For each critical workflow: the meaningful crash points and the **expected** result
at each. Governing property — **A** transaction commits completely, **B** rolls back
completely, or **C** enters a durable recoverable state that continues/reconciles
deterministically. There is no fourth ("we don't know") category.

**Result codes** — ROLLBACK (B: nothing partial) · COMMITTED (A) · REPLAYABLE (C:
retry/sweep re-drives idempotently) · RECONCILABLE (C: resolved against an external
truth) · MANUAL (needs an operator, with a runbook). "Proof" cites the test that
injects the crash (via `platform/resilience/failpoints.ts`) or the guard that makes
it safe.

## Provisioning (purchase → account) — `commerce.ts`, `provisioning.ts`
| Crash point | Result | Proof |
|---|---|---|
| before account insert | ROLLBACK | `failpoints.probe.test.ts` |
| after account insert, before lifecycle insert (same txn) | ROLLBACK | `failpoints.probe.test.ts` (trip #2) |
| before txn commit | ROLLBACK | `failpoints.probe.test.ts` |
| after commit, before response | COMMITTED → REPLAYABLE | `crash-recovery.test.ts` (response-loss retry, same `ent:`/`fund:` key → one account) |
| duplicate commerce event | REPLAYABLE | `commercial_orders(org,idemKey)` + `retryPendingProvisioning` |
| after `fulfillCompletedOrder` commit, before order→PROVISIONED flip | REPLAYABLE | sweep re-drives; converges to one account |

## Reset — `account-reset.ts`, `commerce.ts`
| Crash point | Result | Proof |
|---|---|---|
| mid-fulfill (any sub-txn) | ROLLBACK per sub-txn; ≤1 successor overall | `crash-recovery.test.ts` (trip #4 → ≤1, retry → exactly 1) |
| after commit, before response | REPLAYABLE | double-fulfill → one successor (PROVISIONED short-circuit) |
| concurrent double-fire | REPLAYABLE | `resilience-races.test.ts` (8-way → one) |
| second successor attempt (any path) | ROLLBACK (fail-closed) | **RES-4** partial unique index `accounts_reset_of_key` (`resilience-races.test.ts`) |

## Evaluation → funded — `commerce.ts certifyEvaluation`/`approveFunding`
| Crash point | Result | Proof |
|---|---|---|
| mid-`approveFunding` (account insert / link / qual update) | ROLLBACK | `crash-recovery.test.ts` (trip #3 → no funded account, qual not marked) |
| after commit, before response | COMMITTED → REPLAYABLE | `crash-recovery.test.ts` (re-approve → same funded account, `fund:<qualId>`) |
| duplicate `account.passed` / duplicate qualify | REPLAYABLE | `account_qualifications(account,lifecycle)` + `certifyPassedEvaluations` |
| FAILED account certify | (no-op, returns null) | `crash-recovery.test.ts` terminal monotonicity |

## Order submit / execution → position — `engine.ts`
| Crash point | Result | Proof |
|---|---|---|
| before order insert | ROLLBACK (no order) | order authority = the insert |
| after order insert, before fill | COMMITTED (order durable, no fill) | order fills on next match/replay |
| any write inside the fill txn (orders/positions/executions/trades/day-state/balance/outbox) | ROLLBACK (execution + position never diverge) | `engine-atomicity.test.ts` (trip #2–#5, oracle clean) |
| after fill commit, before bracket-sync/audit/rule-eval | COMMITTED → REPLAYABLE | `syncBrackets` rebuilds from persisted entries on next pass; audit best-effort |
| response-loss / reconnect / duplicate clientOrderId | REPLAYABLE | `orders(accountId,clientOrderId)` dedup (Phase 1 `idempotency.test.ts`) |

## EOD finalization — `engine.ts rulesLocked` (**RES-3 fixed**)
| Crash point | Result | Proof |
|---|---|---|
| between day-stat write and counter write | **ROLLBACK** (now one txn — no partial day) | `engine-atomicity.test.ts` (trip #2 → neither written) |
| after commit, before ack | COMMITTED → REPLAYABLE | idempotent roll (date short-circuit + absolute-set) |
| duplicate/late revaluation | REPLAYABLE (idempotent) | `engine-atomicity.test.ts` (replay → one day stat, floor unchanged) |

## Payout request — `payouts.ts requestPayout`
| Crash point | Result | Proof |
|---|---|---|
| before commit | ROLLBACK (no request, no money moved) | atomic txn; moves no money |
| after commit, before response | COMMITTED → REPLAYABLE | `(org,idemKey)` + one-pending guard |
| concurrent | REPLAYABLE | advisory lock + `FOR UPDATE` (Phase 1 `payouts.test.ts`) |

## Payout approval (the debit) — `payouts.ts approvePayout`
| Crash point | Result | Proof |
|---|---|---|
| after balance debit, before DEBIT ledger (same txn) | ROLLBACK | one txn; `payout_ledger(request,DEBIT)` unique |
| after commit, before response | COMMITTED → REPLAYABLE | STATE early-return + VERSION CAS (idempotent) |
| concurrent approve | REPLAYABLE (one debit) | unique DEBIT index aborts the second (Phase 1 `payout-ops-torture.test.ts`) |

## Payout payment — `payout-operations.ts`
| Crash point | Result | Proof |
|---|---|---|
| before provider call | ROLLBACK/REPLAYABLE (still PAYABLE) | worker resubmits, stable key |
| provider success, crash before local persist | RECONCILABLE | reconcile via `getPayout` (stable key), never blind re-submit |
| provider TIMEOUT / lost ACK (unknown) | RECONCILABLE (NOT auto-failed) | `SubmitOutcome` TIMEOUT/LOST_ACK → reconcile; `payout-ops-torture.test.ts` |
| duplicate provider callback | REPLAYABLE (deduped) | `payout_provider_events(provider,eventId)` |
| **provider definitively FAILED after debit** | **C: balance reversed atomically (RES-P2-1)** | `payout-reversal-crash.test.ts` (REVERSAL + restore; idempotent; crash-atomic) |

## Cycle-5 completion — `payouts.ts markPaid`
| Crash point | Result | Proof |
|---|---|---|
| during completion (5th PAID → COMPLETED) | ROLLBACK/idempotent | count-guard + `status != COMPLETED`; Phase 1 `payout-daily-progression.test.ts` |
| a 6th approval | fail-closed at approval | `MAX_PAYOUT_CYCLES` guard before a 6th |

## Enforcement / account close
| Crash point | Result | Proof |
|---|---|---|
| stale op on FAILED/CLOSED/COMPLETED account | rejected (no resurrection) | state gates; `crash-recovery.test.ts` terminal monotonicity |

## Infrastructure
| Crash point | Result | Proof |
|---|---|---|
| DB connection loss mid-txn | ROLLBACK (ACID) | fault injector forces abort; `failpoints.probe.test.ts` |
| transaction deadlock | one aborts (40P01), other commits; retry safe | `durability-extras.test.ts` |
| stale version write (CAS) | rejected | Phase 1 `personal-risk.crud.test.ts` C07, `adversarial.test.ts` |
| outbox publisher down | REPLAYABLE (durable, delivered on run) | `durability-extras.test.ts` |
| outbox consumer crash mid-handler | ROLLBACK (work + mark together) | `durability-extras.test.ts` |
| outbox poison event | MANUAL (dead-letter after maxAttempts; queue not wedged) | `durability-extras.test.ts` |
