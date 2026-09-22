# Atlas owner operations runbook

Practical, operational guidance for running the firm from the Owner Control
Center (`/admin`). Roles: SUPPORT reads, ADMIN acts, SUPER_ADMIN changes what
products/people are allowed to be. Everything you see is scoped to your firm.

## Find a trader
Owner → **Traders**. Search by name or e-mail. Use the filter chips (has
evaluation, has funded sim, on hold, no accounts) to narrow. The table shows
each trader's evaluation and funded-sim counts and when they last traded. Click
a row for the full profile.

## Find an account
Owner → **Accounts** (search by number or name, filter by status), or open the
trader and click the account. Firm-wide positions/orders link straight to the
account too (Owner → Trading).

## Understand an account's status — "why is it locked?"
Open the account. The banner at the top states it plainly:
- **TRADEABLE** — ACTIVE/GOAL_REACHED, can trade.
- **PASSED** — evaluation passed (and, if QUALIFIED, eligible for funding).
- **FAILED** — with the failure reason (e.g. MAX_LOSS_LIMIT).
- **ADMIN_HOLD** — an operator placed a hold (the hold value is shown).
- **RISK_LOCK** — a rule locked it.
- **PENDING / ARCHIVED / DISABLED** — not activated / retired / disabled.
This is the same status the order gate enforces; if it says cannot trade, the
trader cannot place an order.

## View open positions / working orders / recent fills (firm-wide)
Owner → **Trading**. Tabs for Positions, Working orders, Recent fills; filter by
trader, account or symbol. Marks are applied at read time; a position that
cannot be marked shows "—", never a fake zero.

## See firm exposure
Owner → **Trading → Exposure**. Per-instrument gross long / gross short / net
**contracts**. Minis and micros are separate rows (NQ is not MNQ); each shows its
$/point. Click a row to see which accounts create the exposure. "mark unknown"
means some positions can't be priced right now — not zero risk.

## See who's near failure / on hold / recently failed
Owner → **Risk**: accounts nearest their loss boundary, largest open losses,
on-hold accounts, recent failures — all from live marks and authoritative status.

## View a trader's history / lifecycle
Open the trader → the Accounts panel lists all accounts including historical
(passed/failed/archived); Activity lists their audited events; each account's
detail has its lifecycles and commercial linkage (evaluation ↔ funded).

## Add an internal note
Open the trader → **Staff notes** → pick a category (general/support/risk/
account), type, Add note. Notes are internal — the trader never sees them — and
append-only; an ADMIN can redact a note (its body is hidden, the row kept).
Every write is audited.

## Explore the audit trail / "why did this happen?"
Owner → **Audit**. Filter by action, actor, subject type, time. Click a record
to see its before/after metadata (secrets are never recorded). To trace one
account, open it and read its Audit panel; account and trader links jump across.

## Approve or decline funding
Owner → **Funding**: the passed queue (ELIGIBLE) with Approve / Decline. Approve
provisions exactly one FUNDED_SIM account linked back to the evaluation;
approval is idempotent (a double-click never funds twice). Decline requires a
reason.

## Inspect system health
Owner → **System**. Honest states:
- **Database / API** — up/down.
- **Market data** — DELAYED/DEGRADED/OFFLINE (the dev feed is delayed by
  design; it is never shown as real-time).
- **Audit chain** — hash-chain verification.
- **Projections** — total and any inconsistent (drifted) — investigate if
  DEGRADED.
- **Outbox** — pending, dead-letter, oldest-pending age — a growing backlog or
  any dead-letter means delivery has stalled.
- **Payments (Whop)** — NOT_CONFIGURED (sandbox credentials absent) or
  AWAITING_VALIDATION. Never "connected"; payments are paused at sandbox.

## Investigate a projection issue
If System shows Projections DEGRADED (inconsistent > 0), the read model drifted
from authority for some account(s). The projection is rebuildable from
authoritative state (`reconcileAll` / `rebuildAllProjections`); authority (the
accounts/positions tables) is never wrong because a projection is. Confirm the
account's authoritative balance/positions before acting.
