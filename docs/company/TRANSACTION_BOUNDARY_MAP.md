# Transaction Boundary Map

**Engineering Resilience Phase 1** · Base `b48ba7e` · 2026-09-29

For each critical workflow: the authoritative transaction boundary, the locks / version guards / idempotency keys inside it, and its atomicity/idempotency classification. Derived from direct code inspection (file:line). All money is integer micro-dollars.

**Classes:** ATOMIC (one DB txn, all-or-nothing) · IDEMPOTENT (safe to repeat, converges to one result) · PARTIALLY-ATOMIC (>1 write not in a single txn, but self-healing) · SERVER-ENFORCED (guarded server-side, not client).

---

## Provisioning & lifecycle

| Workflow | Authority | Boundary mechanics | Class |
|---|---|---|---|
| **Purchase → provision** | `commerce.ts`, `commerce-fulfillment.ts`, `provisioning.ts` | event ledger UNIQUE `(provider,eventId)` → order `FOR UPDATE`+status guard + UNIQUE `(org,idemKey)` → entitlement UNIQUE `(order,kind)` → consume `FOR UPDATE`+`consumedByAccountId` guard + provisioning-request UNIQUE `(org,idemKey)`. All in `db.transaction`. | ATOMIC + IDEMPOTENT |
| **Active-cap enforcement** | `account-limit.ts` in `provisioning.ts` txn | per-user `pg_advisory_xact_lock` → count → INSERT, one critical section. Opt-in `enforceActiveLimit` (set by `provisionFromEntitlement`). | ATOMIC (enforced path) |
| **Reset** | `account-reset.ts`, `commerce.ts` | fixed idem key `reset:<failedAccountId>` (UNIQUE order key) → RESET entitlement UNIQUE `(order,kind)` → provision writes `resetOfAccountId` idempotently. | IDEMPOTENT (order key) |
| **Eval → funded** | `commerce.ts certifyEvaluation`+`approveFunding` | certify: advisory lock + account `FOR UPDATE` + UNIQUE `account_qualifications(account,life)`. fund: qualification `FOR UPDATE` + `fundedAccountId` guard + idem key `fund:<qualId>`. | ATOMIC + IDEMPOTENT |

## Trading

| Workflow | Authority | Boundary mechanics | Class |
|---|---|---|---|
| **Order submit** | `engine.ts submitLocked` | `mutex.run(accountId)` = in-process mutex + `pg_advisory_lock`. Dedup SELECT `(accountId,clientOrderId)` (UNIQUE backstop) → gates (era, firm `checkOrder`, personal risk, enforcement hold) → INSERT. | IDEMPOTENT + ATOMIC |
| **Order cancel** | `engine.ts cancelLocked` | under lock; `isOpen` state guard (a FILLED order can't cancel). | ATOMIC |
| **Order modify** | `engine.ts modifyLocked` | under lock; VERSION `expectedVersion` guard (opt-in). | ATOMIC (version opt-in) |
| **Execution → position** | `engine.ts matchLocked` | ONE `db.transaction`: orders + position upsert `(accountId,symbol)` + executions (+seq) + trades + day-state + balance settle + outbox enqueue. | ATOMIC |
| **OCO / bracket** | matcher `matching.ts` + `engine.ts syncBrackets` | sibling cancel/reduce in the same match pass, persisted in the same match txn; legs reconciled to live position; idempotent across restart via stored `bracketConfig`/client-id keys. | ATOMIC (per pass) + IDEMPOTENT (restart) |

## Payouts

| Workflow | Authority | Boundary mechanics | Class |
|---|---|---|---|
| **Payout request** | `payouts.ts requestPayout` | one txn; account advisory lock + `FOR UPDATE`; idem-key lookup; one-pending guard (`ALREADY_PENDING`); moves no money. | ATOMIC + IDEMPOTENT |
| **Payout approval (the debit)** | `payouts.ts approvePayout` | one txn; request `FOR UPDATE` + STATE early-return + VERSION CAS + account advisory lock + re-verify eligibility; single balance debit + UNIQUE `payout_ledger(request,DEBIT)`. | ATOMIC + IDEMPOTENT |
| **Payment / PAID** | `payouts.ts markPaid`, `payout-operations.ts` | `FOR UPDATE` + `if PAID return`; UNIQUE `(request,SETTLEMENT)`; provider events UNIQUE `(provider,eventId)`; stable idem key never regenerated; lost-ACK → reconcile not re-submit. | IDEMPOTENT |
| **Cycle 5 → COMPLETED** | `payouts.ts markPaid` | approved-count ≥ 5 blocks a 6th at approval (earlier than PAID); COMPLETED set under `status != COMPLETED` guard. | ATOMIC + IDEMPOTENT |
| **EOD finalization** | `engine.ts rulesLocked` → `recordClosedDay` + `persistRuleState` | date short-circuit makes roll idempotent; day stat upsert UNIQUE `(account,date)`; counters written as absolute recomputed values. **Two awaits, not one txn** (per-process mutex only). | IDEMPOTENT, **PARTIALLY-ATOMIC** (RES-3; self-heals on replay) |

## Risk / enforcement / audit

| Workflow | Authority | Boundary mechanics | Class |
|---|---|---|---|
| **Personal-control mutation** | `personal-risk.ts upsertPersonalControl` | one txn; control `FOR UPDATE` + VERSION CAS (opt-in) + LOCKED tighten-only block; durable event in-txn; hash-chain audit best-effort post-commit. | ATOMIC + SERVER-ENFORCED (audit hookup best-effort, RES-5) |
| **Enforcement action / hold** | `enforcement.ts`, `enforcement-holds.ts` | recorded + audited; order path re-checks holds under the account lock. | SERVER-ENFORCED |
| **Audit chain** | `audit.ts recordAudit` | append-only, per-org hash chain under `pg_advisory_xact_lock`; DB rejects UPDATE/DELETE. | ATOMIC + tamper-evident |
| **Outbox delivery** | `outbox.ts` | claim `FOR UPDATE SKIP LOCKED`, handler + delivered-mark commit together; consumer idempotent (recompute from authority). | ATOMIC(claim) + IDEMPOTENT |

---

## Dangerous / noteworthy boundaries

- **EOD `recordClosedDay` + `persistRuleState`** (`engine.ts`) are separate awaits, not a single transaction (RES-3). A crash between them leaves the day stat written but the account counters un-advanced; the next revaluation replays the roll idempotently (absolute-set counters + upsert), so it self-heals — but there is a genuine partial-write window. Recommend wrapping in one `db.transaction` in a later phase. Not a money boundary.
- **Order submit dedup** relies on the `pg_advisory_lock` for cross-process atomicity of the SELECT-then-INSERT; the UNIQUE `orders(accountId,clientOrderId)` is the backstop (a duplicate that raced without the lock throws on the index rather than returning the idempotent result). Production always holds the lock.
- **`resetOfAccountId` / `fundedAccountId`** are not unique-indexed; their 1:1 invariants are enforced by idempotency keys + row locks, not by a DB constraint (RES-4 recommends a partial unique index for reset as defense-in-depth). The new integrity checks detect a violation if one ever occurs.

No workflow was found NON-IDEMPOTENT where idempotency is required, and no money workflow is PARTIALLY-ATOMIC.
