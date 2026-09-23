# Atlas — V5 execution & risk-lock integrity

## The "LOCKED while the position stayed open" bug — exact root cause

The trader entered a trade and Atlas showed *"Trading is locked for the rest of
the trading day"* while exposure remained. Traced end to end
(`engine.ts` `rulesLocked` → `liquidateLocked`):

1. `rulesLocked` evaluates the rules on the current mark and, when a breach
   flips the status, **persists the lock/fail status first, unconditionally**
   (`persistRuleState`, engine.ts ~668).
2. **Then, separately**, it attempts a flatten *only if*
   `breached && flattenOnBreach && hasExposure` (engine.ts ~701) via
   `liquidateLocked` → cancel working orders → a real `MARKET liquidation:true`
   order per open position.
3. The lock write and the flatten are **two independent awaits with no linkage.**
   So the account is marked LOCKED/FAILED whether or not the position actually
   closed. If the liquidation cannot fill — the market is closed or the feed is
   stale (common on the delayed dev feed; order entry is gated on freshness, and
   `liquidation:true` exempts only the account-status gate, not the stale/closed
   gate) — or if the account's rule is `flattenOnBreach:false` (a block-only
   lock), the account sits **LOCKED + open**, and the terminal showed only
   "locked" with nothing to say exposure remained.

So `LOCKED = true` while `position qty ≠ 0` is reachable through three doors:
a liquidation that can't fill yet (retried on every later mark), a non-flattening
lock by policy, and — before the fix — the window between the lock write and the
flatten confirming.

## The fix: an explicit, authoritative liquidation state (§2/§3)

The engine now reports the truth on every valuation, instead of the UI inferring
it. `AccountValuation.liquidation: 'NOT_REQUIRED' | 'PENDING' | 'DONE'`
(`liquidationStateOf(status, flattenOnBreach, openContracts)`):

- **NOT_REQUIRED** — not breached, OR a block-only lock (`flattenOnBreach:false`):
  the position remains open *by the account's rules*, not by failure.
- **PENDING** — breached, this account flattens on breach, and exposure REMAINS:
  the flatten is in progress or could not fill yet. The account is locked AND
  still exposed. The terminal must not imply flat.
- **DONE** — breached, flattens on breach, and it is flat. Safe to read "locked".

This is carried authoritatively from the engine through the WS frame and the REST
`/pnl` DTO to the client store (monotonic-`seq`-gated like all money), and the
AccountBar now shows a **FLATTENING** pill whenever `liquidation === 'PENDING'`,
so a locked-but-exposed account can never read as a clean "locked" again. The
engine's existing retry-on-every-mark behaviour is unchanged — it keeps trying to
flatten — but now the state is truthful while it does.

### Risk-rule semantics matrix (as implemented)

| Rule (code) | Trigger | Blocks new orders | Cancels working | Liquidates position | Lock | Reset |
| --- | --- | --- | --- | --- | --- | --- |
| MAX_LOSS_LIMIT (static drawdown) | equity ≤ floor | yes (FAILED) | if `flattenOnBreach` | if `flattenOnBreach` | terminal (FAILED) | account reset |
| TRAILING_DRAWDOWN_BREACH | equity ≤ trailing floor | yes (FAILED) | if `flattenOnBreach` | if `flattenOnBreach` | terminal | account reset |
| DAILY_LOSS_LIMIT (policy LOCK_DAY) | day P&L ≤ −limit | yes (LOCKED) | if `flattenOnBreach` | if `flattenOnBreach` | until next trading day | day roll |
| DAILY_LOSS_LIMIT (policy FAIL) | day P&L ≤ −limit | yes (FAILED) | if `flattenOnBreach` | if `flattenOnBreach` | terminal | account reset |
| MAX_TRADING_DAYS | days elapsed | yes (FAILED) | if `flattenOnBreach` | if `flattenOnBreach` | terminal | — |

Whether a breach liquidates is the single `flattenOnBreach` policy flag — the
`liquidation` state above makes that consequence explicit and visible.

## Verification (deterministic)

`liquidation-state.test.ts` (3/3):
- pure `liquidationStateOf` maps status × policy × exposure correctly;
- a breach whose flatten can't fill on a stale feed reads **status FAILED/LOCKED,
  openContracts 1, liquidation PENDING** — locked AND exposed, truthfully — then
  **DONE / flat** once the feed recovers and the retried liquidation fills;
- a block-only lock (`flattenOnBreach:false`) reads **NOT_REQUIRED** with the
  position open by design.

No regressions: rules.integration 14/14, pnl-reconciliation 12/12, money-oracle
11/11, legacy-mark-provenance 2/2, web trading 8/8; server + web typecheck clean.

## Still owed (honest)

- Liquidation **failure-mode torture** (§4: partial flatten, duplicate flatten,
  disconnect/restart mid-flatten, bracket-fills-during-flatten) — the state
  machine now represents these truthfully; the exhaustive adversarial suite is
  the next step.
- Live-product reproduction once the in-container browser harness is available.
