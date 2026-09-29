# Resilience Phase 2 — Attack Plan

**Persistence / crash recovery / reconciliation / database disaster proof**
**Base commit:** `4c4570d` (`engineering-resilience-phase2-start`) · **Date:** 2026-09-29

This plan is written **before** any production change. It states what Phase 1 already
proved, what it did **not** prove, and exactly which persistence/recovery claims Phase 2
will attack with **injected failures** (not more ordinary tests).

---

## 1. What Phase 1 proved (do not repeat)

Phase 1 (`RESILIENCE_PHASE1_REPORT.md`, `BACKEND_INVARIANT_LEDGER.md`) attacked **concurrency**
and proved, under real Postgres with a deterministic barrier harness:

- account-cap holds at 2/5/20-way concurrency (never a 6th);
- one-successor-per-reset under 8-way concurrency;
- order idempotency (`orders(accountId,clientOrderId)`), payout debit uniqueness, cycle-5 block;
- integrity **detection** for the major corruption classes (`integrity-checks.ts`);
- release-validation determinism (PV2-G1 scrypt root fix).

Findings: **0 P0, 0 P1, 1 P2 (RES-1), 4 P3 (RES-2/3/4/5)**.

Phase 1's guards (advisory locks, `FOR UPDATE`, unique indexes, version CAS, transactional
outbox, hash-chained audit) are the **design**. Phase 1 proved the design is internally
consistent under concurrency. It did **not** prove the **failure behaviour**: what a crash /
lost connection / replayed event / interrupted transaction actually leaves behind.

## 2. The gap Phase 2 attacks

The governing question: **if Happy Trader crashes, loses a connection, replays an event,
interrupts a transaction, or restarts at the worst possible moment — can authoritative truth
still be recovered exactly?**

For every critical workflow we must prove exactly one of:
- **A** — the transaction commits completely; or
- **B** — the transaction rolls back completely; or
- **C** — the workflow enters a **durable recoverable** state with enough information to
  deterministically continue/reconcile.

There must be no fourth category ("we don't know what happened").

### Claims still lacking DIRECT failure proof (the Phase 2 target list)

| # | Claim | Phase 1 status | Phase 2 attack |
|---|---|---|---|
| A1 | A crash mid-`db.transaction` leaves **no** partial write | assumed (ACID) | inject a throw after each intra-txn write; assert DB state is as-if-nothing-happened |
| A2 | Retry after **response loss** (committed but caller never learned) is idempotent | proven for same-process dedup | inject failure *after commit / before response*, retry, assert one effect |
| A3 | Provisioning survives crash at every boundary + duplicate commerce event | idempotent by key | crash-point matrix + replay |
| A4 | Reset survives crash/retry; exactly one successor; **RES-4** index decision | 8-way concurrency only | crash-point injection + evidence-based index decision |
| A5 | Funded transition survives crash/retry; no duplicate funded successor | idempotent by key | crash-point injection + replay |
| A6 | Execution + position + P&L + order-state cannot **silently diverge** | one txn (asserted) | inject failure between each intra-txn step; independent reconstruction oracle |
| A7 | Position + realized P&L are **independently reconcilable** from executions | pure-math tests | TEST-ONLY oracle across all 8 instruments vs persisted state |
| A8 | **RES-3**: EOD two-write window is safe or fixed | self-heals (claimed) | inject failure between the two writes; measure observability; decide fix vs prove |
| A9 | Risk-control persistence survives response loss; **RES-5** audit durability | opt-in version | crash-point + audit-durability decision |
| A10 | Payout payment handles **ambiguous** provider outcome (timeout) safely | state machine exists | inject unknown outcome; prove no double-pay, no false PAID |
| A11 | Payout/ledger effects cannot duplicate across crash | unique index | crash-point injection between every ledger step |
| A12 | Cycle-5 completion survives interruption | approval guard | crash-point injection + replay |
| A13 | Outbox survives publisher/consumer failure; **poison event** doesn't wedge queue | at-least-once (claimed) | publisher-down, consumer-crash, poison-event injection |
| A14 | DB **connection loss / deadlock** cannot partially commit | ACID | force deadlock + connection drop; assert atomicity |
| A15 | Representative **backup restores** with authoritative truth intact | Phase 11 drill (small) | fuller fixture set → `pg_dump -Fc` → restore → integrity + audit-chain + reconciliation |
| A16 | Critical state **reconstructs after restart** with no volatile dependency | Phase 11 (claimed) | positions/orders/brackets/risk/pending-payout/outbox from DB only |
| A17 | **Terminal states** cannot be resurrected by stale/replayed events | state gates | replay old events at FAILED/CLOSED/COMPLETED accounts |
| A18 | **Test-mode scrypt** cannot leak into production | env check | mechanical proof of selection under prod/default/test envs |
| A19 | Recovery paths cannot become an **IDOR/authorization bypass** | ownership checks | cross-user retry / idempotency-key replay attack |

## 3. Method

1. **Durability map** (`DURABILITY_MAP.md`) — classify every critical entity as DURABLE
   AUTHORITY / DERIVED DURABLE / REBUILDABLE CACHE / VOLATILE / EXTERNAL / UNKNOWN. Any
   critical money/risk/account authority that is volatile-only is P0/P1.
2. **Failure-injection framework** — extend the Phase 1 attack harness with an in-test
   fault registry (`failpoint`) that throws at a **named** point. Production code gets a
   single inert seam (a no-op in prod; the test arms it). No sloppy `if (test)` scattered
   through business logic — one clean dependency seam.
3. **Crash-point matrix** (`CRASH_POINT_MATRIX.md`) — enumerate meaningful crash points per
   workflow with the **expected** result (ROLLBACK / COMMITTED / REPLAYABLE / RECONCILABLE /
   MANUAL REVIEW). Then test the meaningful boundaries.
4. **Reconstruction oracle** — independent TEST-ONLY position + P&L recomputation from
   execution history; use as an integrity oracle, not a second production engine.
5. **Reconciliation** — expand the read-only integrity checks into a rigorous, non-destructive
   reconciliation routine (ledger arithmetic, split, capacity).
6. **Backup/restore** — representative fixture → `pg_dump -Fc` → restore into a fresh DB →
   integrity + audit-chain + reconciliation must pass. Dev infra only; no dumps committed.
7. **RES-3/4/5 + RES-1** — evidence-based decisions. Fix at the root only where a real gap
   exists; otherwise prove why the current boundary is safe. RES-1 stays **documented only**.

## 4. Fix policy

When a defect is found: preserve a deterministic reproduction → identify the root ownership
boundary → repair the **root** → regression test → failure-inject again → run reconciliation.
No symptom patches. No test skipped/weakened. No economics/product-rule/contract-limit change.
No Portal V2 / Dashboard V2 / Payouts V2 / Atlas work. No production provider. No real money.

## 5. Definition of done

Every row of §2 has a direct proof (A/B/C) or an accurately-classified finding; RES-3/4/5
resolved or proven-safe with evidence; backup/restore + migration-from-zero pass; canonical
runs once and is honestly reported; no P0/P1 remains. Then STOP and report.
