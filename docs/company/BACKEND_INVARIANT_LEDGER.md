# Backend Invariant Ledger

**Engineering Resilience Phase 1** · Adversarial backend / failure engineering
**Base commit:** `b48ba7e` (`engineering-resilience-phase1-start`)
**Date:** 2026-09-29

This is the catalogue of properties that must **never** become false in the authoritative backend, each with where it is enforced, how, and the evidence that proves it. Severity is what a violation *would* be (see `PRODUCT_READINESS`/report). All money is integer micro-dollars.

Legend — **Guard**: ADVISORY-LOCK (`pg_advisory_xact_lock`), FOR-UPDATE (row lock), UNIQUE (unique index + `onConflictDoNothing`+reread), VERSION (optimistic `expectedVersion` CAS), STATE (state-machine early-return), COMPOSITION (enforced by call ordering). **Status**: ✅ proven, ⚠️ holds but defense-in-depth gap, 🚩 flagged finding.

---

## IDENTITY & OWNERSHIP

| # | Invariant | Enforced at | Guard | Status / Evidence |
|---|---|---|---|---|
| ID-1 | One authenticated identity cannot operate another customer's account | `portal.ts assertOwned`, `trading.ts assertOwnership`, `payouts.ts requireOwnAccount` | server ownership check (`row.userId !== userId → 404`, no oracle) | ✅ `portal.routes.test.ts`, `trading-authz-http.test.ts`, `golden-path.security.test.ts`, `owner-isolation.test.ts` |
| ID-2 | Ownership is server-side; no client-supplied owner/customer id is trusted | same | id compared to session user, never request body | ✅ same |
| ID-3 | Owner/staff role read from DB, not the token claim | `auth-plugin.ts requireRole`, `owner-plugin.ts requirePermission` | DB re-read of role+status | ✅ `rbac.test.ts`, `m10-1-reauth-impersonation.test.ts` |

## ACCOUNT LIMIT

| # | Invariant | Enforced at | Guard | Status / Evidence |
|---|---|---|---|---|
| AC-1 | No identity exceeds MAX_ACTIVE_ACCOUNTS (5) active (EVAL/FUNDED_SIM, ACTIVE\|PENDING, un-archived) | `account-limit.ts assertActiveSlotAvailable` inside `provisioning.ts` txn | ADVISORY-LOCK (per-user) + count, in the same txn as the INSERT | ✅ `account-limit.test.ts` (4-concurrent); **new** `resilience-races.test.ts` (2/5/20-concurrent → never 6) |
| AC-2 | Concurrent qualifying purchases cannot create account 6 | `commerce-fulfillment.ts` → enforced provision | same advisory lock; blocked purchase parks recoverably (`PROVISION_BLOCKED`) | ✅ `account-limit.test.ts:176`, `resilience-races.test.ts` |
| AC-3 | Funding a pass is slot-neutral (eval frozen PASSED before funded insert) | `commerce.ts approveFunding` | freeze-then-insert ordering | ✅ `commerce-funding.test.ts` |

## MONEY

| # | Invariant | Enforced at | Guard | Status / Evidence |
|---|---|---|---|---|
| MON-1 | No floating-point money corruption (integer micro-dollars everywhere) | `@atlas/instruments math.ts`, position reducer | integer arithmetic; `ticksToMicros` the single P&L path | ✅ `money-oracle.test.ts`, `pnl-reconciliation.test.ts`, `position.test.ts`, `no-fabrication.test.ts` |
| MON-2 | A payout debits exactly its authoritative ledger effect, once | `payouts.ts approvePayout` | STATE early-return + VERSION + ADVISORY-LOCK + UNIQUE `payout_ledger(request,DEBIT)` | ✅ `payouts.test.ts:199`, `golden-path.core50k.test.ts` |
| MON-3 | No retry creates money; failed txn changes no financial state partially | payout + provisioning txns | atomic txns; unique ledger index | ✅ `payout-ops-torture.test.ts`, `m10-1-money-safety.test.ts` |
| MON-4 | Every balance-changing op has traceable provenance | `payoutLedger` (append-only, trigger-enforced), `adminAdjustments` | append-only ledger + audit | ✅ `m10-1-money-safety.test.ts`; integrity checks `PAYOUT_LEDGER_ARITHMETIC`, `APPROVED_PAYOUT_WITHOUT_DEBIT` |
| MON-5 | A definitively-failed payout returns the debited money (no stranded debit) | `payout-operations.ts failPayout` | one txn: balance restore + UNIQUE `payout_ledger(request,REVERSAL)` + state→FAILED, idempotent | **RES-P2-1 (Phase 2)**: before this phase a provider FAILURE left the balance debited with no REVERSAL — money stranded, undetectable. Now reversed atomically. Proven by `payout-reversal-crash.test.ts`; detected by integrity `FAILED_PAYOUT_DEBIT_NOT_REVERSED`. |

## ORDERS / POSITIONS

| # | Invariant | Enforced at | Guard | Status / Evidence |
|---|---|---|---|---|
| ORD-1 | One client intent → one order (retry/double-click/reconnect safe) | `engine.ts submitLocked` | UNIQUE `orders(accountId,clientOrderId)` + ADVISORY-LOCK; dedup returns existing | ✅ `idempotency.test.ts` |
| ORD-2 | Stale modify rejected | `engine.ts modifyLocked` | VERSION (`expectedVersion`, **opt-in**) | ⚠️ `adversarial.test.ts`; opt-out if client omits version (RES-2) |
| ORD-3 | Rejected/canceled order cannot alter a position | `submitLocked` (reject before insert), matcher loads only open orders | STATE | ✅ `adversarial.test.ts`, `execution.test.ts` |
| ORD-4 | Position state equals authoritative executions | `matchLocked` single txn; `applyFill` reducer | ATOMIC (one txn) | ✅ `position.test.ts`, `pnl-reconciliation.test.ts`; **new** integrity `PHANTOM_POSITION` |
| ORD-5 | Account A execution never mutates Account B | per-account lock + `positions(accountId,symbol)` unique + `eq(accountId)` everywhere | structural | ✅ `bracket-reconnect-isolation.test.ts`, `execution-races.test.ts` |
| ORD-6 | OCO: a sibling never survives its partner's fill; no double-exit; no accidental reverse | pure matcher `matching.ts` same pass; `syncBrackets` reconciles to live position | ATOMIC in match pass | ✅ `execution.test.ts`, `stress.test.ts` (5000 seeds), `brackets.test.ts` |

## RISK

| # | Invariant | Enforced at | Guard | Status / Evidence |
|---|---|---|---|---|
| RSK-1 | Risk enforced before prohibited exposure becomes authoritative | `engine.ts submitLocked` (firm gate → personal → hold, then insert) | COMPOSITION under mutex+txn | ✅ `personal-risk-gate.test.ts`, `adversarial.test.ts` |
| RSK-2 | Personal controls cannot weaken firm rules | `engine.ts` (firm `checkOrder` first; personal can only add a rejection) | COMPOSITION | ✅ `personal-risk-gate-extra.test.ts` E05/E06 |
| RSK-3 | Stale personal-control write rejected | `personal-risk.ts upsertPersonalControl` | FOR-UPDATE + VERSION (**opt-in**) | ⚠️ `personal-risk.crud.test.ts` C07; opt-out if version omitted (RES-2) |
| RSK-4 | Locked control cannot be loosened/removed via API | `personal-risk.ts` (LOCKED tighten-only block, server-side) | STATE under FOR-UPDATE | ✅ `personal-risk.crud.test.ts` C05/C06 |
| RSK-5 | Terminal accounts (FAILED/PASSED/LOCKED/…) admit no new exposure; liquidation exempt | `risk.ts checkOrder` account-state gate | STATE | ✅ `adversarial.test.ts:311`, `risk.ts` |
| RSK-6 | Enforcement hold / kill switch blocks exposure-increasing orders | `engine.ts checkEnforcementHold`, `kill-switches.ts` | STATE | ✅ `enforcement-integration.test.ts`, `kill-switch-enforcement.test.ts` |
| RSK-7 🚩 | The firm/personal **contract cap** bounds working orders, not only the position | `risk.ts checkOrder` (`projected = openContracts + weight`, position-only) | — | 🚩 **RES-1**: working/resting orders are NOT counted at submit and there is no fill-time cap, so stacked resting limit orders can fill to a position beyond the cap. Product decision required (does "max N contracts" bound working orders?). Not money-dup/cross-customer; bounded; simulated. **P2.** |

## DRAWDOWN / EOD

| # | Invariant | Enforced at | Guard | Status / Evidence |
|---|---|---|---|---|
| DD-1 | EOD trailing floor ratchets only on a finalized day and never regresses | `packages/core rules.ts advanceDrawdown/rollTradingDay` (`Math.max`) | monotonic by construction | ✅ `eod-trailing-lock.test.ts`, `rules.test.ts`, `eod-trailing-engine.test.ts`; **new** integrity `DRAWDOWN_FLOOR_ABOVE_HWM` |
| DD-2 | Day finalization is idempotent (no double winning-day / double ratchet) | `rules.ts rollTradingDay` (date short-circuit) + `recordClosedDay` upsert + absolute-set counters | UNIQUE `daily_stats(account,date)` + idempotent recompute | ✅ `golden-path.core50k.test.ts`; **RES-3 RESOLVED (Phase 2)**: `recordClosedDay`+`persistRuleState` now run in ONE `db.transaction` (`engine.ts rulesLocked`) — no partial-day window. Proven by `engine-atomicity.test.ts` (fault → neither written; replay idempotent). |
| DD-3 | Winning day counts once per session day at the authoritative threshold ($150) | `rules.ts` (`net ≥ minWinningDayPnl`, from config) | canonical config | ✅ `payout-boundaries-service.test.ts`, `golden-path.core50k.test.ts` |

## LIFECYCLE / FUNDED / RESET

| # | Invariant | Enforced at | Guard | Status / Evidence |
|---|---|---|---|---|
| LC-1 | An account cannot occupy contradictory lifecycle states | account status column + transition guards | STATE | ✅ `portal-lifecycle.test.ts`, engine state gate |
| LC-2 | One evaluation pass → exactly one funded account | `commerce.ts certify/approveFunding` | FOR-UPDATE + ADVISORY-LOCK + UNIQUE `account_qualifications(account,life)` + idem key `fund:<qualId>` | ✅ `commerce.test.ts:464`, `commerce-funding.test.ts`; **new** integrity `DUPLICATE_FUNDED_SUCCESSOR` |
| LC-3 | One failed account → at most one reset successor; failed account preserved | `account-reset.ts` + `commerce.ts` | idem key `reset:<failedAccountId>` (UNIQUE order key) + entitlement uniqueness + **DB partial unique index** | ✅ `portal-lifecycle.test.ts`; `resilience-races.test.ts` (8-concurrent → 1 successor); `crash-recovery.test.ts` (crash → ≤1, retry → 1). **RES-4 RESOLVED (Phase 2)**: partial unique index `accounts_reset_of_key WHERE reset_of_account_id IS NOT NULL` (migration 0036) now fails a second successor closed at the DB. Integrity `DUPLICATE_RESET_SUCCESSOR` retained as defense-in-depth. |

## PAYOUTS

| # | Invariant | Enforced at | Guard | Status / Evidence |
|---|---|---|---|---|
| PAY-1 | One payout paid at most once | `payouts.ts approve/markPaid`, `payout-operations.ts` | STATE + UNIQUE `payout_ledger(request,entryType)` + provider-event dedup | ✅ `payouts.test.ts`, `payout-ops-torture.test.ts` |
| PAY-2 | Two simultaneous requests cannot jointly exceed available capacity | `payouts.ts requestPayout/approvePayout` | ADVISORY-LOCK + FOR-UPDATE + re-verify eligibility; one-pending guard | ✅ `payouts.test.ts:199`, `payout-daily-progression.test.ts` |
| PAY-3 | ≤ 5 PAID cycles; cycle 5 → COMPLETED; cycle 6 never paid | `payout-core.ts MAX_PAYOUT_CYCLES` + approval guard + `markPaid` completion | STATE under ADVISORY-LOCK (blocked at approval before a 6th) | ✅ `payout-daily-progression.test.ts:281`; **new** integrity `PAID_PAYOUT_CYCLES_OVER_MAX` |
| PAY-4 | Split is exact (90/10), firm absorbs rounding, no money lost | `payout-core.ts splitAccounting` | integer split | ✅ `payout-core.property.test.ts`, `financial-invariants.test.ts` |

## AUDIT / EVENTS

| # | Invariant | Enforced at | Guard | Status / Evidence |
|---|---|---|---|---|
| AUD-1 | Security/money ops are traceable; no false success for a rolled-back op | `audit.ts recordAudit` (hash-chained, advisory-locked) | append-only + advisory lock; audit written after commit | ✅ `audit-chain-stress.test.ts`; ⚠️ personal-control chain audit is best-effort post-commit (durable event still in-txn) — RES-5, P3 |
| EVT-1 | Business state does not depend on exactly-once delivery | `outbox.ts` + idempotent projection consumer | at-least-once + idempotent recompute (`FOR UPDATE SKIP LOCKED`) | ✅ `projection-outbox.test.ts` |

---

## Findings opened this phase

| ID | Severity | Invariant | Disposition |
|---|---|---|---|
| RES-1 | P2 | RSK-7 — contract cap vs working orders | Product decision (does "max N" bound working orders?); characterized, **not** changed. **Unchanged in Phase 2 & Phase 3.** Phase 3 quantified the exact mechanism, blast radius (bounded, single-account, no money-duplication, P&L still reconciles) and fix requirements in `RES1_CONTRACT_LIMIT_ANALYSIS.md`. |
| RES-2 | P3 | ORD-2 / RSK-3 — optional `expectedVersion` | By design; document. Server row-lock still serializes; only conflict *detection* is opt-out. |
| RES-3 | ✅ FIXED (Phase 2) | DD-2 — EOD two-write non-atomic | **RESOLVED**: `recordClosedDay`+`persistRuleState` now one `db.transaction`. `engine-atomicity.test.ts`. |
| RES-4 | ✅ FIXED (Phase 2) | LC-3 — `resetOfAccountId` no unique index | **RESOLVED**: partial unique index `accounts_reset_of_key` (migration 0036). Fail-closed proof in `resilience-races.test.ts`. |
| RES-5 | P3 | AUD-1 — personal-control chain audit best-effort | Durable in-txn `traderRiskControlEvents` row IS the authoritative record (atomic) — no mutation is unrecorded. Chain audit stays best-effort; future: deliver via outbox. |
| RES-P2-1 | ✅ FIXED (Phase 2); P2 today / P1 at launch | MON-5 — failed payout left balance debited with no reversal | **RESOLVED**: `failPayout` reverses the debit atomically (balance restore + REVERSAL, idempotent). New detector `FAILED_PAYOUT_DEBIT_NOT_REVERSED`. `payout-reversal-crash.test.ts`. |
| PV2-G1 | — (fixed Phase 1) | test determinism | Fixed via test-mode scrypt work factor; **mechanically proven isolated in Phase 2** (`test-mode-security.test.ts`). |

**No P0 or P1 invariant was found false in Phase 1 or Phase 2.** Phase 2 fixed two real
data-integrity defects at the root (RES-3, RES-P2-1) and added one DB-level guarantee (RES-4).
