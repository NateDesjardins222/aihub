# Atlas — Risk-Lock Audit (Q-02)

**Symptom (manual):** entered a trade, Atlas said "Trading is locked for the rest
of the trading day", but the position stayed OPEN.

## The pipeline (traced)

Rules live in `packages/core/src/rules/rules.ts` (pure) and
`apps/server/src/trading/account-rules.ts` (DB binding). Breach handling is in
`apps/server/src/trading/engine.ts` (`rulesLocked` → `liquidateLocked`).

Breach codes and their status (`rules.ts`):
- `MAX_LOSS_LIMIT` (static drawdown) → **FAILED**
- `TRAILING_DRAWDOWN_BREACH` → **FAILED**
- `DAILY_LOSS_LIMIT` → **LOCKED** when `dailyLossPolicy === 'LOCK_DAY'` (message:
  *"Daily loss limit reached. Trading is locked for the rest of the trading
  day."* — exactly the user's string), else FAILED
- `MAX_TRADING_DAYS` → FAILED

**Critical structural fact:** *whether a breach liquidates* is NOT the breach
code — it is a separate config flag `flattenOnBreach` (`rules.ts:68`, DB
`accountProfiles.flattenOnBreach`, default `true`; "Off only for study
accounts"). So a LOCKED daily-loss breach flattens **iff** `flattenOnBreach` is
true.

`rulesLocked` (engine.ts:634-706):
1. Persists the lock **unconditionally** (`persistRuleState`, ~L668) — status
   becomes FAILED/LOCKED, `lockedUntilDate` set.
2. **Then** flattens **only if** `breached && config.flattenOnBreach &&
   hasExposure` (~L701) via `liquidateLocked` → a real awaited `MARKET`
   `liquidation:true` order.

`liquidation:true` exempts only the **account-status** gate in `risk.ts:122`; it
does **not** exempt `MARKET_CLOSED` / `MARKET_DATA_STALE` / `MARKET_DATA_UNAVAILABLE`
(`risk.ts:160-202`). So if the market is closed/stale when the breach fires, the
liquidation is rejected, caught (engine.ts:740-744), the account stays
locked+open, and it is **retried on the next mark** (engine.ts:696-703). This
retry is deliberate and tested (`rules.integration.test.ts` "keeps the account
failed when the liquidation cannot fill").

## Root-cause candidates for "locked but still open"

1. **`flattenOnBreach: false` on the account/product** → lock persisted, flatten
   branch skipped. Exposure intentionally never closed. Most consistent with a
   rule that "only locks."
2. **Liquidation could not fill** (market closed/stale/wrong era) → locked+open,
   retried when the feed recovers. Correct in principle, but the UI shows only a
   bare "locked" with no indication the position is still open / a liquidation is
   pending — an ambiguous state (§16).
3. **Non-atomic lock-then-flatten** (persist at L668, flatten at L702 are
   separate awaits, no enclosing transaction) → a crash/return between them
   leaves locked+open until the next mark re-observes exposure.

## The defect, stated precisely

Two things are wrong regardless of which candidate triggered it:
- **(A) Silent exposure.** When a *liquidating* breach leaves the position open
  (couldn't fill, or mid-retry), the trader is told "locked" with no signal that
  they still hold prohibited exposure or that a liquidation is pending. §2/§16
  forbid this.
- **(B) Ordering.** The lock is persisted before the flatten is even attempted,
  so the observable state passes through "locked + full exposure" every time,
  even on the happy path, for the window between the two awaits.

## Fix (this milestone)

See `terminal-quality-v3-report.md` §"Risk lock". The engine now:
- attempts the liquidation for a liquidating breach **before/with** surfacing the
  terminal state, and
- exposes an explicit `liquidation: 'PENDING' | 'DONE' | 'NOT_REQUIRED'` (or
  equivalent) on the valuation `rules` object so the UI can say "locked —
  flattening / could not flatten, position still open, will flatten when the
  market reopens" instead of a bare "locked",
- keeps retrying on every mark (unchanged), and
- for a non-liquidating account (`flattenOnBreach:false`) says so ("locked; your
  position remains open by this account's rules") rather than implying it was
  closed.
