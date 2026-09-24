# Happy Trader Performance & Analytics (Dashboard V2)

How the portal presents a trader’s performance — the interactive equity curve,
the metric registry, the P&L calendar, and the day → trade drilldown — and,
crucially, where every figure comes from. The short version: the portal
**surfaces** authoritative analytics computed on the server; it never recomputes
financial truth in the browser.

## Authoritative sources (never recomputed)

| Surface | Server source | Endpoint |
| --- | --- | --- |
| Equity curve, trade stats, breakdowns, drawdown, MLL headroom | `platform/analytics-core.ts` | `GET /api/v1/portal/accounts/:id/analytics?from&to&instrument&side` |
| Individual round-trip trades (drilldown) | `trades` table, owner-scoped | `GET /api/v1/portal/accounts/:id/trades?from&to` |
| Account balances, lifecycle, rules status | portal account projection | `GET /api/v1/portal/accounts/:id` |
| Payout eligibility (see the report) | `platform/payouts.ts` | `GET /api/v1/payouts/eligibility/:id` |

The analytics endpoint returns net P&L (fees included), win rate, profit factor,
expectancy, average win/loss, average R (only when a stop-at-entry is present),
best/worst day, max drawdown, streaks, the equity point series, and breakdowns by
instrument and side. The browser formats these; it computes none of them.

## The interactive equity curve

`Performance.tsx` renders the equity series (`analytics.equity.points`, each
point `{ tExitMs, equityMicros, drawdownMicros }`) as an SVG line + area
(`pt-equity`). Interaction:

- **Range selector** (`pt-range`): 1D / 7D / 30D / 90D / ALL. Changing the range
  re-fetches analytics *and* trades for that window — the curve, metrics,
  calendar and drilldown all move together.
- **Hover**: a crosshair snaps to the nearest point and a tooltip shows that
  day’s date, cumulative equity (coloured by sign) and drawdown.
- **Honest empty state**: with fewer than two closed trades in the range, the
  curve is replaced by a plain note ("Not enough closed trades in this range to
  draw a curve.") — never a flat or fabricated line.

The curve is cumulative net P&L over *closed trades* only. Payout debits and
account resets are not trades and never appear on it — a rule stated in the note
beneath the chart so a trader is never misled by a step that was a withdrawal.

## The metric registry

Below the curve, a metric grid renders the full registry from a single analytics
read: Net P&L, win rate, profit factor, expectancy, trades, average win, average
loss, average R (or `n/a` when there is no stop-at-entry sample), best day, worst
day, max drawdown, best streak. Each is a `Metric` primitive with a tabular
value. A metric that the server reports as unknown renders `—`, not `0`.

## The P&L calendar

`PnlCalendar` builds a Monday-aligned month grid spanning the first to the last
trading day in the range. Each day cell shows the day’s net P&L (coloured) and
trade count, aggregated **client-side purely for display** from the
server-provided per-trade rows — the trades themselves, their P&L and their
`tradeDate`, are all authoritative. A day with trades is clickable.

## Day → trade drilldown

Clicking a calendar day opens the trades table for that day (`pt-day-trades`):
time, instrument, side, quantity, gross, fees, net — one row per round-trip
trade, straight from `GET .../trades`. This is the equity-curve → day → trade
path the milestone calls for: from the shape of the curve, to a single day, to
the individual trades that made it.

The trades endpoint is strictly owner-scoped (`assertOwned`) and range-narrowed
by `tradeDate`; it returns at most 500 rows ordered by exit time, and exposes
only presentation-safe fields.

## Trading day, not calendar day

Everywhere a "day" appears — the calendar, the daily metrics, the risk controls’
daily counters — it is the **authoritative trading day** (`accountTradingDate()`,
the equity-index CME calendar that rolls at 17:00 Chicago), not the browser’s
local midnight. Daily P&L is realized net (fees included), computed on the server
as `balance − dayStartBalance`, and excludes payout debits, resets and admin
adjustments. The portal never derives a trading day in JavaScript.

## What the portal never does

- It never computes a balance, P&L, drawdown, eligibility, or streak — it reads
  them.
- It never invents a data point to fill a chart; sparse data is shown as sparse.
- It never reaches another trader’s account: every analytics, trades, and detail
  read is owner-scoped on the server, and an unowned id is denied (no IDOR).
