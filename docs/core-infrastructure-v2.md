# Core Infrastructure V2

Architectural hardening to prepare Atlas for multiple processes, professional
market data, large-scale operation, and eventual external execution providers —
without a rewrite when those arrive. Baseline `66e2aa8`.

This milestone was scoped deliberately, not exhaustively. It began with an
architecture autopsy (`core-infrastructure-v2-autopsy.md`) that retired two
supposed problems (a market-data provider seam already existed; Redis holds
nothing, so it cannot lose financial truth) and focused the work on the
foundations the STOP condition actually names.

## What was delivered

| Area | Status | Where |
| --- | --- | --- |
| Architecture autopsy | done | `core-infrastructure-v2-autopsy.md` |
| Contract identity (types, resolver, persistence) | done | `contract-identity.md` |
| Distributed correctness (advisory account lock, transactional transitions) | done | `distributed-correctness.md` |
| Execution provider seam | done (interface + sim adapter) | `provider-abstraction.md` |
| Market-data provider seam | pre-existing; documented | `provider-abstraction.md` |
| Event reliability (transactional outbox write; Redis N/A) | partial | `event-reliability.md` |
| Account-state read model + reconciliation | deferred | `account-state-read-model.md` |

## The STOP condition, answered

- **Two servers corrupting one account** → the engine and account-service now
  serialize every account mutation through a PostgreSQL advisory lock keyed by
  account, proven across independent connections.
- **A duplicate event duplicating money** → write-path idempotency
  (`clientOrderId` unique + pre-check; provisioning keys) is unchanged and holds;
  the account-service outbox write is now transactional with its mutation.
- **A restart losing financial truth** → all financial truth is in Postgres;
  nothing depends on Redis (which is unused). Durable across restart by
  construction.
- **NQ and its actual contract confused** → orders, fills and trades now persist
  the specific `TradableContract` (NQZ26), resolved deterministically.
- **The owner dashboard disagreeing with the trader** → both read the engine's
  authoritative valuation; unknown stays unknown, never a fabricated zero.
- **Choosing Rithmic/CQG/Databento forcing a rewrite** → market data already has
  a capability-based provider seam; execution now has one too, satisfied by the
  simulator. Adding a provider is a new implementation, not a rewrite.

## What was NOT done (see each doc for detail)

The read-model projection and its reconciliation, the outbox delivery worker and
cross-process fan-out, a full infrastructure torture harness at 1k/10k with
multi-worker OS processes, deliberate failure injection, and the end-to-end
acceptance scenario were **not built or not run**. They are named — not implied
— in `core-infrastructure-v2-test-report.md`, which does not sanitize the result.

## Preserved invariants

SMOOTH interpolation remains visual-only. Money still moves by atomic DB
increments inside one transaction. The audit chain remains hash-linked and
append-only. `market_era` still prevents cross-market P&L. No terminal or
charting redesign; no new features; no faked providers or market data.
