# FINANCIAL INVARIANTS

**Phase 9 — money / payout / reconciliation hardening.** The dollar-equivalent
invariants Happy Trader must never violate, and the deterministic test that proves each.

Baseline HEAD: `9887d8e` (Phase 8) · Compiled 2026-09-26 ·
branch `claude/futures-trading-simulator-v8qefu`.

> **Scope.** Money is integer **micro-dollars** everywhere ($1 = 1,000,000 µ$); there is no
> binary floating-point money representation to drift. Settlement is **dev/test/mock only** —
> production commerce/identity/payout remain fail-closed (Phase 4). Nothing here is
> PRODUCTION-VERIFIED. "Software ready" is tracked separately from "provider ready".

---

## Financial definitions (do not blur these)

| Term | Meaning | Source |
|---|---|---|
| **Purchase amount** | What the customer pays for an evaluation (server/provider-authoritative) | `commerce.ts` `createPendingOrder`; price from pinned product version |
| **Gross eligible / requested** | The program distribution basis a payout is computed on | `payout-core.ts` `grossWithdrawableMicros`, capped by product cap ∧ 50%-profit ∧ family rule |
| **Trader share** | 90% of gross, banker's-rounded | `splitAccounting(gross, 0.9).traderShareMicros` = `roundHalfEven(gross × 0.9)` |
| **Firm share** | Exact integer complement (gross − trader) | `splitAccounting(...).firmShareMicros` |
| **Account debit** | Full **gross** removed from the funded account on payout | `splitAccounting(...).balanceAdjustmentMicros === gross` |
| **Provider settlement** | The trader share actually paid out (dev/test bookkeeping) | `payout-operations.ts` `submitPayable`/`markPaid` |
| **Refund amount** | Returned purchase (ordinary: only if no trade) | commerce refund path |
| **Currency** | **USD only**, integer micro-dollars | `packages/*` money helpers |
| **Rounding** | **round-half-even** (banker's) on the trader share; firm share is the exact remainder | `payout-core.ts` `roundHalfEven` |

---

## The invariants (each mapped to its proving test)

Legend: **PROVEN** = a deterministic test asserts it.

| # | Invariant | Proven by |
|---|---|---|
| 1 | One trusted purchase event → **exactly one** commercial account | `golden-path.core50k.test.ts` (order→one eval; replay no-dup); `commerce.test.ts` |
| 2 | A commercial account carries its purchase/entitlement lineage | `golden-path.core50k.test.ts`; `commerce.test.ts` |
| 3 | Duplicate payment event → **no** duplicate economic effect | `commerce.test.ts` (event dedup); golden-path replay |
| 4 | A refund cannot execute twice | `commerce.test.ts` refund idempotency |
| 5 | Refund cannot exceed the refundable amount; server-authoritative eligibility | `commerce.test.ts` |
| 6 | One payout request cannot settle twice | `payout-operations.test.ts` (settlement idempotency) |
| 7 | One provider settlement maps to one payout request | `payout-operations.test.ts` |
| 8 | A PAID payout has **exactly one** authoritative financial/account effect | `golden-path.core50k.test.ts` (single DEBIT); `payout-operations.test.ts` |
| 9 | A non-PAID payout is never treated as completed cash | `payout-operations.test.ts` state machine |
| 10 | trader share + firm share **== gross** (money conserved) | **`financial-invariants.test.ts`** (matrix of gross values) |
| 11 | Simulated account debit **== gross** (full-gross debit semantics) | **`financial-invariants.test.ts`**; `golden-path.core50k.test.ts` (floor/balance invariant) |
| 12 | Payout cycle count increments **exactly once** per PAID | `golden-path.core50k.test.ts`; `payout-core.test.ts` (MAX_PAYOUT_CYCLES counted by PAID rows) |
| 13 | Failed/rejected/cancelled payout does **not** increment the cycle count | `payout-operations.test.ts`; `payout-core.test.ts` |
| 14 | Payout certificate issues only after authoritative PAID | `golden-path.core50k.test.ts` |
| 15 | Account completes only after the correct **5th** PAID cycle | `payout-core.test.ts` (MAX_PAID_PAYOUT_CYCLES=5) |
| 16 | An account cannot spend the same eligible profit twice | `payout-core.test.ts`; `golden-path.core50k.test.ts` (single debit, floor unchanged) |
| 17 | Concurrent payout requests cannot over-withdraw (advisory lock + CAS) | `payout-core.test.ts`; `payout-operations.test.ts` |
| 18 | Product payout cap always derives from the **pinned** version | `product-matrix.runtime.test.ts`; `payout-core.test.ts` |
| 19 | Historical account uses historical pinned terms | `product-reconcile.test.ts`; `product-matrix.runtime.test.ts` |
| 20 | No browser-provided amount is financially authoritative | `payout-core.test.ts`; `self-serve-boundary.test.ts` (HTF-21) |
| 21 | Every financial mutation is auditable (hash-chained) | `admin.test.ts` audit-chain; `audit.ts` |
| 22 | Reconciliation mismatch is **visible**, never silently repaired | `payout-operations.test.ts` reconciliation verdicts |
| 23 | Retrying a timed-out financial command → no second effect (idempotency keys) | `payout-operations.test.ts`; `commerce.test.ts` |
| 24 | Crash between provider action and local ack is recoverable without blind re-pay (lost-ack → `SUBMISSION_UNKNOWN`/reconciliation) | `payout-operations.test.ts` (lost-ack) |
| + | 90/10 split uses **round-half-even**; no FP drift; whole-µ$ shares | **`financial-invariants.test.ts`** (23 tests) |
| + | Representative CORE 50K trace reconciles to **$0.00** unexplained delta | `golden-path.core50k.test.ts` |

---

## Phase 9 repairs (root-caused, not worked around)

- **Audit-chain concurrency (was the long-standing "audit chain intact under concurrent actions"
  failure).** Root cause: the hash chain was ordered by `(createdAt, id)` where `id` is a **random
  UUID**; two audit appends in the same millisecond (a concurrent burst, serialized by the per-org
  advisory lock) tied on `createdAt`, and the random-UUID tie-break made the verify scan's ordering
  disagree with the true chain linkage → a **false** corruption report. Fix (`audit.ts`): each
  chain row's `createdAt` is now **strictly greater** than its predecessor's, so ordering is a total
  order matching linkage and the tie-break never decides. The concurrency test passes deterministically
  in isolation (3/3) on a clean DB. *(Known test-infra limitation: a single combined run of ~13 DB
  suites shares one default-org audit chain, and the whole-history verify becomes sensitive to that
  cross-suite accumulation; this is test isolation, not a money/audit defect — run the audit-chain
  test in isolation, or on a fresh DB, for a clean signal. Analogous to the golden-path cold-DB
  timeout.)*
- **Payout-operations "append-only / idempotent on (provider, event id)".** Root cause: a **test**
  defect — the assertion queried the literal `providerEventId = 'dup_evt_1'` while the rows were
  ingested as `dup_evt_1_${rid}`; it only "passed" on the polluted shared DB because a stale row from
  an older test run happened to match the literal. Fix: query the actual interpolated id. The
  production `ingestProviderEvent` idempotency was correct all along; the assertion now proves it
  DB-independently (passes on both clean and polluted DBs).

Both were the two pre-existing failures carried forward since Phase 4. **Neither was a money-integrity
defect**; both are now resolved with deterministic, un-weakened assertions.

---

## What remains external (not software)

Real customer payments, real KYC, and a real payout rail remain **UNCONFIGURED / fail-closed**
(Phase 4). Dev/test settlement (`markPaid`, `meta.mock=true`) can never create a real-money PAID in
production. **Software financial integrity ≠ provider production readiness** — the provider gates are
Phases C/D/E of the master plan.

## PROVENANCE

Invariants compiled from `payout-core.ts`, `payout-operations.ts`, `commerce.ts`, `provisioning.ts`,
`audit.ts`, and `@atlas/contracts`, each mapped to the deterministic suite that asserts it. The two
Phase 9 repairs were reproduced (clean vs polluted DB), root-caused, fixed, and re-verified. No real
provider was connected; nothing is PRODUCTION-VERIFIED.
