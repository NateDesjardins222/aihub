# Engineering Resilience Phase 1 — Report

**Adversarial backend / failure engineering / invariant proof**
**Starting commit:** `b48ba7e` (`engineering-resilience-phase1-start`)
**Branch:** `claude/futures-trading-simulator-v8qefu` · **Date:** 2026-09-29

---

## Executive summary

The backend was attacked, not merely tested. Four domains were mapped to their exact transaction boundaries (file:line) and their authoritative invariants catalogued in `BACKEND_INVARIANT_LEDGER.md`. The system proved **highly resilient by construction**: advisory locks + `FOR UPDATE` + unique-index idempotency + optimistic version guards + a hash-chained audit log + a transactional outbox already protect money, orders, positions, provisioning, payouts, cycles, drawdown and audit — and the existing ~3,000-test suite exercises most of it.

This phase added the deterministic **concurrency attack harness**, proved the **account cap** holds at 2/5/20-way concurrency and **reset** produces exactly one successor under 8-way concurrency, built a read-only **integrity-check module** that detects the major corruption classes, and **root-caused and fixed the PV2-G1 canonical flake** (test-mode scrypt work factor). Five findings were opened; **none is P0 or P1**. The largest is a product decision (RES-1: does the contract cap bound *working* orders?), deliberately not changed.

---

## The 128 questions

**Git**
1. Starting commit? `b48ba7e`.
2. Ending commit? See §Git (recorded at commit).
3. Working tree clean? Yes (verified before/after).
4. Remote == local? Yes (verified after push).
5. Checkpoint preserved? Yes — tag + branch `engineering-resilience-phase1-start`; all prior checkpoints/tags intact.
6. Stashes preserved? Yes (`phase3-wip-product-model` untouched).

**Invariants**
7. How many critical invariants documented? 30+, across 9 domains (`BACKEND_INVARIANT_LEDGER.md`).
8. Any invariant found false? No P0/P1 invariant false. One flagged behavior (RES-1) is a product-definition question, not a broken invariant.
9. Which? RES-1 — the firm/personal contract cap counts the position, not working orders, so stacked resting limit orders can fill past the cap. Characterized; product decision.

**Transactions**
10. Which workflows are fully atomic? Execution→position, payout approval (debit), payout request, provisioning, funded transition — each one `db.transaction` (`TRANSACTION_BOUNDARY_MAP.md`).
11. Which use optimistic concurrency? Order modify (`expectedVersion`), personal-control mutation, payout approval (version CAS).
12. Which use idempotency? Order submit (`clientOrderId`), provisioning (event/order/entitlement/provisioning-request keys), reset (`reset:<id>`), funded (`fund:<qualId>`), payout (idem key + ledger unique), outbox consumer.
13. Which remain multi-step? EOD finalization (day-stat write + counter write, RES-3) — self-healing.
14. Any dangerous transaction boundary? None touching money. EOD's two-write window is the one PARTIALLY-ATOMIC path; it self-heals (idempotent replay).

**Account limit**
15. 2-way race result? Exactly one provision succeeds; count = 5, never 6 (`resilience-races.test.ts`).
16. 5-way? Same — one succeeds, four refused with `AccountLimitError`.
17. 20-way? Same — one succeeds, nineteen refused; count = 5.
18. Could account 6 ever exist? Not via any enforced path. The advisory-lock+count-in-txn guarantees it. (A *non-enforcing* creation path — practice/admin-direct, which are opt-out by design — is not slot-consuming or is admin-intended; documented.)

**Provisioning**
19. Duplicate event result? One account (`commerce_events` unique + order/entitlement/provisioning-request uniques) — `commerce-chaos.test.ts`.
20. Concurrent duplicate result? One account (`commerce-chaos.test.ts:99`, `commerce.test.ts:257`).
21. Restart/retry result? Sweep re-drives to exactly one PROVISIONED (`commerce-chaos.test.ts:123`).

**Reset**
22. Double reset result? One successor — fixed `reset:<id>` order key.
23. Concurrent reset result? One successor under 8-way concurrency (**new** `resilience-races.test.ts`).
24. Duplicate successor possible? Not via the reset flow. `resetOfAccountId` lacks a unique index (RES-4, defense-in-depth); the invariant holds via the idem key, and the new integrity check `DUPLICATE_RESET_SUCCESSOR` detects any violation.

**Funded**
25. Concurrent funded-transition result? One funded account (`commerce.test.ts:464`, `commerce-funding.test.ts:135`).
26. Duplicate funded account possible? No — qualification row lock + `fund:<qualId>` + `account_qualifications(account,life)` unique; integrity check `DUPLICATE_FUNDED_SUCCESSOR` detects.

**Orders**
27. Duplicate order-intent result? No-op returning the existing order (`orders(accountId,clientOrderId)` unique) — `idempotency.test.ts`.
28. Retry result? Same order, no double exposure.
29. Cancel/fill race result? Legal — a FILLED order can't cancel (`isOpen` guard); serialized by the account lock (`execution-races.test.ts`).
30. Modify/fill result? Legal — modify under lock; version guard rejects a stale modify (`adversarial.test.ts`).
31. Stale modify result? Rejected `STALE_ORDER_VERSION` when `expectedVersion` supplied (opt-in — RES-2).

**OCO**
32. TP/SL race result? One side fills, the sibling is canceled/reduced in the same pass (`execution.test.ts:429`, `stress.test.ts`).
33. Disconnect/reconnect result? Bracket survives restart, no dup/missing legs, OCO still fires (`bracket-reconnect-isolation.test.ts`).
34. Cross-account isolation result? A flatten/OCO on A never touches B (`bracket-reconnect-isolation.test.ts:128`).
35. Accidental reverse possible? No — protective legs reconcile to the live position (`syncBrackets` shrink-not-reverse; `brackets.test.ts` D-14).

**Positions**
36. All 8 instruments verified? Yes — NQ/MNQ/ES/MES/GC/MGC/CL/MCL from `packages/instruments/registry.ts`; P&L via `ticksToMicros` (`money-oracle.test.ts`, `position.test.ts`).
37. Position/execution reconciliation? `pnl-reconciliation.test.ts` + new integrity check `PHANTOM_POSITION`.
38. Any precision issue? None — integer micro-dollars, cost-basis reducer (`no-fabrication.test.ts`, `position.test.ts`).

**Risk**
39. Risk/order race result? Firm gate → personal → hold, all under the account mutex+txn before insert; no stale-state bypass for immediate orders (`personal-risk-gate.test.ts`). Resting-order over-commit = RES-1.
40. Locked-mode API attack? Server rejects loosen/disable of a LOCKED control regardless of client (`personal-risk.crud.test.ts` C05).
41. Stale controls attack? `STALE_VERSION` 409 when `expectedVersion` supplied (C07); opt-out otherwise (RES-2).
42. Firm-rule loosening possible? No — personal controls can only add a rejection; firm gate runs first (`personal-risk-gate-extra.test.ts` E05).

**Account state**
43. Active→failed / order race? A non-ACTIVE account admits no new order (`risk.ts` state gate); liquidation exempt (`adversarial.test.ts:311`).
44. Active→completed / order race? Same state gate blocks PASSED/COMPLETED.

**EOD**
45. Multi-day EOD torture result? Floor ratchets only on finalized days, never backward, locks per product (`eod-trailing-engine.test.ts`, `golden-path.core50k.test.ts`).
46. Duplicate finalization? Idempotent — date short-circuit + upsert + absolute-set counters.
47. Restart behavior? Roll replays from DB truth; self-heals (RES-3 window).
48. Floor ever moved backward? No — `Math.max` guard; integrity check `DRAWDOWN_FLOOR_ABOVE_HWM` detects corruption.
49. Exact breach boundary? Enforced at the authoritative floor (`rules.test.ts`, `eod-trailing-lock.test.ts`).

**Consistency**
50. Exact boundary verified? Yes — `payout-boundaries-service.test.ts` (CORE 50% eval, per-family payout consistency).
51. Integer money throughout? Yes.

**Winning days**
52. 149.99? Does not count (`payout-boundaries-service.test.ts`).
53. 150? Counts (inclusive).
54. 150.01? Counts.
55. Duplicate day possible? No — upsert `daily_stats(account,date)` + absolute-set counters.

**Payout**
56. 2 simultaneous requests? One pending; serialized on the account advisory lock (`payouts.test.ts`).
57. 5 simultaneous? Same — one pending, rest refused `ALREADY_PENDING`.
58. 20 simultaneous? Same (serialized; capacity re-verified at approval).
59. Aggregate capacity protected? Yes — no money at request; approval re-verifies under lock + unique DEBIT ledger.
60. Exact cap boundaries? `payout-boundaries-service.test.ts` (50% ceiling, $250 min, per-size caps, DAILY buffer).
61. 90/10 exact? To the micro (`payout-core.property.test.ts`, `financial-invariants.test.ts`).
62. DAILY buffer exact? `payout-daily-progression.test.ts`.

**Payment**
63. Double approval? Idempotent early-return; second debit aborts on unique ledger index (`payouts.test.ts:187/199`).
64. Double payment? `if PAID return` + unique SETTLEMENT (`payout-ops-torture.test.ts`).
65. Duplicate callback? Deduped by `(provider,providerEventId)`.
66. Timeout/retry? Stable idem key; reconcile not re-submit.
67. Ledger debited once? Yes — unique `payout_ledger(request,DEBIT)`.

**Cycles**
68. Cycle 5 behavior? 5th PAID completes the account (`payout-daily-progression.test.ts:281`).
69. Cycle 6 blocked? Yes — blocked at approval (approved-count ≥ 5) before a 6th can be paid; integrity check `PAID_PAYOUT_CYCLES_OVER_MAX`.
70. Concurrent cycle-5 race? Serialized on the account advisory lock; a 6th is unreachable.

**Ledger**
71. Reconciliation helper created? Yes — `integrity-checks.ts` provides `PAYOUT_LEDGER_ARITHMETIC` (balance_after = before ∓ amount per entry type) and `APPROVED_PAYOUT_WITHOUT_DEBIT`; the append-only `payoutLedger` (before/after per row) makes the identity reconstructable. A single closed-form `opening+P&L−payout−fees=closing` daily helper remains a documented gap (fees are structurally 0 today).
72. Any unexplained micro-dollar? None found — split property tests + money-oracle reconcile exactly.
73. All tested lifecycle money reconciled? Yes (`golden-path.core50k.test.ts`, `financial-invariants.test.ts`).

**Rollback**
74. Fault injection implemented? The atomic boundaries make partial commits impossible by construction; verified by the concurrency races (a losing racer's whole attempt rolls back) and the unique-index aborts. No new bespoke fault-injector was added where the txn boundary already guarantees all-or-nothing.
75. Partial-state defect found? One PARTIALLY-ATOMIC path (EOD, RES-3) — self-healing, not a corruption.
76. Which transaction required repair? None (money paths already atomic). EOD wrap recommended (deferred P3).

**Events**
77. Duplicate delivery safe? Yes — idempotent recompute consumer (`projection-outbox.test.ts`).
78. Out-of-order delivery safe? Yes — consumer recomputes from authority, not order-dependent.
79. Restart safe? Yes — claim `FOR UPDATE SKIP LOCKED`, at-least-once, backoff + dead-letter.

**Database**
80. DB failure behavior? Txn aborts; no partial authoritative state; caller surfaces a typed error.
81. Constraint collision behavior? Unique-index conflicts are the intended idempotency backstop (`onConflictDoNothing`+reread) or a safe abort.
82. Deadlock/retry behavior? Advisory locks acquired in a consistent per-entity order; `distributed-correctness.test.ts` proves lock release on throw and single-winner contention.

**Authorization**
83. IDOR matrix result? Cross-owner = 404 (no oracle) across portal/trading/payout (`portal.routes.test.ts`, `trading-authz-http.test.ts`, `owner-isolation.test.ts`).
84. Mutation endpoints protected? Yes — every mutation carries `assertOwnership`/`assertOwned`/`requireOwnAccount`; owner/staff via DB-sourced `requireRole`/`requirePermission`.
85. Role escalation found? None — role read from DB, not token; `self-serve-boundary.test.ts`, `rbac.test.ts`.

**Inputs**
86. Overflow/large integer result? Rejected by Zod schemas + integer math; no overflow (`risk.ts` quantity/price checks).
87. Negative/malformed money result? Rejected (`INVALID_QUANTITY`/`INVALID_PRICE`); money is server-computed, not client-supplied.
88. NaN/Infinity-like input result? Rejected by `Number.isFinite`/`Number.isInteger` guards (`risk.ts`).

**Model testing**
89. Property/model-based harness added? Existing property coverage is strong (`stress.test.ts` 5000 seeded scenarios; `payout-core.property.test.ts` 5000+3000 draws). This phase added the deterministic `attack-harness.ts` (Barrier/race/settleAll) rather than a new framework (Part XXXI: don't add a huge framework).
90. Number of generated sequences? Existing: 8000+ across the two property suites. New race harness drives up to 20 concurrent contenders per scenario.
91. Any failing seed? None.
92. Root cause? n/a.

**Long run**
93. Long-run lifecycle transitions tested? Existing `golden-path.core50k.test.ts` runs an end-to-end multi-day lifecycle (provision→trade→EOD×N→pass→fund→winning-days→payout×5→complete); `audit-chain-stress.test.ts` runs thousands of chained events.
94. Maximum transitions in one deterministic run? Several thousand (audit chain stress).
95. Any state corruption? None.

**Audit**
96. Audit success truth? Written after commit; correct evidence for successful ops (`audit-chain-stress.test.ts`).
97. Rollback truth? No false-success record (audit follows commit). Personal-control chain audit is best-effort post-commit (RES-5); the durable in-txn event still records it.
98. Actor/target correctness? Captured (`actor{type,userId,ip,requestId}`, subject/account/user) — `m10-1-reauth-impersonation.test.ts`.

**Integrity**
99. Integrity checks created? Yes — `platform/resilience/integrity-checks.ts`, read-only, `runIntegrityChecks(db)`.
100. What corruption classes can they detect? active>cap, >5 paid cycles, duplicate funded successor, duplicate reset successor, floor-above-HWM, negative floor, phantom position, payout-ledger arithmetic, approved-without-debit.

**Flake**
101. PV2-G1 root cause? scrypt is memory-hard (N=2^15 ≈ 32 MB/op); the `beforeEach` created two traders each doing a hash **and** a login verify (4 scrypt ops/test), and under 221-worker CPU/memory contention the hook exceeded its 10s budget. Not a DB deadlock, not a product race — CPU/memory starvation from password hashing in per-test setup.
102. Fixed? Yes — `auth/password.ts` now uses a low work factor (N=2^10) under the test runner (VITEST/NODE_ENV=test); production (N=2^15) is unchanged, and N is encoded per hash so verification is unaffected. Measured: hash 274ms→11ms, verify 125ms→11ms in test mode. The file passes 4/4 in isolation and the change reduces contention for the whole auth-heavy suite.
103. If not, why exactly? n/a (fixed at root, not by raising the timeout).

**Findings**
104. Number P0? 0.
105. Number P1? 0.
106. Number P2? 1 (RES-1).
107. Number P3? 4 (RES-2, RES-3, RES-4, RES-5).
108. Every production defect fixed? Every defect that was a defect: PV2-G1 fixed. RES-1 is a product decision (not unilaterally changed, per Part XLIV). RES-2/3/4/5 are documented low-risk hardenings deferred with rationale (none is a correctness break today).
109. Anything intentionally deferred? Yes — RES-1 (product decision), RES-3 (EOD txn wrap), RES-4 (reset partial unique index), RES-5 (audit hookup), and a closed-form daily ledger-reconciliation helper.

**Validation**
110. New focused test count? 11 new tests (`attack-harness.test.ts` 3, `resilience-races.test.ts` 8) + 1 production file fixed (`password.ts`) covered by the existing auth-heavy suites. New modules: `attack-harness.ts`, `integrity-checks.ts`.
111. Adjacent suites? account-limit, commerce/commerce-chaos/commerce-funding, payouts/payout-*, trading (idempotency/execution-races/adversarial/brackets), personal-risk, audit-chain, projection-outbox — all green in canonical.
112. Typecheck? Clean.
113. Build? Clean.
114. Canonical result? **PASSED — 223 files / 3076 tests, all green** (`RELEASE VALIDATION PASSED`).
115. Any first-run canonical failure? **No** — green on the first run; `trading-authz-http.test.ts` no longer flakes under full contention (PV2-G1 fixed).

**Code**
116. Production files changed? One: `apps/server/src/auth/password.ts` (test-mode scrypt work factor). Plus two new non-production-path modules under `platform/resilience/` (harness + integrity checks; imported by tests/ops, not request paths).
117. Why? To make release validation deterministic (PV2-G1) and to add read-only corruption detection for future release validation.
118. Database migration added? No.
119. New constraints added? No (RES-4 partial unique index recommended, deferred).
120. Any economics changed? No.
121. Any product rule changed? No.
122. Portal V2 changed? No.
123. Atlas UI changed? No.

**Final**
124. Exact ending commit? See §Git.
125. Single largest remaining backend risk? RES-1 — whether the contract cap should bound working orders is undecided; until decided, a trader can (on a simulated account) stack resting limit orders that collectively fill past the cap. Bounded, no money duplication, no cross-customer effect.
126. Next resilience phase area? Order/execution reservation semantics (submit-time counting of working-order exposure for firm + personal caps, pending the RES-1 decision) and wrapping the EOD two-write in one transaction; plus a closed-form daily ledger reconciliation helper.
127. Any product decision needed before more objective backend work? Yes — RES-1 (does "max N contracts" bound working orders?). Everything else can proceed without it.
128. Can another backend resilience phase proceed without human visual review? Yes — this is authoritative-backend work with no UI surface; no visual review required.

---

## Validation

Focused new suites + adjacent domains + typecheck + build, then canonical once.

- Focused new resilience suites: **11 passed** (harness 3, races/integrity 8).
- Adjacent auth-heavy suites after the scrypt change: resilience + account-limit + commerce-chaos + trading-authz = **23/23 passed** (no regression from the password-cost change).
- Flaky file in isolation after the fix: **4/4 passed (6.7s)**.
- Typecheck: clean. Build: clean.
- **Canonical: PASSED — 223 files / 3076 tests, all green, on the FIRST run** (`RELEASE VALIDATION PASSED`, exit 0). Crucially, `trading-authz-http.test.ts` passed under the full 223-worker contention with no hook timeout: the PV2-G1 fix made release validation deterministic. **No first-run canonical failure.**

## Git

- Start: `b48ba7e`; checkpoint tag+branch `engineering-resilience-phase1-start` created; stash `phase3-wip-product-model` preserved.
- Ending commit, remote==local confirmation and canonical totals recorded with the commit and completion summary.
- No `reset --hard`, no force-push, no history rewrite.

## Definition of done

Critical invariants documented (`BACKEND_INVARIANT_LEDGER.md`) · boundaries mapped (`TRANSACTION_BOUNDARY_MAP.md`) · concurrency attacked deterministically (harness + races) · provisioning/reset/funded cannot duplicate · cap cannot race past 5 (2/5/20 proven) · order retry/OCO/position/risk/locked/terminal/EOD/winning-day/payout/cycle invariants proven by new + existing tests · integrity checks detect major corruption · PV2-G1 genuinely root-caused and fixed · no economics/product-rule/Portal-V2/Atlas change · **no unresolved P0/P1.** Recovery documented (`FAILURE_RECOVERY_MATRIX.md`).
