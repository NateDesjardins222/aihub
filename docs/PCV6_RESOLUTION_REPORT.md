# PCV-6 Resolution Report — Deterministic Canonical Validation

**Phase:** Engineering Integrity — PCV-6 / Deterministic Test Isolation.
**Branch:** `claude/futures-trading-simulator-v8qefu`.
**Starting commit:** `4480d04` (checkpoint tag `pcv6-determinism-start`).
**Companion docs:** `docs/PCV6_FAILURE_MAP.md` (reproduced evidence + root cause),
`docs/TEST_ISOLATION_ARCHITECTURE.md` (the fix).

## §39 — Summary fields

- **Problem:** `pnpm validate:release` could fail intermittently under
  shared-PostgreSQL contention though every suite passes in isolation.
- **Root cause (one):** `buildApp()` started fire-and-forget background workers
  (3 scanning startup sweeps, 5 pollers/listeners, the notification consumer)
  that outlived the test that created them and, in a shared single-process
  database, wrote into rows the next file was asserting on. Amplified by all
  files sharing one database.
- **Fix (two layers):** (1) gate those workers off under `NODE_ENV=test`
  (`backgroundWorkersEnabled()`), keeping the synchronous lifecycle subscribers —
  removes the escaping async at its source; (2) opt-in per-worker database
  isolation (`CREATE DATABASE … TEMPLATE` clone per fork, routed in
  `db/client.ts`) so parallelism is provably safe.
- **Two latent test flakes** the determinism harness surfaced and fixed (both
  pre-existing, neither a product defect, neither DB-contention):
  MFA at-rest tamper test flipped a bit-insignificant base64url padding char;
  notification delivery compared the due time against the Node clock instead of
  the DB clock.
- **Primary deltas:** `apps/server/src/config/env.ts`,
  `apps/server/src/http/app.ts`, `apps/server/src/db/client.ts`,
  `apps/server/src/platform/notifications.ts`,
  `apps/server/src/test/{worker-db,global-setup,setup-worker-db}.ts`,
  `vitest.config.ts`, `scripts/test-determinism.sh`, `package.json`, and two
  test-only fixes (`auth/mfa.test.ts`, `platform/notifications.test.ts`) + two
  env-literal test updates.
- **Status:** PCV-6 **RESOLVED** with deterministic proof (below). No product
  business rule changed; no test skipped, weakened, or removed; test count
  unchanged (net +0 cases; one consumer test now self-drives).
- **Commits:** `db177a2` (worker gating + isolation), `778e357` (MFA tamper),
  `5dc328e` (harness dirty-proof), `36e62c1` (notification DB-clock), plus this
  documentation commit.

## Proof (measured, this branch)

| Gate | Result |
|------|--------|
| Reproduction (serial canonical, once) | PASS once, but forced-concurrency reproduced non-determinism: 10 files/18 tests vs 16 files/56 tests on two back-to-back parallel runs (see failure map) |
| Server typecheck | PASS (clean) |
| Full server suite, serial, after fix | PASS — 192 files / 2360 tests, 1 file & 6 tests skipped (pre-existing `runIf(DEEP)` soaks), 0 failures |
| `pnpm test:determinism` (parallel + randomized order + per-worker isolation) | **10/10 iterations PASS** |
| Dirty/repeat-DB proof (reuse a prior run's dirtied clones) | **PASS** |
| `customer:certify` FAST | **PASS** — all 6 integrity invariants, 8 suites; CUSTOMER SYSTEM CERTIFIED (internal) |
| Canonical `validate:release` twice consecutively | **PASS twice** — run 1 exit 0, run 2 exit 0; 247 files / 3312 tests, 1 file & 6 tests skipped, 0 failures each (384s, 354s) |

Determinism harness detail: the server suite ran under file parallelism, 4
worker forks, each fork on its own `atlas_test_w<n>` clone, randomized file
order with a fresh seed each iteration, 10 iterations, every iteration recloned
from the freshly-prepared template (so each is also a fresh-DB proof), followed
by a two-pass dirty/repeat-DB proof on the fixture-based collision suites.

## §40 — The 18 hard questions (YES/NO + evidence)

1. **Was the failure reproduced before any fix?** YES — serial canonical run
   captured once (green), then forced file-parallelism reproduced a
   *non-deterministic* failure set (10 vs 16 files across two runs);
   `docs/PCV6_FAILURE_MAP.md`, logs `pcv6-parallel-repro.log`.
2. **Is the root cause identified and singular?** YES — escaping `buildApp`
   background workers contending on the shared DB; everything else (deadlocks,
   409s, balance mismatches, timing drift) flows from it.
3. **Is the fix at the source, not a mask?** YES — the escaping async is gated
   off under test (`backgroundWorkersEnabled()` in `env.ts`, applied in
   `app.ts`), so files no longer pollute one another even serially.
4. **Was serialization avoided as the primary fix?** YES — serial execution is
   kept only as defence-in-depth/legibility; the remedy is Layer 1, and true
   concurrency is *proven* by `pnpm test:determinism`, not avoided.
5. **Is a strong isolation model chosen and documented?** YES — per-worker
   database via `CREATE DATABASE … TEMPLATE` clone, routed centrally in
   `db/client.ts`; rationale in `docs/TEST_ISOLATION_ARCHITECTURE.md`.
6. **Is fixture identity unique and deterministic (not reliant on luck)?** YES —
   per-fixture `crypto.randomUUID()` identities already in place; verified
   collision-free by the dirty/repeat-DB pass (a repeat run on a populated DB).
7. **Is cleanup scoped (no global TRUNCATE/DELETE that kills others' state)?**
   YES — fixtures delete only their own rows by id; audited, none found; the
   category-C hazard is absent.
8. **Does the suite pass under file parallelism?** YES — 10/10 iterations of the
   full server suite under `--fileParallelism`.
9. **Does it pass under randomized file order?** YES — `--sequence.shuffle.files`
   with a fresh seed each of the 10 iterations.
10. **Does it pass 10/10 consecutive stress runs?** YES — harness exit 0,
    "ALL 10 ITERATIONS + DIRTY-DB PASSED".
11. **Does it pass on a freshly-prepared database?** YES — every stress iteration
    reclones from the freshly migrated+seeded template.
12. **Does it pass on a dirty/repeat database?** YES — two-pass proof: pass 1
    dirties and keeps the clones, pass 2 reuses them; both green.
13. **Was each real flake fixed (not dismissed as "Postgres flake")?** YES — two
    pre-existing latent flakes found by the harness were root-caused and fixed
    (MFA base64 padding tamper `778e357`; notification DB-clock `36e62c1`).
14. **Was any actual product concurrency defect found?** NO — every reproduced
    failure is test-isolation/timing, explained without a product race; the
    notification clock fix is a robustness improvement (benign in prod, worker
    retries), not a defect that could mis-handle customer money or state.
15. **Does `customer:certify` still pass (hardened core intact)?** YES — FAST
    PASS, all integrity invariants green, providers correctly MOCK/DELIBERATE.
16. **Does canonical `validate:release` pass twice consecutively, exit 0 both?**
    YES — run 1 and run 2 each exit 0, "RELEASE VALIDATION PASSED", 247 files /
    3312 tests, 0 failures (each re-prepares its own DB).
17. **Are the destructive test-DB guards production-safe and cross-platform?**
    YES — `prepare-test-db.sh` and globalSetup both refuse a database named
    `atlas`; globalSetup only drops its own `<base>_w<n>` clones; all Node +
    `postgres`-js + POSIX bash, no Windows/OS-specific paths; isolation is
    env/flag gated, so a normal `pnpm test` and CI are unaffected.
18. **Were the constraints honoured (no skipped/weakened/removed tests, no
    business-rule change, migrations intact)?** YES — zero `.skip/.only/.todo`
    added; no assertion weakened; test count unchanged; no product business rule
    changed; the full migration set (through `0038_celebration_acks`) applies in
    every prepared/cloned DB (the clone inherits it from the template).

## Engineering decisions made (no escalation required — §41)

- **Worker count / fork model:** fixed fork pool sized from CPU count, bounded
  to [2,4] (`HTF_TEST_DB_WORKERS`), one clone per fork.
- **Isolation primitive:** `CREATE DATABASE … TEMPLATE` (fast file-copy; inherits
  migrations+seed) over schema-per-worker or transaction-rollback, because
  `buildApp` opens its own pools and uses LISTEN/NOTIFY, which a shared-schema or
  outer-transaction model cannot cleanly isolate.
- **Connection routing:** central `HTF_TEST_WORKER_DB` remap in `db/client.ts`,
  so the ~30 hard-coded `atlas_test` test URLs are redirected without editing
  them; the variable is set only by the test setup and only under
  `HTF_TEST_ISOLATION=1`, so dev/prod behaviour is byte-identical.
- **Canonical stays serial; concurrency proven separately** via
  `pnpm test:determinism`.

Nothing in this phase touched money, credentials, legal surfaces, or caused
irreversible local-data loss, so no item was escalated to Nathan.
