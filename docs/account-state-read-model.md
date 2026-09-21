# Account state read model

## Authoritative state today

The authoritative account view is computed by the trading engine's
`valuation(accountId)`: balance and realized P&L from the `accounts` row (moved
only by atomic DB increments inside the fill transaction), positions from the
`positions` table valued against the current market, unrealized P&L derived, and
the account `seq` as the state version. Unknown marks stay unknown — a position
the market cannot price makes equity `null`, never a fabricated zero, and a
position is only priced by the `market_era` it was opened in.

Consumers — the trader terminal, the order ticket, the Owner Control Center
Trading/Risk pages — read this same authoritative state through REST, and the
terminal additionally receives live `acct.<id>.pnl` frames over WebSocket. They
do not invent their own truth.

## What this milestone did NOT build (deferred, stated plainly)

The milestone calls for a continuously-maintained **operational read-model
projection** (execution/market events → projection consumer → a pre-computed
account-state table) plus a **reconciliation** mechanism that compares the
projection against authoritative state and repairs drift.

This was **not built**. The reasons, honestly:

- It depends on the outbox **delivery worker**, which was also not built (see
  `event-reliability.md`). A projection with no consumer to feed it is not a
  projection.
- The V1/V2 owner dashboards value accounts-with-exposure synchronously per
  request. That is bounded by open exposure, not account count, and measured
  fine at the scales tested; it is a real limit at thousands of
  concurrently-in-trade accounts but not a correctness defect.

The prerequisites are now in place for it: contract identity on the immutable
records, the transactional outbox write on the account-service path, the account
`seq` as an ordering key, and the account lock to serialize the writes a
projection would follow. Building the projection consumer + reconciliation is the
recommended next milestone.

## Consequence for scale

Until the projection exists, owner Trading/Risk remain synchronous. This is
documented as the top remaining scale limitation, unchanged from the V2 report.
