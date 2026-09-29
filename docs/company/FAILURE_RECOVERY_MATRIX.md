# Failure Recovery Matrix

**Engineering Resilience Phase 1** · Base `b48ba7e` · 2026-09-29

For each critical flow: what a failure at the worst moment leaves behind, whether it is safe to retry, and how it recovers. The governing property is **fail closed or recover safely** — never silent corruption. Evidence lives in `BACKEND_INVARIANT_LEDGER.md` and the cited tests.

| Flow | What can fail | State that may exist | Client retry? | Operator retry? | Retry idempotent? | Recovery | Money duplicable? | Account state diverge? |
|---|---|---|---|---|---|---|---|---|
| **Provision** (purchase→account) | crash mid-txn; duplicate event; timeout | none partial (single txn); at most a COMPLETED order without an account | yes | yes (`retryPendingProvisioning` sweep) | yes — 4 unique-index dedups + provisioning-request key | sweep re-drives to PROVISIONED exactly once | No | No |
| **Reset** | double-click; concurrent; crash between order + fulfil | COMPLETED reset order without successor | yes | yes | yes — fixed `reset:<id>` order key | re-fulfil returns the same successor | No | No (failed account preserved) |
| **Funded transition** | duplicate `account.passed`; concurrent approve; crash | qualification without funded account | n/a (server-driven) | yes (`fundEligibleQualifications` sweep) | yes — qual row lock + `fund:<qualId>` key + life unique | sweep funds exactly once | No | No |
| **Order submit** | timeout; reconnect; duplicate | none (reject before insert) or one order | yes — same `clientOrderId` = no-op | n/a | yes — `orders(accountId,clientOrderId)` unique | duplicate returns existing order | No | No |
| **Execution → position** | crash mid-match | none partial (single txn: orders+position+execs+balance+outbox) | n/a | n/a | n/a (atomic) | txn commits or rolls back wholly | No | No |
| **EOD finalization** | crash during the day roll | none partial — **one txn** (RES-3 resolved): day stat + counters commit or roll back together | n/a | yes (next revaluation) | yes — date short-circuit + absolute-set counters + upsert | crash rolls back wholly; next roll replays idempotently | No | No |
| **Payout failure (provider FAILED)** | crash during reversal; duplicate FAILED event | none partial — one txn: balance restore + REVERSAL ledger + state→FAILED | n/a | yes — re-run `failPayout` (idempotent) | yes — UNIQUE `payout_ledger(request,REVERSAL)` + state guard | debit is reversed exactly once; balance made whole (RES-P2-1) | No | No |
| **Payout request** | concurrent; duplicate key | at most one REQUESTED row | yes — idem key / one-pending guard | yes | yes | serialized on account advisory lock | No (no money moved at request) | No |
| **Payout approval (debit)** | crash after debit before ledger; concurrent approve; timeout | none partial (single txn: balance + DEBIT ledger + version) | no (state guard) | yes — `if APPROVED\|PROCESSING\|PAID return` | yes — STATE + VERSION + unique DEBIT ledger | idempotent early-return; unique index aborts a second debit | No | No |
| **Payout payment** | duplicate provider callback; lost ACK; restart | at most one SETTLEMENT ledger row | n/a | yes — reconcile, never blind re-submit | yes — `if PAID return` + unique SETTLEMENT + provider-event dedup + stable idem key | reconcile resolves local vs provider | No | No |
| **Account completion (cycle 5)** | concurrent cycle-5 approvals | none extra | n/a | n/a | yes — blocked at approval before a 6th; COMPLETED under status guard | one completion, cycle 6 unreachable | No | No |
| **Enforcement / kill switch** | applied mid-order | order rejected pre-exposure | yes | yes | yes | hold re-checked under the account lock on every order | No | No |

## Notes

- **No flow has a partial-write window that touches money.** As of Resilience Phase 2 there is also **no PARTIALLY-ATOMIC flow at all**: EOD finalization (RES-3) is now a single `db.transaction`, and the payout-failure path reverses the debit atomically (RES-P2-1).
- **Uncertainty is represented explicitly** where an external provider outcome is unknown: payout submission uses a stable idempotency key and reconciles rather than re-submitting; provider events are deduped and terminal states are never moved backward (`payout-operations.ts`).
- **Restart recovery**: all authority is in Postgres. Sweeps (`retryPendingProvisioning`, `certifyPassedEvaluations`, `fundEligibleQualifications`, `runInactivitySweep`) re-drive interrupted lifecycle work from database truth on startup. No critical correctness depends on volatile memory (the in-process mutex is a latency optimization backed by the Postgres advisory lock for cross-process safety).
- **Detection**: `platform/resilience/integrity-checks.ts` (`runIntegrityChecks`) detects, after the fact, any divergence these flows are meant to prevent (over-cap, >5 paid cycles, duplicate funded/reset successor, floor regression, phantom position, payout/ledger mismatch). Detection only — no auto-repair.
