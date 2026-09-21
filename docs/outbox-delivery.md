# Outbox delivery

## The table

`outbox_events` (migration 0013): `id`, `aggregate_type` (ACCOUNT),
`aggregate_id`, `type`, `state_version`, `payload`, `created_at`, `available_at`
(retry backoff), `attempts`, `delivered_at`, `last_error`, `dead_letter`.

A financial mutation enqueues a row **in its own transaction** (`enqueueOutbox`):
the engine's fill transaction, and account-service transition/reset transactions,
all insert an `account.changed` row alongside the state change. So a row exists
whenever the change committed — no lost event. A resting-order submit/cancel
enqueues best-effort (the consumer recomputes from authority, so a missed nudge
self-heals).

## The worker

`OutboxWorker` (`platform/outbox.ts`) claims with
`... WHERE delivered_at IS NULL AND dead_letter = false AND available_at <= now()
ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT batch`. SKIP LOCKED means any
number of workers (or Atlas instances) drain the same table and never own the
same row. The handler runs **inside the claiming transaction**, so the handler's
work (the projection update) and the delivery mark commit together; a worker
that dies mid-tick rolls the whole transaction back, the rows unlock, and
another worker reclaims them.

- **Retry / backoff:** a failing handler increments `attempts` and sets
  `available_at = now() + min(base·2^attempts, cap)`.
- **Dead-letter:** after `maxAttempts` the row is parked (`dead_letter = true`)
  rather than looping forever.
- **Optionally sharded:** a worker may be scoped to one `aggregate_id` (used by
  tests, and available for a sharded fleet).

## Delivery semantics

**At-least-once.** There is no distributed exactly-once. Because the handler and
the delivery mark commit atomically, the "processed but not marked" window does
not exist within one tick; but a redelivery is still possible in principle (e.g.
a manual re-enqueue), and it is **harmless** because the consumer is idempotent
(the projection recomputes from authority). At-least-once delivery + idempotent
consumers = no duplicate financial effect.

## What is proven

`platform/projection-outbox.test.ts`: drains a backlog delivered-exactly-once;
two workers never process the same event (SKIP LOCKED); a failing handler backs
off and dead-letters after max attempts; a redelivery to the projection consumer
is harmless. `scripts/multiprocess-reliability.ts` proves the same across real
separate processes, including SIGKILL crash recovery.

## Measured

10,070 accounts: backlog drain 272 events/sec (each event = one recompute-from-
authority projection). See `account-state-event-reliability-v1-test-report.md`.
