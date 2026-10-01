# PCV-6 Failure Map — Canonical Validation Non-Determinism

**Phase:** Engineering Integrity — PCV-6 / Deterministic Test Isolation.
**Starting commit:** `4480d04` (branch `claude/futures-trading-simulator-v8qefu`).
**Checkpoint tag:** `pcv6-determinism-start`.

This document records, from **reproduced evidence** (not speculation), why
`pnpm validate:release` could fail intermittently under shared-PostgreSQL
contention even though every suite passes in isolation, and classifies each
failure by root cause. It is the input to `docs/TEST_ISOLATION_ARCHITECTURE.md`
(the fix) and `docs/PCV6_RESOLUTION_REPORT.md` (the proof).

## How this was reproduced (no guessing)

Three measured runs on the baseline tree, Postgres 16, 4 CPUs:

| Run | Config | Result |
|-----|--------|--------|
| **R1 — canonical, once** | `pnpm validate:release` (serial, `fileParallelism:false`) | **PASS** — 247 files / 3312 tests, 1 file & 6 tests skipped, 473s, exit 0 |
| **R2 — forced concurrency** | `vitest run apps/server --fileParallelism` on the shared DB | **FAIL, non-deterministically** |
| **R3 — serial + worker-gating fix** | `vitest run apps/server` after the fix | drove the residual to a single root cause (see below) |

The decisive evidence is **R2**: the same suite, run twice back-to-back under
file parallelism against one database, failed a **different set each time** —
**10 files / 18 tests** on one pass and **16 files / 56 tests** on the next.
A failure set that changes run to run from identical inputs is the definition
of the PCV-6 non-determinism. Serial execution (R1) merely lowers the collision
probability; it does not remove the cause, which is why canonical could still
fail on a loaded CI runner.

Evidence logs (this session's scratchpad):
`pcv6-baseline-serialized-GREEN.log`, `pcv6-parallel-repro.log`,
`pcv6-failure-evidence.txt`, `pcv6-serial-gated.log`.

## The single root cause (with its symptom classes)

`buildApp()` (apps/server/src/http/app.ts) started, on every call, a set of
**fire-and-forget background workers** that outlived the test that created them:

- 3 scanning **startup sweeps** — `certifyPassedEvaluations`,
  `fundEligibleQualifications`, `retryPendingProvisioning` (`void …`, full-table
  scans);
- 5 continuous **pollers / listeners** — the notification delivery worker, the
  outbox delivery worker, the account `LISTEN/NOTIFY` listener, the payout-ops
  worker, the inactivity worker;
- 1 deferred **notification consumer** that enqueues a row on every domain event.

66 server test files call `buildApp()`. All 66 call `app.close()`, but the
`void` sweeps and the `setTimeout`/interval loops **race `close()`** and, in a
shared single-process database, keep scanning and writing **after the test that
started them has ended** — into the rows the *next* file is asserting on. Two
non-DB helper files (`resilience/soak-lifecycle.test.ts`,
`resilience/soak-integrity.test.ts`) already document this in comments
("buildApp's background PayoutOpsWorker would race that manual stepping";
"a dedicated pool with NO background outbox worker (buildApp starts one…)") —
direct in-code evidence that these escaping workers are the known contaminant.

## Failure classification (categories A–J from the brief)

Every reproduced failure maps to this one root cause expressed through several
categories. Counts are from R2's error signatures (`pcv6-failure-evidence.txt`).

| Cat | Name | Reproduced as | Example evidence |
|-----|------|---------------|------------------|
| **D** | Async escaping test lifetime | the root cause itself — sweeps/pollers/consumer running after `close()` | `projection-outbox.test.ts > never lets two workers process the same event (SKIP LOCKED)` fails because buildApp's own `OutboxWorker` (from another file's app) drains the same `outbox_events` the test is draining |
| **A** | Shared DB state pollution | cross-file rows altering counts/balances; notification PENDING backlog | `reconcile.test.ts`/`engine-atomicity.test.ts` deep-equal balance mismatches (`expected { balance: … } to deeply …`); 23× `AssertionError` |
| **F** | Deadlock / lock-order | two backends on the same account/payout rows | 2× `deadlock detected`; EOD teardown + payout-ops worker vs. test |
| **B** | Non-unique / cross-run identity | affiliate application/rate rows already present | 11× HTTP `409`, `already applied` on `affiliate-http.test.ts` / `affiliate-security.test.ts` |
| **E** | Fixed-sleep / timing drift | engine `settle()` under CPU starvation from the escaped workers | `brackets.test.ts`, `determinism.test.ts`, `pnl-reconciliation.test.ts` fill/▸P&L mismatches — the stops/targets did not settle before assertion |
| **G** | Runner parallelism | only the *amplifier*: parallel files multiply D/A/F against one DB | R2's non-deterministic set; serial (R1) hides but does not fix it |

Categories **C** (unsafe global cleanup), **H** (schema/migration collision),
**I** (singleton/global state beyond the DB pools), and **J** (an actual product
concurrency defect) were **looked for and not found**: fixtures clean up only
their own rows (`trading/harness.ts` deletes by its own account/template/user
id — no global `TRUNCATE`/`DELETE`), the migration set applies once per prepared
DB, and every reproduced failure is explained by D/A/F/E/B above with no
product-code race. (The dependency audit confirmed only one test — the
notification event-consumer — depended on a gated worker; it was adapted to
drive its own consumer, assertions unchanged.) No product concurrency defect was
escalated out of PCV-6 because none was found.

## The notification PENDING-backlog corollary (found during R3)

Gating the delivery worker off but leaving the **consumer** on surfaced a second
category-A instance: the consumer enqueues a PENDING intent on every domain
event across every file, and with nothing delivering them in the shared serial
DB they accumulate until a later `deliverPendingNotifications` batch misses its
own row (`notifications.test.ts > delivery > delivers a pending message (SENT)`
saw `PENDING`). Fixed by gating the consumer too and having the one consumer
test register its own — see the resolution report.

## What the fix therefore has to do

1. Remove the escaping async at its source: gate the sweeps + pollers +
   consumer off under `NODE_ENV=test` (they are recovery/operational loops, not
   unit-under-test), keeping the synchronous lifecycle subscribers. — kills D, and
   the A/F/E/B that flowed from it under serial execution.
2. Make true concurrency safe, not merely avoided: per-worker database isolation
   so parallel files never share a database. — kills G as an amplifier and lets
   the suite be *proven* deterministic under parallelism.
3. Prove it: a determinism harness (parallel + randomized order + dirty-DB,
   10×) plus two consecutive clean canonical runs.

See `docs/TEST_ISOLATION_ARCHITECTURE.md` and `docs/PCV6_RESOLUTION_REPORT.md`.
