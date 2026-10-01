# Portal V2 — Performance Metrics

How performance is shown at two levels — portfolio (dashboard) and per-account (detail) — and
the rule that every series comes from authoritative data with a truthful empty state.

## Portfolio level (Dashboard)
`PortfolioPerformance` + `V2AreaChart` render **cumulative realized P&L** across the customer's
accounts.
- Series: `SeriesPoint[] { t, v }`. Production = one authoritative projection summing realized
  P&L across accounts over time. Dev review = `FIXTURE_PORTFOLIO_SERIES` (a seeded, clearly
  dev walk).
- Range buttons (30D / 90D / All) **slice the same series** — they never fabricate new points.
- `< 2` points → "No trading history yet" empty state; the range buttons hide. The chart never
  draws an invented line.
- `V2AreaChart` is dependency-free SVG (champagne stroke, faint fill, zero baseline), returns
  `null` below 2 points, and the caller owns the empty state.

## Account level (Account detail → Performance tab)
`PerformanceTab` reads authoritative analytics for the account:
- Equity curve from `equity.points` (closed-trade exits), rendered by `EquityCurve` — only
  with ≥2 closed trades; otherwise "No closed trades yet".
- Metrics: win rate, averages, best/worst day, max drawdown, breakdowns by
  instrument/side/day — all from the analytics projection, never computed from fake inputs.
- Unavailable analytics degrade to a truthful "Performance is unavailable" state.

## Dashboard summary metrics
Total balance, net P&L, active accounts, evaluations, funded, total paid — all derived from
the authoritative accounts projection and payout read model. Net P&L tone is sign-driven.

## Rules
1. No fabricated chart data at any level. Empty/short series → empty state.
2. Money is integer micro-dollars; display via `formatMoney` with tabular numerals.
3. Portfolio and account series are authoritative projections, not client recomputation.
4. Zero-customer: empty portfolio series → empty state; dashboard metrics read zero.

## Seams / debt
- The portfolio cumulative-P&L projection endpoint is the production source to wire for the
  dashboard chart; until then the container must supply the series (the component is ready).
- Benchmarks / period-over-period comparisons are not yet modelled.

---
## Review #3 — real interactive chart
The static SVG was rejected. `perf-chart.tsx` (`V2PerfChart`) now uses lightweight-charts (the same
library Atlas uses; independent of Atlas) for a real crosshair, date/value tooltip, responsive
resize, and themed rendering. Ranges 7D/30D/90D/YTD/All slice ONE authoritative cumulative series
(never fabricate points); companion metrics (period P&L, best/worst day, trading days, avg/day) are
derived from the same data. `<2` points → truthful empty state. Account detail keeps its authoritative
EquityCurve. Reconciliation: period P&L = sum of daily deltas in the window = last−baseline.
