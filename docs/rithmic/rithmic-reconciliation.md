# Rithmic Reconciliation (Milestone 9)

`domain/reconcile.ts` compares Atlas's recorded external state against Rithmic's
authoritative snapshots for ORDERS, EXECUTIONS and POSITIONS. Pure and
deterministic; the caller performs and audits any repair.

## Verdicts
- **MATCHED** — Atlas and provider agree.
- **MISMATCH** — they differ; `autoResolvable` only when Atlas is simply *behind*
  the provider's authoritative forward state (safe to adopt). A provider order Atlas
  shows as open but the provider has closed is a non-auto MISMATCH.
- **UNKNOWN** — an Atlas order with no provider id (lost ack): reconcile before any
  resubmit; never invent.
- **REQUIRES_REVIEW** — the provider has an order Atlas never recorded: never
  invented, a human reviews.

## Triggers
STARTUP, RECONNECT, PERIODIC, MANUAL. Runs are recorded append-only in
`provider_reconciliation_runs` (matched/mismatch/unknown/requires_review/
auto_resolved + detail). Discovered accounts are upserted to
`provider_discovered_accounts`; connection lifecycle to `provider_connection_events`.

## Unknown-state safety
Mirrors the M8 payout lost-ack rule: a submission that may have reached Rithmic but
whose response Atlas lost is `SUBMISSION_UNKNOWN` and must be reconciled against
the provider (by the stable `user_tag`) — a potential duplicate external order is
unacceptable.
