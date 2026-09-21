# Account State + Event Reliability V1

Baseline `57bfd5f`. Where V2 made Atlas safe at WRITING financial truth, this
milestone makes it reliable at READING, DISTRIBUTING, PROJECTING, RECOVERING and
RECONCILING it. PostgreSQL remains the only source of financial truth; every
other component is rebuildable from it.

## Pipeline

```
trading / owner action
  -> authoritative transaction (money as atomic increments; V2 advisory lock)
  -> transactional outbox row (same commit)              [outbox-delivery.md]
  -> delivery worker (FOR UPDATE SKIP LOCKED, retry, dead-letter)
  -> idempotent projection consumer (recompute from authority)
  -> account_projections (durable read model)            [account-state-read-model.md]
  -> NOTIFY atlas_account_changed                        [cross-process-events.md]
  -> every instance LISTENs, re-publishes to its WebSocket subscribers
  -> trader terminal / Owner Control Center
```

## What was built

- **Read model** (`account_projections`, `platform/projection.ts`): a durable,
  rebuildable snapshot; equity/UPL applied from live marks at read time (unknown
  stays unknown). Read p50 0.57 ms at 10k accounts.
- **Transactional outbox + worker** (`platform/outbox.ts`): SKIP LOCKED claiming,
  at-least-once delivery, idempotent consumers, retry/backoff/dead-letter.
- **Reconciliation** (`platform/projection.ts`): detect drift, rebuild from
  authority without touching financial truth. 0 drift at 10k.
- **Cross-process fan-out** (`platform/account-notify.ts`, gateway): LISTEN/NOTIFY
  wake-up; durable state is truth. No Redis.
- **Client consistency**: monotonic frames, account-switch guard.
- **Execution routing**: order flow goes through the `ExecutionProvider` seam.
- **Real multi-process proof** (`scripts/multiprocess-reliability.ts`): SKIP
  LOCKED, SIGKILL crash recovery, and the advisory lock across actual OS
  processes.

## Docs

`account-state-read-model.md`, `outbox-delivery.md`,
`projection-reconciliation.md`, `cross-process-events.md`, `failure-recovery.md`,
`multiprocess-testing.md`, and the unsanitized
`account-state-event-reliability-v1-test-report.md`.

## Not done (named, not implied)

Owner Trading/Risk route handlers still call synchronous `engine.valuation`
rather than the projection (the projection + latency proof are in place; the
repoint is deferred for a browser regression pass). A single scripted 50-step
end-to-end scenario and a dedicated randomized torture harness were not
assembled as artifacts — their guarantees are covered piecewise by the unit
suite and the multi-process harness. Full browser UI regression was not run this
milestone; the order path was validated by the 783-test suite and a live REST
end-to-end (order → outbox → worker → projection). See the test report.
