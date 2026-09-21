# Event reliability

## What exists

- **Outbox table** `domain_events` with `delivered_at`, `attempts`, `last_error`
  and an undelivered index — built for a drain worker.
- **Idempotency** on the write path: `orders(account_id, client_order_id)` unique
  plus a submit pre-check (a repeated `clientOrderId` returns the existing order,
  never a second); provisioning idempotency keys with a request-hash so the same
  key with a different body is a conflict, not a silent second account.
- **Append-only audit chain**: hash-linked (`prev_hash`), guarded by a
  per-organisation advisory lock so concurrent writes cannot fork it, and
  immutable at the database level by trigger. `verifyAuditChain` recomputes and
  checks it end to end.
- **Ordering**: financial ordering uses the account `seq` (monotonic, DB-issued)
  and position `version`, not wall-clock timestamps.

## Changed this milestone

`account-service.transition()` now writes the state change, its audit row **and**
its outbox event inside one transaction. Previously the outbox insert was a
separate auto-commit, so a crash between the state change and the event could
orphan or drop it. On this path they now commit together or not at all.

## Redis

Redis is **not used** anywhere in Atlas (only an unused `REDIS_URL` default). No
cache, pub/sub, lock, session, or financial state lives in Redis. Therefore
"Redis failure" cannot corrupt or lose financial truth — there is nothing to
lose. The milestone's Redis-failure matrix is answered by this fact rather than
by degradation code. If Redis is later adopted (e.g. for cross-process pub/sub),
financial truth must remain in Postgres and this document must be revised.

## WebSocket

`ws/gateway.ts` publishes market data and per-account trading streams sourced
directly from the in-process engine callbacks (not from the outbox, not from
Redis). Account streams are authorized per user + per account, snapshot on
subscribe, and support resume-by-seq.

## Deliberately not done (deferred, and named honestly)

- **No delivery worker.** `pendingEvents`/`markDelivered` are defined but not
  driven; `delivered_at` is not set at runtime and no runtime consumer is
  registered. Domain events are, in practice, write-only apart from the
  account-service path now writing them transactionally. A drain worker with
  idempotent, at-least-once delivery and dedupe by event id is the next step and
  was **not built**.
- **No cross-process fan-out.** WebSocket fan-out is in-process; a second
  instance would not broadcast another instance's fills. This needs the outbox
  worker or Redis pub/sub and is deferred.
- **Outbox recovery / duplicate-delivery / consumer-restart tests were NOT run**,
  because there is no consumer yet to test. The transactional-outbox write is in
  place so that when the worker is built, the row is guaranteed to exist whenever
  the state change committed.
