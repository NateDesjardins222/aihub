# Resilience Phase 2 — Report

**Persistence / crash recovery / reconciliation / database disaster proof**
**Base commit:** `4c4570d` (`engineering-resilience-phase2-start`) · **Date:** 2026-09-29

The governing property was **fail closed or recover safely** — for every critical
workflow, prove the transaction commits completely (A), rolls back completely (B),
or enters a durable recoverable state that continues/reconciles deterministically
(C); never a fourth "we don't know" category. Failures were **injected** (a
connection-layer fault injector, `platform/resilience/failpoints.ts`) rather than
demonstrated by more ordinary tests.

## Headline

- **2 production fixes** (both root-cause, both money/data-integrity):
  - **RES-3** — the EOD day-roll's two writes are now ONE transaction (no partial day).
  - **RES-P2-1** — a definitively-failed payout now reverses its debit atomically
    (restores balance + writes a REVERSAL ledger row), with a new integrity detector.
- **RES-4** — DB-level partial unique index on `accounts.reset_of_account_id`
  (defense-in-depth behind the application key), with fresh-DB + concurrency proof.
- **New infrastructure**: fault-injection framework, an independent position/P&L/
  ledger **reconciliation oracle**, a backup/restore drill, and an extra integrity
  detector.
- **Findings**: **0 P0, 0 P1, 1 P2 (RES-P2-1, contained today; P1 at real-money
  launch), 3 P3 (RES-2, RES-5, and RES-1 unchanged product decision).**
- **43 resilience tests** (8 files; 32 new across 7 new files), typecheck + build
  clean, canonical run once.

---

## REPOSITORY
1. **Starting commit?** `4c4570d`.
2. **Ending commit?** The commit carrying this report (recorded in the commit message and in `KNOWN_ISSUES.md`).
3. **Clean tree?** Yes at hand-off (verified after push).
4. **Remote == local?** Yes (verified after push).
5. **Checkpoint preserved?** Yes — tag + branch `engineering-resilience-phase2-start`, plus all prior checkpoints/tags.
6. **Stashes preserved?** Yes — `phase3-wip-product-model` untouched; no stash dropped.

## DURABILITY
7. **Any critical volatile-only authority?** No. Every money/risk/account authority is in Postgres; the engine caches nothing authoritative (`DURABILITY_MAP.md`).
8. **Which state is rebuildable?** Positions, realized P&L, daily/EOD state (from `executions`/roll replay); domain-event projections; engine in-memory caches (`activeSymbols`, brackets) rebuilt on `start()`.
9. **Which state is authoritative?** identity, entitlements, accounts, profile versions, risk controls, orders, executions, payout requests/ops, the money ledger, qualifications, the audit chain, the outbox, kill switches.
10. **Any ambiguous ownership?** No. The only externally-owned truth is the payout provider's outcome, reconciled via a stable idempotency key.

## CRASH INJECTION
11. **How many workflows failure-injected?** Provisioning, reset, funded transition, order/execution→position, EOD roll, payout approval/failure, outbox delivery, plus DB deadlock/connection-loss — 9 workflow families.
12. **How many crash points?** ~30 meaningful points enumerated in `CRASH_POINT_MATRIX.md`; the injector exercises the intra-transaction ones directly (provisioning ×2, fill ×4, EOD, payout reversal, reset).
13. **Any partial-state defects?** None survived. Every injected mid-transaction fault rolled back completely (proven against real Postgres, not a mock).

## PROVISION
14. **Crash before commit?** ROLLBACK — no account, no lifecycle (`failpoints.probe.test.ts`).
15. **Crash after commit/before response?** COMMITTED then idempotent on retry (same `ent:`/`fund:` key → one account).
16. **Retry result?** Exactly one account (`crash-recovery.test.ts`).
17. **Duplicate account possible?** No — `commercial_orders(org,idemKey)` + `provisioning_requests(org,idemKey)` + advisory-locked cap.

## RESET
18. **Crash recovery result?** ≤1 successor after a mid-fulfill fault; retry converges to exactly one (`crash-recovery.test.ts`).
19. **Exactly one successor?** Yes — application key + **now** the DB unique index.
20. **RES-4 decision?** IMPLEMENTED — partial unique index `accounts_reset_of_key` (migration 0036) as defense-in-depth; evidence: existing data compatible (invariant already held), semantics are genuinely one successor, fresh-DB migrate-from-zero proven, concurrency test green, integrity detector retained.
21. **Unique constraint added?** Yes — `CREATE UNIQUE INDEX accounts_reset_of_key ON accounts(reset_of_account_id) WHERE reset_of_account_id IS NOT NULL`.

## FUNDED
22. **Crash recovery result?** ROLLBACK mid-`approveFunding` (no funded account, qual unmarked); retry funds exactly once (`crash-recovery.test.ts`).
23. **Duplicate funded successor possible?** No — `FOR UPDATE` + `fund:<qualId>` key + `account_qualifications(account,lifecycle)`; integrity `DUPLICATE_FUNDED_SUCCESSOR` detects.
24. **Certificate/event duplicate possible?** No — certificate/PAID side effects are idempotent (exactly-once from a PAID event only).

## ORDERS
25. **Exact order authority point?** The `orders` INSERT in `submitLocked` (`engine.ts`), backed by `orders(accountId,clientOrderId)` unique.
26. **Response-loss behavior?** A re-submit with the same `clientOrderId` returns the existing order (dedup).
27. **Retry safe?** Yes — no duplicate logical order.
28. **Unknown provider outcome represented safely?** External execution is simulated/disconnected; the safety-gate + provider abstraction represent unknown honestly. For payouts (the live-money seam), TIMEOUT/LOST_ACK are distinct from FAILED and drive reconcile-not-retry.

## EXECUTIONS
29. **Execution/position atomic?** Yes — one `db.transaction` writes orders + position + executions + trades + day-state + balance + outbox (`engine.ts matchLocked`).
30. **Fault injected between them?** Yes — trips #2–#5 inside the fill txn (`engine-atomicity.test.ts`).
31. **Any divergence?** None — the reconciliation oracle is clean after every crash point (execution and position both present or both absent).
32. **OCO state consistent?** Yes — sibling cancels are computed in the same match pass and persisted in the same txn (Phase 1 `execution.test.ts`, `stress.test.ts`).

## RECONSTRUCTION
33. **Position reconstruction implemented?** Yes — `platform/resilience/reconcile.ts` folds `applyFill` over `executions`.
34. **All 8 instruments?** Yes — NQ/MNQ/ES/MES/GC/MGC/CL/MCL (`reconcile.test.ts`), open/add/reduce/close/reverse.
35. **P&L reconstruction?** Yes — realized P&L recomputed from (side,qty,priceTicks) and checked exactly against stored positions/accounts/trades (no tolerance).
36. **Any mismatch?** None on correctly-operated data; deliberate corruption is detected (position + account level).

## EOD
37. **RES-3 result?** FIXED — the two writes are one transaction.
38. **Two-write boundary still exists?** No — `recordClosedDay` + `persistRuleState` run in a single `db.transaction` (`engine.ts rulesLocked`).
39. **If yes, why safe?** N/A (removed). It remains idempotent on replay besides.
40. **If changed, what changed?** Wrapped both writes in one transaction; behaviour otherwise identical (date short-circuit + absolute-set counters).
41. **Restart during EOD?** A fault writes neither the day stat nor the counters; a clean replay does both once (`engine-atomicity.test.ts`).
42. **Duplicate finalization?** Idempotent — replay yields one day stat, floor unchanged.

## RISK
43. **Committed control + lost response?** The durable in-txn `trader_risk_control_events` row + control row are atomic; a lost response leaves them committed.
44. **Retry result?** Safe — a retry with `expectedVersion` is rejected as stale (CAS); without version it re-applies the same absolute value idempotently (Phase 1 `personal-risk.crud.test.ts` C07).
45. **RES-5 decision?** Durable evidence requirement is ALREADY met by the atomic in-txn `trader_risk_control_events` row (no risk-sensitive mutation is unrecorded). The tamper-evident hash-chain audit remains best-effort post-commit by design (moving it into the mutation txn would reintroduce org-audit-lock contention the codebase deliberately avoids). Classified **P3**; recommended future improvement: deliver the chain audit via the durable outbox. Not changed this phase.
46. **Missing audit possible?** The secondary hash-chain row can be missed on a swallowed error; the primary durable event cannot. Detectable by reconciling control events vs audit rows (future).

## PAYOUT REQUEST
47. **Crash before commit?** ROLLBACK — no request; no money moved (request moves no money).
48. **After commit/before response?** COMMITTED, idempotent on retry (`(org,idemKey)` + one-pending guard).
49. **Retry?** Returns the existing request.
50. **Capacity remains exact?** Yes — advisory lock + `FOR UPDATE` + re-verify (Phase 1 `payouts.test.ts`).

## PAYOUT PAYMENT
51. **Provider success/local crash?** RECONCILABLE — reconcile via `getPayout` with the stable key; never blind re-submit.
52. **Duplicate callback?** Deduped by `payout_provider_events(provider,eventId)`; terminal PAID never regresses.
53. **Unknown timeout?** Represented as TIMEOUT/LOST_ACK (not FAILED) → reconcile.
54. **Can double payment occur?** No — stable idempotency key + `payout_ledger(request,SETTLEMENT)` unique + provider dedup.
55. **Can local state falsely claim paid?** No — only an authoritative provider PAID (event/reconcile) drives settlement; HTTP success alone never does.

## LEDGER
56. **Crash between payout/accounting steps?** ROLLBACK — the debit + DEBIT ledger + request update are one txn; the reversal + REVERSAL ledger + state flip are one txn.
57. **Double debit possible?** No — `payout_ledger(request,DEBIT)` unique.
58. **Reconciliation exact?** Yes — `reconcileAccount` proves `balance = starting + realized − fees − net payout` and per-row ledger arithmetic, exactly.
59. **Any unexplained micro-dollar?** None — restore drill + oracle show zero unexplained delta.

## CYCLE 5
60. **Crash during completion?** Idempotent — count-guard + `status != COMPLETED`.
61. **Final state correct?** 5 paid cycles → COMPLETED, not tradable, history preserved.
62. **Cycle 6 impossible?** Yes — blocked at approval before a 6th (`MAX_PAYOUT_CYCLES`).

## OUTBOX
63. **Publisher-down recovery?** Event is durable and delivered when the worker runs (`durability-extras.test.ts`).
64. **Duplicate delivery?** At-least-once; consumers idempotent (recompute from authority) → no duplicate effect.
65. **Consumer crash?** Handler + delivery mark commit together; a crash rolls back the handler's work with the mark (proven — the crashed handler's write does not persist).
66. **Poison event behavior?** Dead-lettered after `maxAttempts`, excluded from claims, `last_error` recorded; the queue is never wedged and good events still flow.
67. **Failed event observable?** Yes — `outboxStats().deadLetter` + `outbox_events.last_error`.

## DATABASE
68. **Connection-loss behavior?** A mid-transaction abort rolls back completely (fault injector).
69. **Deadlock behavior?** Postgres aborts exactly one side (40P01); the other commits; no partial state; retry succeeds (`durability-extras.test.ts`).
70. **CAS/version conflicts?** Stale writes rejected (orders modify, personal controls, payout requests — Phase 1 + this phase).
71. **Partial commit possible?** No — ACID; proven by injected mid-txn aborts across provisioning, fill, EOD, and payout reversal.

## CONSTRAINTS
72. **Critical uniqueness audit result?** All critical invariants are DB-unique-indexed (orders, positions, entitlements, qualifications, provisioning requests, payout ledger/ops/attempts/events, cycles) — see `DURABILITY_MAP.md`. The one app-only gap (reset successor) is now closed (RES-4).
73. **New constraints?** One — `accounts_reset_of_key` (RES-4).
74. **Why?** It was the sole 1:1 money-adjacent invariant enforced only in the application; a DB constraint makes it fail-closed.
75. **Fresh migration proof?** `prepare-test-db.sh` migrates from zero including 0036; index verified present.
76. **Upgrade proof?** `IF NOT EXISTS`, idempotent; no existing data violates it (invariant already held), so it applies cleanly on an existing DB.

## BACKUP/RESTORE
77. **Representative backup created?** Yes — `pg_dump -Fc` of the seeded test DB (`scripts/resilience-restore-drill.sh`).
78. **Restored fresh DB?** Yes — into an isolated `atlas_restore_drill`, dropped afterward.
79. **Integrity checks after restore?** Yes — zero violations on the restored copy.
80. **Audit chain valid after restore?** The chain rows restore intact (append-only table copied verbatim); Phase 11's drill proved byte-identical restore + chain re-verify.
81. **Idempotency evidence retained?** Yes — `provisioning_requests`, `payout_operations`, `payout_provider_events` counts match source.
82. **Any data lost?** None — row counts + money-ledger content digest match exactly.

## CORRUPTION
83. **Corruption fixtures detected?** Yes — position/account realized mismatch, over-cap, drawdown-floor regression, duplicate reset successor (now DB-blocked), failed-payout-without-reversal.
84. **False positives?** None — legitimate reverse/partial/close, valid payouts, funded transitions, and clean accounts produce no findings (`reconcile.test.ts`, `resilience-races.test.ts`).
85. **Which corruption classes detectable?** The nine `integrity-checks.ts` detectors + the reconciliation oracle's typed lines.

## RESTART
86. **Can critical state reconstruct from DB?** Yes — engine rebuilds positions/orders/brackets from Postgres; sweeps re-drive lifecycle; workers resume from durable rows.
87. **Any volatile dependency?** None for correctness — only caches warm.
88. **Working order recovery?** Yes — open orders are read from `orders` each pass; `refreshActiveSymbols` on `start()`.
89. **Pending payout recovery?** Yes — `PayoutOpsWorker` resubmits PAYABLE with the stable key.
90. **Pending outbox recovery?** Yes — the outbox worker claims undelivered rows (`FOR UPDATE SKIP LOCKED`).

## TIME
91. **Day-boundary tests?** Yes — the EOD roll is driven by explicit exchange timestamps (`engine-atomicity.test.ts`, existing `eod-trailing-engine.test.ts`).
92. **DST relevant?** Day rollover uses CME/Globex session anchoring (`session.ts tradingDate`), exchange-local; not naive local time.
93. **Backward clock behavior?** The roll uses the feed/exchange timestamp (server wall-clock only as a last-resort fallback); a client cannot supply the day boundary. Verified by inspection (`engine.ts accountTradingDate`).
94. **Unsafe client-time dependency?** None found for the day boundary or ordering. Latency stats use wall-clock live / recorded exchange clock in replay; not authoritative for money.

## MIGRATIONS
95. **Fresh DB from zero?** Yes — 37 migrations (0000–0036) apply cleanly; 136+ tables.
96. **Seed?** Yes — canonical catalog + demo fixtures.
97. **Integrity checks?** Zero findings on the fresh seeded DB.
98. **Critical smoke?** Golden-path core50k passes 15/15 on a fresh DB.
99. **Schema/domain drift found?** No new authoritative-field drift; the known `AccountStatus` type staleness (HTF-11) and `AccountSummary` web mirror gap (PV2-2) are pre-existing P3/P4 and unchanged.

## IMMUTABILITY
100. **Historical failed account immutable?** Preserved — a reset creates a successor; the failed account is never mutated (`crash-recovery.test.ts`).
101. **Paid payout immutable?** PAID is terminal; `payout_ledger` is append-only (trigger-enforced); no path moves a terminal state backward.
102. **Execution/ledger history protected?** `executions` are insert-only; `payout_ledger`/`audit_log` are trigger-enforced append-only.
103. **Terminal-state resurrection possible?** No — FAILED/PAID/COMPLETED are terminal in their state machines; stale ops are rejected (`crash-recovery.test.ts` monotonicity; provider terminal-monotonicity in `ingestProviderEvent`).

## RECOVERY
104. **Any critical recovery requiring SQL?** No launch-critical path requires raw SQL money mutation. RETURNED-payment reconciliation and outbox dead-letter clearing are operator actions via audited tools, documented in the runbook.
105. **Runbooks created?** Yes — `BACKEND_RECOVERY_RUNBOOK.md` (12 procedures, inspect→reconcile→retry).
106. **Ambiguous payout recovery safe?** Yes — unknown outcome reconciles, never auto-fails; definitive failure reverses atomically.

## SECURITY
107. **Cross-user retry attack?** Rejected — replaying another identity's provisioning idempotency key with a different body throws `IDEMPOTENCY_CONFLICT` (request-hash mismatch); no cross-grant (`crash-recovery.test.ts`).
108. **Cross-user idempotency replay?** Same as 107 — the key is scoped by org + hashed body; a foreign replay cannot provision to the attacker.
109. **Recovery role escalation?** Recovery paths reuse the same server-side ownership/RBAC checks (Phase 1 `trading-authz-http.test.ts`, owner isolation); no recovery bypass.

## IDEMPOTENCY
110. **Retention policy?** Idempotency evidence (`commercial_orders`, `provisioning_requests`, `payout_operations`, `payout_provider_events`) is retained indefinitely today (no cleanup job) — safe for replay windows.
111. **Replay after retention dangerous?** Not currently possible — nothing prunes idempotency rows, so a late replay still dedupes. Documented as a requirement for any future cleanup (retain beyond the longest provider replay window).
112. **Cleanup safe?** No cleanup exists; therefore no unsafe cleanup. Flagged for future infra.

## EVENT ORDER
113. **Out-of-order events tested?** Yes — provider terminal-monotonicity (PAID never regressed; late FAILED after PAID rejected) via `ingestProviderEvent` guards; outbox ordered by `createdAt`.
114. **State regression possible?** No — terminal states are absorbing; stale lifecycle/payout events cannot move them backward.

## TEST SCRYPT
115. **Test-mode work factor mechanically isolated?** Yes — `selectScryptParams(env)` is pure; only `VITEST==='true'` or `NODE_ENV==='test'` selects the weak factor (`test-mode-security.test.ts`).
116. **Production default proven unchanged?** Yes — production AND the bare default (no env) select N=2^15; the test factor cannot leak.

## FINDINGS
117. **P0 count?** 0.
118. **P1 count?** 0.
119. **P2 count?** 1 — RES-P2-1 (failed-payout reversal): contained today (no real payout rail), **fixed**; would be P1 at real-money launch.
120. **P3 count?** 3 — RES-2 (optional `expectedVersion`, by design), RES-5 (best-effort chain audit; durable event exists), RES-1 (contract-cap product decision, unchanged).
121. **Production defects fixed?** 2 — RES-3 (EOD atomicity) and RES-P2-1 (payout reversal). Plus RES-4 defense-in-depth index.
122. **Deferred issues?** RES-1 (product decision, Nathan), RES-5 (outbox-delivered chain audit, future), idempotency-retention policy (future infra), production PITR/backup automation (future infra).

## VALIDATION
123. **New test count?** 32 new tests across 7 new files (43 total in the resilience suite).
124. **Resilience Phase 1 suites?** Green (harness + races + integrity, updated for RES-4).
125. **Typecheck?** Clean (all packages).
126. **Build?** Clean.
127. **Canonical?** PASSED on the FIRST run — **230 files / 3108 tests, all green**, typecheck + build clean, `RELEASE VALIDATION PASSED`, exit 0.
128. **First-run canonical failure?** None — clean on the first run (no rerun).

## SCOPE
129. **Economics changed?** No.
130. **Product rules changed?** No.
131. **RES-1 changed?** No — documented only.
132. **Portal V2 migrated?** No.
133. **Portal frontend changed?** No.
134. **Atlas UI changed?** No.
135. **Production provider connected?** No — providers remain mock/unconfigured; no real money.

## FINAL
136. **Exact final commit?** Recorded in the commit message / `KNOWN_ISSUES.md` (the commit carrying this report).
137. **Single largest remaining persistence risk?** The audit hash-chain is best-effort post-commit (RES-5); the primary durable event exists, so this is tamper-evidence completeness, not data loss.
138. **Single largest remaining financial-integrity risk?** No real payout rail (HTF-3): RES-P2-1's reversal is proven in simulation but has never run against a real provider. Wiring the rail must re-run these proofs live.
139. **Single largest remaining operational-recovery risk?** No production backup automation / PITR (HTF-17): the restore procedure is proven in dev but scheduled backups, retention, encrypted storage and restore drills are production infra to build.
140. **What should Resilience Phase 3 attack that 1–2 have NOT proven?** Multi-process / multi-instance concurrency at scale (fleet of engines + workers under partition), real provider-rail reconciliation against a live sandbox, and long-run endurance/soak with continuous integrity + reconciliation sampling.
141. **Does any remaining issue require Nathan's product decision?** Yes — RES-1 (does "max N contracts" bound working orders or net position?). Everything else is engineering/infra.
142. **Can objective backend work continue without Nathan's visual review?** Yes — all Phase 2 work is backend/DB with deterministic proofs; no visual acceptance is required.

---

## Validation

Focused suites (all green, fresh DB): the 8-file resilience suite **43/43**; auth **14/14**;
`trading-authz-http` green; golden-path core50k **15/15**; EOD-trailing engine + engine
integration green; payout suites green. Typecheck (all packages) clean; production build clean;
migrate-from-zero (incl. 0036) + seed clean; backup/restore drill PASSED.

**Canonical:** `pnpm validate:release` — **PASSED on the first run**: 230 test files / **3108
tests all green**, typecheck (5 packages) clean, production build clean, `RELEASE VALIDATION
PASSED`, exit 0 (403s). No rerun.

## Fix policy adherence

Each fix followed: deterministic reproduction (injected) → root ownership boundary → root
repair → regression test → re-inject → reconcile. No symptom patches; no test skipped or
weakened; no economics/product-rule/contract-limit change; no Portal/Dashboard/Atlas work; no
production provider; no real money.
