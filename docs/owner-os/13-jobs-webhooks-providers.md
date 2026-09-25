# Owner OS — Jobs, Webhooks, Providers, Market Data & Execution Quality

Module: `ops-io.ts`
Routes: `/api/v1/admin/ops/jobs`, `/jobs/:id/retry`, `/providers`, `/market-data`

## Jobs / queues (the outbox)

`jobsSummary(db)` reports queued / delivered / dead-letter / retrying counts over
`outbox_events`. `listJobs(db, { state })` lists them; `retryJob(db, id, actor)`
safely re-arms a dead-letter job (clears the dead-letter flag and last error so the
worker retries) and **refuses to retry an already-delivered job**. Managing jobs
requires `system.jobs.manage`; reading requires `system.read`. Every retry is
audited.

## Webhooks

Webhook delivery health is surfaced from the same outbox/delivery records — no
separate source of truth. Managing webhooks requires `system.webhooks.manage`.

## Providers — truthful status

`providerStatuses(db)` reports each provider's real posture. **Rithmic is never
marked `verified` from code alone**: architecture existing is not the same as an
authenticated, verified live connection, and M9 did not complete a live Rithmic
acceptance. The console shows configured vs verified honestly and defaults to "not
verified".

## Market data integrity

`marketDataIntegrity()` lists the eight launch instruments with a truthful
`NOT_VERIFIED` status until a real, authenticated data feed is confirmed. It never
fabricates a "live" data status.

## Execution quality

`executionQuality(db, windowHours)` returns bounded counts (executions, orders by
status) over a recent window — a real, measured summary, not an invented SLA.
