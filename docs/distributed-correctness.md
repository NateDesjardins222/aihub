# Distributed correctness

The goal: two Atlas processes sharing one database cannot corrupt one account.

## The problem

Every account mutation ran through an in-process `KeyedMutex` (`trading/mutex.ts`).
That serializes one Node process. It guards nothing shared: Server A and Server B
each have their own mutex, so both could read the same position and both decide a
stop fills — a double fill. And `account-service.transition()` was a
non-transactional read-modify-write with no lock at all, so an owner hold could
interleave with a trader fill, and two transitions could both read `ACTIVE` and
both act.

## The mechanism

A **PostgreSQL advisory lock**, keyed by account, layered under the in-process
mutex (`trading/account-lock.ts`). An advisory lock is held by a database
*session* (connection), so two independent connections — and therefore two
independent processes — contend on it correctly. Postgres cannot tell
same-process-different-connection from different-process, which is why the tests
can prove the cross-process guarantee from one test process using independent
pools.

- `AccountLock` — the engine's lock. In-process mutex (fast path) **plus**
  `pg_advisory_lock(classid, objid)` on a **dedicated lock pool** (so a held lock
  never starves the query pool). The engine takes it through its single
  `mutex.run(accountId, …)` chokepoint — all 11 mutation entry points.
- `account-service.transition()` — now one transaction that takes the **same**
  advisory lock (`pg_advisory_xact_lock`, transaction form of the same key),
  re-reads status `FOR UPDATE` (closing the TOCTOU), and commits the state
  change, its audit row and its outbox event together. `resetAccount` takes the
  lock too.

Because the engine (session form) and account-service (transaction form) use the
same two-int key, they block each other: an owner action and a trader fill on one
account serialize, across processes. The audit chain's own advisory lock uses the
single-argument form — a distinct lock space — so the two never collide.

## State version

`accounts.seq` is a database-authoritative, monotonic counter, advanced inside
the fill transaction (`nextSeq`) and on each account event. It is the account's
state version: it is returned in every `EngineChange` and drives WebSocket
snapshot/resume. Positions carry their own `version` column, advanced on every
update. Both give stale-write detection and deterministic ordering.

## What is proven

`trading/distributed-correctness.test.ts`, across independent connections:

- a racy read-modify-write guarded by the lock loses no update (result is exactly
  2, not 1);
- different accounts run concurrently (the lock is per account, not global);
- the lock is released even when the guarded work throws;
- of five simultaneous holds on one `ACTIVE` account, **exactly one** wins and
  four are refused as an invalid transition — no double transition, no lost
  update.

## Honest limits

- The proof uses independent **connections** in one test process. That is the
  exact condition two OS processes create (advisory locks are connection-scoped),
  but genuinely separate processes were **not** spawned — labelled SIMULATED in
  the report.
- The engine's critical section is guarded by a session-level advisory lock
  wrapping the existing read-decide-persist flow; it was **not** rewritten into a
  single transaction. This is correct (the lock provides the mutual exclusion,
  the existing short transaction provides atomicity) and far less invasive, but
  it means the lock is held across application logic, not only across a database
  transaction.
- Idempotency (which prevents *duplicate submits* regardless of the lock) is
  unchanged: `orders(account_id, client_order_id)` unique + a submit pre-check;
  provisioning idempotency keys.
