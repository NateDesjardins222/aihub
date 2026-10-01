# Test Isolation Architecture (PCV-6)

How the Happy Trader test suite is made **deterministic** — both as the serial
canonical validation and under real file parallelism. Read
`docs/PCV6_FAILURE_MAP.md` first for the reproduced evidence and root cause.

## The two-layer fix

The non-determinism had one source — background workers started by `buildApp()`
that escaped a test's lifetime and contended on a shared database — amplified by
one condition: all files sharing a single database. The fix addresses both.

### Layer 1 — remove the escaping async at its source (the real fix)

`buildApp()` no longer starts its scanning/polling background workers under
`NODE_ENV=test`. A single gate, `backgroundWorkersEnabled()`
(`apps/server/src/config/env.ts`), returns `false` when `NODE_ENV==='test'`
unless `HTF_BACKGROUND_WORKERS` forces it (`on`/`off`; default `auto`). Behind it,
in `apps/server/src/http/app.ts`:

| Started only when workers enabled | Why it is safe to gate under test |
|---|---|
| `certifyPassedEvaluations`, `fundEligibleQualifications`, `retryPendingProvisioning` (startup sweeps) | one-shot full-table scans; every test that means to exercise a sweep calls the sweep function directly |
| notification **consumer** + **delivery worker** | enqueue/deliver loops; the one test that exercises the consumer registers its own (scoped), delivery tests call `deliverPendingNotifications` directly |
| outbox worker + account `LISTEN/NOTIFY` listener | read-model projection loops; tests build their own `OutboxWorker`/`projectAccount` and drain deterministically; routes fall back to the `accounts` row when no projection exists |
| payout-ops worker, inactivity worker | durable retry loops; tests call `submitPayable`/`runInactivitySweep` directly |

**Kept on everywhere**, including test: the synchronous lifecycle event
subscribers (`recordEngineActivity`, `registerAutoCertification`,
`registerAutoFunding`, `registerProvisioningRecovery`, `registerRecognition`,
`attachCopyBreachHandler`) and `seedDefaultAgreements` (now `await`ed — it is a
one-shot committed write the acceptance-gate tests depend on, not a scanning
loop). These do not scan tables or outlive the request, so they do not pollute.

Why this is the fix and not a workaround: the escaping loops were the thing
writing to another test's rows after `close()`. With them gone, a file's effects
end when the file ends. This is what makes even the **serial** canonical suite
deterministic (it no longer depends on timing between one file's leftover worker
and the next file's assertions).

Production and development are unchanged: `backgroundWorkersEnabled()` is `true`
there, so every sweep, worker, and listener runs exactly as before. A deployment
can still force them in a test-like environment with `HTF_BACKGROUND_WORKERS=on`.

### Layer 2 — per-worker database isolation (makes concurrency safe + proven)

So the suite can be *proven* deterministic under parallelism (not merely kept
serial), each vitest worker fork gets its **own database**:

- **globalSetup** (`apps/server/src/test/global-setup.ts`) runs once before any
  worker and, for N forks, runs `CREATE DATABASE atlas_test_w<i> TEMPLATE
  atlas_test`. `TEMPLATE` is a fast file-level copy, so each clone already carries
  the **full migration set** (through `0038_celebration_acks`) and the seed
  catalog — no re-migration per worker. Teardown drops the clones.
- **setup file** (`apps/server/src/test/setup-worker-db.ts`) runs in each fork
  and sets `HTF_TEST_WORKER_DB` to that fork's clone (fork id via
  `VITEST_POOL_ID`, mapped 1:1 to a clone).
- **routing** (`apps/server/src/db/client.ts`): `createDb`/`getLockSql` send every
  connection to `HTF_TEST_WORKER_DB` when it is set. This is why the ~30 test
  files that pass a hard-coded `atlas_test` URL are redirected without editing any
  of them. `HTF_TEST_WORKER_DB` is set **only** by the setup file and **only** when
  `HTF_TEST_ISOLATION=1`; in dev/prod it is unset and the requested URL is used
  unchanged.

All three self-disable unless `HTF_TEST_ISOLATION=1`, so a normal `pnpm test` or
a web-only run is byte-for-byte unaffected and still uses the single prepared
database. Isolation is turned on only by the determinism harness.

## Fixture identity and cleanup (categories B and C)

Isolation is reinforced, not replaced, by the existing fixture discipline, which
was audited and found sound:

- **Unique identity**: `trading/harness.ts` and the platform tests derive user
  emails, profile keys and names from `crypto.randomUUID()` per fixture, so two
  files (or two runs on a dirty database) never collide on a fixed key.
- **Scoped cleanup**: fixtures delete only their **own** rows by id (e.g.
  `createFixture.close()` deletes its account, its template, its user). There is
  no global `TRUNCATE`/`DELETE` that could wipe another worker's or another
  file's state — the category-C hazard the brief warns about is absent, and was
  kept absent.

The dirty/repeat-DB proof (below) is what demonstrates these two properties
hold: a suite that passes again on a database already full of the previous run's
fixtures cannot be relying on a pristine database or on colliding identities.

## Why canonical stays serial (and that is not "the fix")

`vitest.config.ts` keeps `fileParallelism: false` for `pnpm test` /
`validate:release`. This is **defence in depth and legibility**, not the remedy:
Layer 1 already removed the cause, so serial is deterministic on its own merits;
serial additionally keeps one shared database easy to reason about and keeps
canonical's resource use predictable on CI. The brief's concern — serializing
*as the primary fix* — does not apply, because the primary fix is Layer 1, and
true concurrency is not avoided but **proven** by `pnpm test:determinism`.

## The determinism harness

`scripts/test-determinism.sh` (`pnpm test:determinism [iterations]`) runs the
server suite the hard way and is the concurrency proof:

- `HTF_TEST_ISOLATION=1`, `--fileParallelism`, `--maxWorkers=N` (per-worker DBs);
- `--sequence.shuffle.files` with a fresh seed each iteration (order-independence);
- repeated `iterations` times (default 10) — **10/10 green is the bar**, no
  retries, stop on first failure so a flake cannot hide;
- each iteration reclones from the freshly prepared template (**fresh-DB** proof);
- a final `HTF_SKIP_CLONE=1` iteration reuses the clones the last run dirtied
  (**dirty/repeat-DB** proof).

## Safety

- No destructive reset helper was added. `prepare-test-db.sh` and globalSetup
  both **refuse** a database named `atlas` (the canonical dev DB); globalSetup
  only ever drops databases matching its own `<base>_w<n>` clone naming.
- Cross-platform: everything is Node + `postgres`-js + POSIX `bash`; no Windows
  paths, no OS-specific calls.
- CI-compatible: isolation and parallelism are env/flag controlled; the default
  `pnpm test` behaviour is unchanged.
