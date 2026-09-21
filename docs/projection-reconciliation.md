# Projection & reconciliation

## The projection

`account_projections` (migration 0013) is the operational read model — a
DERIVED, rebuildable snapshot of each account's authoritative financial state.
`projectAccount(db, accountId)` recomputes it from authority (the `accounts`
row, open `positions`, working-order count) and upserts it inside one
transaction. Because it recomputes rather than applies a delta, it is idempotent
and self-correcting: a duplicate, an old, or an out-of-order delivery converges
on current truth rather than corrupting the row. A `setWhere state_version <=
account.seq` guard keeps the stored version monotonic.

Equity and unrealized P&L are **not stored** — they move with the market, not
with events. `valueProjection` applies live marks at read time, reusing the
engine's own `unrealizedPnlMicros`, so an unmarkable position (no price, or a
different `market_era`) reads **unknown, never a fabricated zero**.

## Version gaps

Because a projection event carries no delta — it just says "re-snapshot this
account" — a gap between event versions is a non-event: the recompute reads the
current authoritative seq regardless. The stored version therefore only ever
advances. There is no "apply 102 without 101" hazard to mishandle.

## Reconciliation

`reconcileAccountProjection` compares the stored projection against a fresh
authoritative snapshot — stateVersion, balance, realized P&L, fees, high-water
mark, drawdown floor, status, admin hold, rule status, open contracts, working
order count — and returns the diffs. Market-dependent fields (equity,
unrealized) are deliberately excluded: those are read-time valuations, not
stored truth. `reconcileAll` sweeps every account and returns those that drifted.

## Rebuild

`rebuildAllProjections` recomputes every projection from authority, in id-keyed
batches. It **touches no financial truth** — no fills, balances, lifecycle, or
audit — so it is safe to run after projection loss or corruption.

## Proven

`platform/projection-outbox.test.ts`: a corrupted projection (wrong balance and
version) is detected by reconciliation and repaired by rebuild; a missing
projection reports as drift; recompute is idempotent; unknown P&L stays unknown.
At 10,070 accounts a full reconcile found **0 drift**.
