# Trader Analytics — V1 (metric registry + architecture)

Deep, professional trading analytics computed from **authoritative server-side
data**, with one explicit definition per metric. The trader never hand-journals
basic performance. No client-side financial truth; no fabricated metrics.

---

## 1. Authoritative sources

| Source | What it provides |
| --- | --- |
| `trades` | round-trip records: side, qty, entry/exit ticks (x1e6), entry/exit time, `grossPnlMicros`, `feesMicros`, `netPnlMicros` (fees included), `maeMicros`, `mfeMicros`, `initialRiskMicros` (nullable), `tradeDate`, `contractCode`, `symbol` |
| `daily_account_stats` | per (account, tradeDate): starting/ending balance, realized P&L, fees, high/low equity, `counted` |
| `accounts` | balance, starting balance, realized P&L, fees, high-water mark, drawdown floor, trading/winning day counts, best day, status/holds, product version |
| `account_lifecycles` | lifecycle boundaries (reset/pass/fail), start/end, final balance/status |
| `account_profile_versions.config` | rules (profit target, MLL, drawdown, consistency, contract limit) + payoutRules (the account's immutable terms) |
| payout ledger / `account_qualifications` | payout debits, cycles, eligibility |

All money is integer micro-dollars. **Net P&L always includes fees** (`trades.netPnlMicros`).

## 2. Metric registry (one definition each)

Implemented as `platform/analytics-core.ts` — pure functions over trade/day
rows, with a definitions map so every surface uses the same math. Semantics:

**Trade classification**
- **Winning trade:** `netPnlMicros > 0`. **Losing:** `< 0`. **Breakeven:** `== 0`.
- **Win rate:** winning / (winning + losing) — breakeven excluded from the
  denominator (documented; a separate `breakevenRate` over all trades exists).

**P&L**
- realized P&L = Σ `netPnlMicros` of closed trades in range. Gross profit = Σ
  positive `netPnlMicros`; gross loss = Σ negative. Net P&L = realized (fees in).
- average trade = net / total trades; average win = gross profit / winning;
  average loss = gross loss / losing; largest win/loss = max/min `netPnlMicros`.
- unrealized P&L is shown only for a currently-open position (from the live read
  model), never mixed into historical realized aggregates.

**Ratios**
- **Profit factor** = gross profit / |gross loss|; when |gross loss| == 0 →
  reported as `∞`/undefined (documented), never a divide-by-zero.
- **Expectancy per trade** = net P&L / total trades (money), also expressed as
  win% · avgWin − loss% · |avgLoss|.
- **R-multiple / average R:** computed **only** for trades with a non-null
  `initialRiskMicros` (a stop was set at entry). realized R = `netPnlMicros /
  initialRiskMicros`. Trades without a stop are **excluded** from R stats and the
  UI says so — R is never fabricated. Average risk/reward likewise only where
  calculable.

**Durations** average winner/loser/overall duration from entry→exit times.

**Streaks** current and best winning / worst losing streak over trades ordered by
exit time.

**Day statistics** total trading days (`counted` days with ≥1 trade), profitable /
losing / breakeven days, % profitable — from `daily_account_stats`.

**Risk / drawdown**
- current drawdown = high-water mark − current balance (≥0); max drawdown =
  largest peak-to-trough on the equity curve (§4).
- MLL headroom = current balance − max-loss floor; contract limit + current
  exposure from the read model.

**Prop-firm progress** profit target + % (evals), consistency status + best day,
winning-day progress, payout eligibility/available/cycle/total, lifecycle status
— all from the authoritative rules/payout engine, not recomputed here.

## 3. Edge cases (documented + tested)

Partial fills / scale in-out / one position closed across multiple fills → a
`trades` row is already the settled round-trip (the engine writes one weighted
row), so analytics consume trades, not raw fills, avoiding double counting.
Commissions are in `feesMicros`/`netPnlMicros`. Breakeven = exactly 0 net.
Cross-midnight trades belong to their `tradeDate` (engine-assigned). Session
boundaries: time-of-day/session breakdowns bucket by exit time in the exchange
timezone. **Account resets and funded transitions** partition analytics by
`lifecycleId` (a reset starts a fresh lifecycle; the failed lifecycle's trades
stay in history). **Payout debits are not trades** and never appear in trade
analytics. Terminal accounts still expose their historical analytics.

## 4. Equity-curve semantics (precise)

Two distinct series, never conflated:
- **Trading-performance equity:** cumulative Σ `netPnlMicros` over trades in the
  lifecycle (starts at 0, or at starting balance for display). A **payout debit
  is not a point on this curve**, and a **reset is not a giant loss** — resets
  partition curves by lifecycle.
- **Actual simulated account balance:** the real balance over time, which *does*
  step down on payout debits and resets.
The drawdown curve is derived from the trading-performance equity (so a payout
withdrawal never shows as drawdown). Tested.

## 5. Breakdowns & filters

Where data supports it: P&L by instrument, win rate by instrument, long vs short,
day-of-week, session/time-of-day, duration buckets, date range. Filters: 7D / 30D
/ 90D / ALL / custom range, and instrument / long-short / session where relevant.
A metric that cannot be computed for a filter returns an explicit "unavailable",
not a fake zero.

## 6. Architecture / performance

- `platform/analytics-core.ts` — pure metric functions (unit-tested exhaustively).
- `platform/analytics.ts` — the service: loads a lifecycle's trades + daily stats
  in bounded queries (indexed by `(account_id, exit_time)` / `(account_id,
  trade_date)`), computes the registry, downsamples long time series for the
  curve. No N+1 across accounts (dashboard uses a single aggregate query per
  user). Caching only where safe (immutable terminal lifecycles).
- HTTP: `/api/v1/portal/accounts/:id/analytics?range=&instrument=&side=…`,
  IDOR-guarded to the owner. The dashboard summary is a separate lightweight
  endpoint.
- No materialized warehouse in V1; `daily_account_stats` is the pre-aggregation.
  Measure query latency; comfortable at realistic prop-firm scale.

## 7. Not fabricated

R-multiple/risk-reward only where `initialRiskMicros` exists; unrealized only for
a live open position; any metric lacking data is surfaced as unavailable. The
prerequisites for future exact-R capture (planned risk at entry) are documented.
