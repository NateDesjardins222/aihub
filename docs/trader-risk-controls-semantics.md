# Trader Risk Controls — semantics (locked)

**Milestone 5.** The exact, deterministic, server-authoritative semantics of the
personal risk-control system. These definitions are the contract for the pure
evaluator, the fill-time counters, and the torture suite. Ambiguity here becomes
a financial-safety bug, so every rule below is explicit.

> **Firm rules always win.** Personal controls can only make an account MORE
> restrictive. `effective = min(firm, personal)`. A personal control never
> loosens a firm limit, bypasses MLL / lifecycle / execution safety, or removes a
> firm rejection.

---

## 1. The core safety semantic — never strand a position

The gate evaluates a control **only against the exposure-INCREASING portion of an
order** (`increasingQty(positionQty, signedOrderQty)` from `trading/risk.ts`).

- `increasingQty === 0` → the order does not add exposure → **always allowed**,
  regardless of any active personal lock. This covers: reducing a position,
  flattening, a protective stop, a protective target, cancelling an order, and
  reducing a bracket quantity.
- `increasingQty > 0` → the order would add exposure → each enabled control is
  evaluated; any breach rejects the order **before** the order row is created and
  before any fill, with a structured `PERSONAL_*` reason.

A personal lock never cancels existing protective orders and never auto-flattens
(unless a firm rule independently requires it). A trader who becomes locked while
holding a position keeps every risk-reducing action.

---

## 2. Trading day

The authoritative trading day is the engine's `accountTradingDate()` — the
equity-index CME calendar rolling at 17:00 America/Chicago, derived from the
**newest exchange timestamp across all instruments** (falling back to `Date.now()`
only with no feed), persisted as `accounts.currentTradeDate`. **Never** browser
local midnight. All per-day counters key on this date via `trader_risk_day_state
(accountId, tradeDate)`, so rollover resets them intrinsically. Locked-control
expiry compares `accountTradingDate()` against `lockedTradingDay`.

---

## 3. Trade count (Max Trades Per Day)

A "trade" is counted when an **opening/increasing fill first creates new exposure
for an originating order**.

- Counted: the first execution of an order whose fill increases exposure
  (`orders.openedExposure` flips false→true → `openingTradeCount += 1`).
- **Partial fills** of that same originating order do **not** add to the count
  (the flag is already set).
- **Not** counted: rejected orders, cancelled unfilled orders, pure position
  reductions, flatten-only actions (they never set `openedExposure`).
- **Reversal**: an order that closes existing exposure AND opens opposite
  exposure counts as **one** new trade for the newly opened side (its increasing
  portion sets `openedExposure`).

Pre-trade gate: if `openingTradeCount >= limit` and the order would open exposure,
reject `PERSONAL_MAX_TRADES` (an order that only reduces is never blocked, even at
the cap).

## 4. Total contracts traded per day (Max Total Contracts / Day)

Counts **filled opening/increasing quantity**, not submitted quantity. Each
increasing fill adds its increasing filled qty to `contractsOpened` (including
subsequent partials of the same order — this is a contract counter, not a trade
counter). Pure reductions add nothing. Pre-trade gate: reject
`PERSONAL_DAILY_CONTRACT_LIMIT` when `contractsOpened + increasingQty > limit`.

## 5. Daily loss (Personal Daily Loss Limit)

Uses the authoritative account day P&L — realized net trading P&L after
commissions/fees for the current trading day (`valuation().dayPnlMicros` /
`RuleStatus.dayRealizedPnlMicros`, whichever the account exposes;
fees-inclusive). Explicitly **excludes** payout debits, resets, account
purchases, and administrative ledger movements (those never touch trading day
P&L). Pre-trade gate: if `dayPnl <= -limit`, reject `PERSONAL_DAILY_LOSS_LIMIT`
for any increasing order. (Loss is a non-positive number; the limit is a positive
magnitude.)

## 6. Daily drawdown (Personal Daily Drawdown)

Uses an authoritative intraday high-water reference: `dayHighEquityMicros` — the
maximum account equity observed during the current trading day, seeded at day
start from `dayStartEquityMicros` and advanced at each fill/valuation.
`dayDrawdown = dayHighEquityMicros - currentEquityMicros`. Pre-trade gate: if
`dayDrawdown >= limit`, reject `PERSONAL_DAILY_DRAWDOWN`. Never a client-side
figure. When equity is unmarkable (null), the drawdown control does not fabricate
a value and does not block on it (documented; the firm staleness gate already
guards a dead feed).

## 7. Max position size (Max Position Size)

`|positionQty| + increasingQty > min(firmMaxContracts, personalMax)` → reject
`PERSONAL_MAX_POSITION`. Respects the firm/instrument maximum; a personal value
above the firm cap never raises the effective cap. Reductions never blocked.

## 8. Daily profit lock (Daily Profit Lock)

Once the authoritative daily net trading P&L reaches the threshold
(`dayPnl >= threshold`), lock **new/increasing** exposure for the remainder of the
trading day: reject `PERSONAL_PROFIT_LOCK`. Does **not** auto-flatten an open
position solely for reaching the threshold. Resets at trading-day rollover.

## 9. Consecutive loss lock (Consecutive Loss Lock)

`consecutiveLosses` is maintained when a round-trip trade closes:

- closed trade `netPnlMicros < 0` → `consecutiveLosses += 1`, set
  `lastLossClosedAtMs = exitTimeMs`.
- closed trade `netPnlMicros > 0` → `consecutiveLosses = 0`.
- **breakeven** (`netPnlMicros === 0`) → **neutral**: neither increments nor
  resets the streak, and does **not** start a cooldown. (Explicit, tested.)

Pre-trade gate: if `consecutiveLosses >= limit`, reject
`PERSONAL_CONSECUTIVE_LOSS_LOCK` for increasing orders. Resets at trading-day
rollover (new day-state row).

## 10. Loss cooldown (Loss Cooldown)

Begins when a qualifying **losing** trade (`netPnlMicros < 0`) closes, at its
`exitTimeMs`, using the authoritative trading clock. While
`now < lastLossClosedAtMs + minutes*60_000`, reject `PERSONAL_COOLDOWN` for
increasing orders. Breakeven and winning closes do not start a cooldown.

## 11. Trading window (Trading Window)

`windowStart`/`windowEnd` are `HH:MM` in the instrument's exchange timezone.
Outside `[start, end)` (evaluated against the authoritative exchange clock),
reject `PERSONAL_TRADING_WINDOW` for increasing orders. A window that wraps
midnight (`start > end`) is supported (allowed when `t >= start || t < end`).
Reductions always allowed.

## 12. Session restriction (Session Restriction)

Only to the extent the authoritative `SessionAuthority` / calendar answers
deterministically. Allowed sessions are stored as a set; if the current
authoritative session is not in the set, reject `PERSONAL_SESSION_RESTRICTION`
for increasing orders. No fake session concepts are invented; where the calendar
cannot authoritatively classify, the control does not block (documented).

---

## 13. Interaction rules (UI ↔ server)

- Typing a value does **not** enable a control. `enabled` is a separate explicit
  switch. Switching OFF preserves the configured value for later reuse.
- Every control persists server-side and survives refresh, logout/login, server
  restart, another device/browser, and Atlas ↔ Happy navigation. No client-only
  state.

## 14. Flexible vs Locked

- **FLEXIBLE**: the trader may edit, loosen, or disable whenever account
  permissions allow.
- **LOCKED**: until the next authoritative trading day the trader may **tighten**
  but may not increase the limit, loosen the restriction, or disable the control.
  Enforced server-side (disabled HTML controls are never trusted). Entering Locked
  requires explicit confirmation. `isStricter(controlType, old, new)` decides
  tighten vs loosen:

  | Control | stricter means |
  | --- | --- |
  | Daily loss / drawdown / max position / max trades / daily contracts / profit lock | a **smaller** value |
  | Loss cooldown | a **larger** value |
  | Consecutive loss lock | a **smaller** value |
  | Trading window | a **narrower** window (later start and/or earlier end) |
  | Session restriction | a **subset** of the allowed sessions |

  A locked control also cannot be disabled or moved back to FLEXIBLE before
  expiry. Expiry: `accountTradingDate() > lockedTradingDay`.

## 15. Validation (server)

Reject (structured `VALIDATION_*` / `INVALID_*`, never silent clamp): negative
amounts, zero where nonsensical, malformed times, impossible quantities,
NaN/Infinity, values outside safe integer/decimal range, invalid sessions,
values pretending to exceed firm permission (the value is stored but the
effective cap remains `min(firm, personal)`), malformed timezone/session input.

## 16. Copy trading

Each copied child order enters its own follower account's normal risk pipeline →
its own personal gate. One follower's personal rejection (`PERSONAL_*` in
`copyChildren.rejectCode`) never rolls back other followers or the leader. No
special "copy risk" logic — personal controls belong to each account.

## 17. Brackets

Protective stop/target orders reduce or cap exposure → `increasingQty === 0` →
always allowed, even when locked. Any bracket child that would increase exposure
goes through the normal gate.

## 18. Lifecycle restrictions

Controls can only be mutated on an account the customer owns that is in a state
where trading configuration is meaningful (ACTIVE/PENDING). Archived / failed /
completed / disabled accounts cannot mutate controls (reject). Reading controls
remains allowed for history.

## 19. Auditability

Every control change writes a `trader_risk_control_events` row (account,
customer, control, old→new value/state, mode, effective trading day, actor,
source, timestamp) and, for consequential changes (lock, enable of a hard lock),
a tamper-evident `recordAudit` row. Owner/admin can inspect a **read-only**
history and current effective state; there is no owner path to loosen a trader's
locked control.
