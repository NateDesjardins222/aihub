# Backend Recovery Runbook

**Engineering Resilience Phase 2** · Base `4c4570d` · 2026-09-29

Concise operator procedures for the failure states this platform can enter. The
order of preference is always **inspect → reconcile → retry safely**, and only as a
last resort a carefully-scoped manual change. Every safe recovery below avoids raw
SQL mutation of money; where a manual step is unavoidable it is called out.

Read-only tools available today: the integrity checks (`platform/resilience/integrity-checks.ts`,
`runIntegrityChecks`), the reconciliation oracle (`platform/resilience/reconcile.ts`,
`reconcileAccount`), the payout reconcile (`payout-operations.ts reconcilePayout`),
audit-chain verify (`audit.ts verifyAuditChain`), and `outboxStats`.

---

## 1. Duplicate commerce event
**Symptom:** the same provider payment event arrives twice.
**Why it's safe:** `commercial_orders(org,idempotencyKey)` + `payout_provider_events(provider,eventId)`
dedupe; a duplicate is a no-op.
**Do:** nothing. Confirm with `runIntegrityChecks` (no `DUPLICATE_*`). No manual action.

## 2. Provisioning response lost (customer charged, unsure if account exists)
**Inspect:** find the `commercial_orders` row by idempotency key; check `status`.
**Reconcile/retry:** `retryPendingProvisioning(db)` (runs at boot; can be re-invoked)
re-drives any COMPLETED/PROVISION_BLOCKED/PROVISION_FAILED order idempotently to
exactly one account. Never insert an account by hand.

## 3. Funded transition response lost
**Inspect:** the `account_qualifications` row — `fundingState` and `fundedAccountId`.
**Reconcile/retry:** `fundEligibleQualifications(db)` (or re-call `approveFunding(db, qualId, …)`);
the `fund:<qualId>` key guarantees one funded successor. Never create a funded
account by hand.

## 4. Order outcome ambiguous (client didn't get a response)
**Inspect:** query `orders` by `(accountId, clientOrderId)`.
**Retry:** the client re-submits the SAME `clientOrderId`; the dedup returns the
existing order — no duplicate. If no order exists, the submit never committed; it is
safe to submit again.

## 5. EOD interrupted (process died during the day roll)
**Why it's safe (RES-3):** the roll now writes the day statistic and the account
counters in ONE transaction; a crash leaves neither. The next revaluation replays
the roll idempotently (date short-circuit + absolute-set counters + `daily_stats`
upsert).
**Do:** allow the engine to revalue the account (any mark, or `enforceRules`); the
day finalizes exactly once. Confirm `daily_account_stats` has one row for the date.

## 6. Payout provider timeout / unknown outcome
**Never** mark the payout FAILED on a timeout — a retry could double-pay.
**Inspect:** `payout_operations.op_state` (SUBMITTED/PROCESSING with a TIMEOUT/LOST_ACK
last error).
**Reconcile:** `reconcilePayout(db, requestId)` calls the provider `getPayout` with the
STABLE idempotency key and applies the provider-authoritative status (PAID → settle;
still processing → wait). This is the only correct action.

## 7. Duplicate payout callback
**Why it's safe:** `payout_provider_events(provider,eventId)` dedupes; terminal PAID
is never moved backward.
**Do:** nothing. Confirm with `reconcilePayout` if unsure.

## 8. Payout definitively FAILED after the debit (RES-P2-1)
**Expected (automatic):** a provider `PAYOUT_FAILED` for an APPROVED/PROCESSING
payout now reverses the debit atomically — restores `accounts.balance_micros` and
writes a `payout_ledger` REVERSAL row (idempotent). The trader is made whole.
**Inspect:** `runIntegrityChecks` — a `FAILED_PAYOUT_DEBIT_NOT_REVERSED` finding means
a FAILED payout still carries a DEBIT with no REVERSAL (pre-fix data, or a returned/
canceled provider outcome that is handled manually).
**Reconcile (manual, safe):** re-run `failPayout(db, requestId)` (idempotent — the
unique `(request,REVERSAL)` index prevents a double credit); it writes the REVERSAL
and restores the balance for the winner only. For a **RETURNED** payment (money left
then bounced back) the debit is intentionally NOT auto-reversed — resolve via an
audited `admin_adjustments` CREDIT and record the reconciliation, because the money
genuinely moved and came back.

## 9. Reconciliation mismatch (money doesn't tie out)
**Inspect:** `reconcileAccount(db, accountId)` returns typed lines (position qty/basis/
realized, account realized/fees, balance identity, ledger arithmetic) with expected
vs actual vs delta and the source records.
**Do:** investigate the named entity. **Never** silently "fix" a balance. A genuine
divergence is an incident; open one and preserve the reproduction.

## 10. Failed / stuck outbox event
**Inspect:** `outboxStats(db)` — `deadLetter > 0` means one or more events exhausted
their attempts and are parked (they do NOT block other events).
**Do:** read `outbox_events.last_error`, fix the consumer, then clear the
`dead_letter` flag / reset `available_at` for that row to let the idempotent worker
redeliver. Consumers are idempotent, so redelivery has no duplicate business effect.

## 11. Database restore
**Procedure (dev-proven):** `bash scripts/resilience-restore-drill.sh` takes a
`pg_dump -Fc` of the source, restores into a fresh isolated DB, compares row counts +
a money-ledger content digest, and runs the integrity checks on the restored copy.
For a real restore: stop writers → `pg_restore` into the target → run
`runIntegrityChecks` + `verifyAuditChain` + spot `reconcileAccount` before resuming
writers. See `DISASTER_RECOVERY.md` / `RECOVERY_DRILL_REPORT.md` (Phase 11) for the
full drill and RPO/RTO notes.

## 12. Restart after a crash
**Why it's safe:** all authority is in Postgres. On `start()` the engine rebuilds its
routing cache and re-derives open positions/working orders/brackets from the
database; the boot sweeps (`retryPendingProvisioning`, `certifyPassedEvaluations`,
`fundEligibleQualifications`, `runInactivitySweep`) re-drive interrupted lifecycle
work; the payout-ops and outbox workers resume from durable rows. No warm-up is
required for correctness — only caches repopulate.

---

**Escalate to an incident** (do not self-heal) if: any `reconcileAccount` money line
is non-zero, any P0 integrity finding appears, `verifyAuditChain` reports a break, or
a payout's provider-authoritative state cannot be established. Preserve the state;
do not mutate money by hand.
