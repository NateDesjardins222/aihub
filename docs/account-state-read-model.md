# Account state read model

## Authoritative vs derived (Phase 1 inventory)

| Field | Class | Where truth lives |
| --- | --- | --- |
| balance | AUTHORITATIVE | `accounts.balance_micros` (atomic increments in the fill tx) |
| realized P&L | AUTHORITATIVE | `accounts.realized_pnl_micros` |
| fees | AUTHORITATIVE | `accounts.fees_micros` |
| positions (qty, cost basis, side) | AUTHORITATIVE | `positions` |
| working orders | AUTHORITATIVE | `orders` (open statuses) |
| fills / commissions | AUTHORITATIVE | `executions` |
| drawdown floor / high-water mark | AUTHORITATIVE | `accounts` columns |
| account status / hold / rule state | AUTHORITATIVE | `accounts.status` / `admin_hold` / `rule_status` |
| state version | AUTHORITATIVE | `accounts.seq` (monotonic) |
| contract identity | AUTHORITATIVE | `orders/executions/trades.contract_code` |
| **equity** | DERIVED | balance + unrealized, at read time |
| **unrealized P&L** | DERIVED | positions × current mark, at read time |
| **remaining loss / MLL** | DERIVED | equity − drawdown floor |
| market mark / freshness | EPHEMERAL | market service (not stored per-account) |
| projection snapshot | PROJECTED | `account_projections` (rebuildable) |

Nothing derived or projected is a source of truth: all of it can be rebuilt from
the authoritative columns above.

## The projection (built this milestone)

`account_projections` (migration 0013) caches each account's authoritative
financial snapshot so owner and trader reads do not recompute every account from
scratch. `projectAccount` recomputes it from authority; `readAccountProjection`
returns it with equity/unrealized applied from live marks; `rebuildAllProjections`
rebuilds the whole set; reconciliation detects and repairs drift. See
`projection-reconciliation.md`.

Equity and unrealized are applied at read time, never stored, so the projection
never holds a stale valuation, and an unmarkable position reads unknown rather
than a fabricated zero.

## Consistency of consumers

The trader terminal and Owner Control Center both read authoritative state; the
terminal additionally applies live `acct.<id>.pnl` frames, now guarded so a
delayed or wrong-account frame cannot roll the display backward or bleed across
an account switch (see `cross-process-events.md`).

## Measured (10,070 accounts)

Projection read p50 0.57 ms / p95 0.78 ms / p99 1.16 ms; rebuild 263 accounts/s;
reconcile 0 drift. The sub-millisecond read is the point: owner Trading/Risk can
read the projection instead of running a synchronous valuation per account.

## Deliberately not done

Owner Trading/Risk **route handlers** were not yet switched from synchronous
`engine.valuation` to `readAccountProjection` in this milestone — the projection,
its worker, reconciliation and the measured read latency are in place, but
repointing those specific admin queries is the remaining wiring and is deferred
so it can be done with a browser regression pass. No trader-facing read was
changed except the client-side monotonic/switch guards.
