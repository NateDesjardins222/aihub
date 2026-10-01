# Customer Visualization Data Map (Experience Layer Phase 2)

Every visualization rendered in the canonical `/portal`, with its authoritative source. The
rule (§78): **no visualization without an authoritative source.** Where a dataset does not
exist, the surface shows an honest empty/absent state — it never fabricates a curve, a number,
or a cell. All money is integer micro-dollars; the only client arithmetic is presentation
aggregation of server-authoritative values.

Legend — **Exact**: value comes straight from an authoritative column/aggregate. **Derived**:
computed by the server's analytics core (pure functions over authoritative trades/days) or by
presentation aggregation of such values. **Owner-scoped**: filtered to the calling identity.

## Analytics (new tab)

| Visualization | Source (route) | Grain | Exact/Derived | Owner-scoped | Available |
|---|---|---|---|---|---|
| Portfolio realized P&L (summary) | Σ per-account `equity.finalEquityMicros` from `GET /portal/accounts/:id/analytics` | lifetime, per-account→portfolio | Derived (sum of authoritative per-account net P&L) | yes | ✅ |
| Paid to you (summary) | `GET /portal/progress` `hero.lifetimePaidTraderShareMicros` (Σ PAID trader share) | lifetime | Exact | yes | ✅ |
| Trading days / profitable days / % | per-account `days.*` (`analytics`, from `daily_account_stats`) | per-day→portfolio | Derived | yes | ✅ |
| Best / worst day | max/min of per-account `days.bestDayMicros`/`worstDayMicros` | per-day | Exact (per account) | yes | ✅ |
| Daily realized-P&L heatmap | per-account `GET /portal/accounts/:id/trades` → aggregate `netPnlMicros` by `tradeDate` | per-day, portfolio-aggregated | Exact (sum of authoritative trades) | yes | ✅ |
| Account comparison (P&L, win rate, profit factor, max drawdown, % profitable days) | per-account `analytics` (`equity`, `trades`, `days`) | per-account | Exact/Derived | yes | ✅ |
| Per-account equity sparkline | `analytics.equity.points[].equityMicros` | per-trade | Derived (cumulative net P&L) | yes | ✅ |
| Payout history | `GET /portal/payouts/history` (`payout_requests` projection) | per-request | Exact | yes | ✅ |

## Progress

| Visualization | Source | Grain | Exact/Derived | Available |
|---|---|---|---|---|
| Lifetime paid (focal) | `progress.hero.lifetimePaidTraderShareMicros` | lifetime | Exact | ✅ |
| Where You Stand (funded / evals / milestones) | `progress.hero.*` | lifetime counts | Exact | ✅ |
| The Journey (past → now → ahead) | `progress.memberSinceMs` + `progress.milestones[]` + `hero.nextClub` | per-event | Exact | ✅ |
| Clubs progression (rings + rail) | `progress.clubs[]` + `hero.lifetimePaidTraderShareMicros` vs thresholds | lifetime | Exact | ✅ |
| Tracked-goal progress ring | `goal.currentValue / targetValue` (server-resolved authoritative metric) | per-goal | Exact | ✅ |
| Accomplishments list | `progress.milestones[]` | per-event | Exact | ✅ |

## Dashboard / Payouts / Account detail (pre-existing, authoritative)

| Visualization | Source | Available |
|---|---|---|
| Payout standing (available, winning days) | `GET /payouts/eligibility/:accountId` | ✅ |
| Payout in-review total | `payout_requests` pending states (`/payouts/history`) | ✅ |
| Account equity / drawdown / profit-target progress (Account detail) | `GET /portal/accounts/:id/analytics` + detail | ✅ |

## NOT available — deliberately not drawn (no authoritative source)

| Would-be visualization | Why absent |
|---|---|
| Single cross-account portfolio equity **time-series** | No cross-account aggregate series endpoint; per-account only. Analytics composes per-account sparklines + a portfolio *summary* instead of a fabricated merged curve. |
| Consistency **time-series** | Only a point-in-time consistency ratio (`/payouts/eligibility`) and per-request snapshots exist; no stored daily consistency series. Not charted over time. |
| Portal-level cumulative performance chart on the Dashboard | No authoritative portfolio-series endpoint (carried from Convergence PCV-1). Per-account performance lives in Account detail; Analytics adds the daily heatmap + comparison. |
| "Last traded" per account as a dedicated field | Not surfaced authoritatively in the portal summary (derivable from `max(trades.exitTime)`); not shown rather than approximated. |

Any future visualization must be added to this map with its authoritative source before it is
drawn.
