# Multi-Instance Resilience

**Proof that the database is the single authority — no correctness depends on any
one server process's memory.** Phase 3 of the engineering resilience programme.
Harness: `apps/server/src/platform/resilience/multi-instance.test.ts`.

## The property under test

In production the app runs as multiple processes behind a load balancer. Every
correctness guarantee must therefore hold **across processes**, not just within
one. The failure mode we attack: a guard that is actually enforced by
process-local state (a Map, a mutex, a cached value) rather than by the database
would pass single-process tests and then fail the moment a second instance runs.

## How it is simulated

`createDb(URL)` builds a **separate connection pool** (separate client, separate
process-local memory) against the **same** Postgres. The test spins up N such
handles:

```ts
const instances = Array.from({ length: 8 }, () => createDb(URL));
```

Each handle is, for correctness purposes, an independent server instance: it
shares nothing with the others except the database. If a guard depends on
in-process memory, these instances will disagree and the invariant will break. If
the guard is truly in the database (advisory lock, unique index, `FOR UPDATE`,
version CAS), all instances converge on the same authoritative outcome.

## What is proven across instances

| Scenario | Cross-instance race | Authoritative outcome proven |
| --- | --- | --- |
| **Active-account cap** | N instances each try to provision an account for the same user past the cap (2/5/8-way) | Exactly the cap is created; the rest are refused. The cap is enforced by the per-user advisory lock + count, not per-process. |
| **Reset successor** | 8 instances race to create the reset successor of one account | Exactly **one** successor exists; 7 are refused/idempotent. |
| **Funded transition** | 8 instances race `approveFunding` on one qualification | Exactly **one** funded account is produced. |
| **Payout approval (the money debit)** | N instances race to approve one payout | Exactly **one** balance debit + **one** DEBIT ledger row. The unique `(request, entry_type)` index makes a double-debit structurally impossible regardless of which process wins. |
| **Duplicate provider callback** | N instances deliver the same PAID/FAILED webhook | Exactly **one** SETTLEMENT (or **one** REVERSAL) row; redeliveries are no-ops. |

Every scenario uses the `Barrier` + `race` helpers from `attack-harness.ts` so the
contending calls actually overlap in time, and asserts the authoritative row count
after the dust settles.

## Why the guards hold

The database primitives that carry the authority (unchanged in Phase 3, only
proven here):

- **`pg_advisory_xact_lock`** — per-user (`USLK`) and per-account (`ACLK`)
  serialization of the critical section, held for the transaction and released on
  commit/rollback. Process-independent because the lock lives in Postgres.
- **Unique indexes** — reset successor, payout ledger `(request, entry_type)`,
  provisioning idempotency key — make duplicates a constraint violation, not a
  race the application has to win.
- **`SELECT … FOR UPDATE` + version CAS** — the account row is re-read under lock
  and the version compared, so a stale writer loses deterministically.
- **`FOR UPDATE SKIP LOCKED`** (outbox) — any number of worker processes drain the
  same table and never claim the same row twice (see the outbox soak in
  `soak-integrity.test.ts`).

## Cleanup caveat

`afterAll` deletes are best-effort (`try/catch`): the `payout_ledger` immutability
trigger blocks cascade-deletion of accounts that have ledger rows, so residue is
left on the shared test DB. This is harmless — the test DB is disposable and
`scripts/prepare-test-db.sh` rebuilds it from zero — and is *itself* a small proof
that the append-only guarantee holds even against a test's own teardown.

## Running it

```bash
bash scripts/prepare-test-db.sh
pnpm --filter @atlas/server exec vitest run src/platform/resilience/multi-instance.test.ts
```

## What this does NOT prove

- It does not exercise the OS/network partition layer (that is Phase 2's crash /
  fault-injection territory). It proves **logical** cross-process correctness on a
  healthy shared DB.
- It uses separate pools in one Node process rather than separate OS processes;
  since Postgres is the only shared state and each pool has its own client and
  memory, this is equivalent for the property under test. A true multi-process run
  exists separately (`scripts/multiprocess-reliability.ts`).
