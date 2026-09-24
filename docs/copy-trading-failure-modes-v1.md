# Atlas Native Copy Trading — V1 failure modes

Every way copy trading can partially fail, and the exact required behaviour. The
governing principle: **a failure in one account never corrupts another, never
rolls back a valid execution, and is always surfaced with a reason.** Each row is
backed by an invariant / concurrency / torture test (CT-L).

---

## 1. Follower risk rejection (contract limit, MLL headroom, instrument, etc.)

Leader accepted; a follower fails `risk.checkOrder`. → Reject **that follower's
child only** (`REJECTED` + reject code/message); **do not** clamp the quantity;
other accounts proceed. UI: `4/5 executed · 100K Select — Contract limit
exceeded`. Never silently size the follower down to fit.

## 2. Partial success

Children resolve independently (`Promise.allSettled`). Some ACCEPTED, some
REJECTED/SKIPPED. → `COPY PARTIALLY EXECUTED — N/M`. Valid executions are kept;
nothing rolls back. Cross-account execution is not one atomic transaction and is
never treated as one.

## 3. Zero / skipped quantity

Sizing yields 0 (multiplier floor, fixed 0). → child `SKIPPED` with an explicit
`sizing_note`; the follower is never silently absent. The UI shows "Did not copy
— rounds to 0 contracts".

## 4. Manual follower interference

Trader manually closes/modifies a follower outside copy context. → group becomes
`DIVERGED` for that follower; the copier **does not** auto-reopen it. Resync is
the only (explicit, reviewed) path back.

## 5. Follower breach mid-life or mid-fan-out

A follower hits MLL / becomes terminal. → the **existing** risk engine handles
liquidation/terminal state for that account; the copier disables the follower
from new intents, records divergence + reason ("Account breached"), preserves
audit, and continues the other accounts. The group is **not** killed.

## 6. Leader breach / leader becomes ineligible

→ group auto-`PAUSED`; leader cleared; new fan-out stops; reason surfaced; the
trader must explicitly select a new eligible leader. **No** silent promotion of a
follower to leader.

## 7. Double-click / retry / reconnect replay

Same logical action submitted more than once. → the group-scoped
`idempotency_key` collapses it to ONE `copy_intent`; each account's deterministic
`clientOrderId` collapses to ONE order per account (engine unique index). Result:
exactly-once logical intent, exactly-one child per account. Proven under real
concurrency (CT-L).

## 8. Simultaneous identical requests (true concurrency)

Two in-flight fan-outs for the same key race. → the unique intent index makes one
win and the other observe the existing intent + children; no duplicate orders.
Group config edits race on the `version` column.

## 9. Modify while a fill occurs

Leader modifies a working order that (for some followers) has just filled. → per
follower: modify a still-working order succeeds; a now-filled/cancelled order
cannot be modified → divergence recorded for that follower; never a false
"synced".

## 10. Cancel while a fill occurs

Cancel races a fill. → `engine.cancelOrder` is idempotent and no-ops on
filled/cancelled/rejected orders; per-follower outcome recorded. No error cascade.

## 11. Flatten while a new order arrives

A `FLATTEN` intent races a new `SUBMIT`. → each runs under the account's mutex;
flatten cancels protection then market-closes; the new order is validated on its
own. No cross-account interference; partial results visible.

## 12. Follower / leader ineligible at execution time (state changed after preflight)

Preflight passed but state changed before fan-out. → execution-time
eligibility + `risk.checkOrder` reject the child; preflight is advisory only, the
execution pipeline is final authority.

## 13. Server restart mid-fan-out

An intent is left `PENDING`/`FANNED_OUT` with some children unresolved. → startup
reconciliation **reads** the authoritative `orders` table to resolve each child
(placed? filled? absent?) rather than blindly replaying; idempotency keys make a
genuine re-drive safe. No duplicate orders after restart.

## 14. Browser refresh / WS reconnect / logout-login

→ copy config is durable server-side; the web re-reads the group over REST and
re-subscribes to member channels. The active copy configuration is never lost and
is never held only in the browser.

## 15. Account switching in Atlas

Switching the *visible* account must not change the *leader*. → leader is
persistent server-side config; the visible-account concept and the copy-leader
concept are distinct and the UI states this. No silent leader change.

## 16. A broken follower must never block another account

Emergency single-account flatten / cancel is isolated (own mutex, own call). → a
hung/failing follower cannot prevent flattening or trading another account.

## 17. Cross-account money / P&L leakage — forbidden

Each account independently owns its balance, P&L, fees, drawdown, payouts and
ledger via the existing money oracle. The copier calculates **no** account money
and copies **no** fills. The torture suite validates, after every phase, that
each account's balance/P&L/fees/MLL/positions/brackets/OCO are exactly what its
own executions produce — zero cross-account leakage.

## 18. Ownership / IDOR

A client-submitted follower id, quantity, or ownership claim for an account the
caller does not own → 404 (no enumeration), never honoured. All copy endpoints
re-validate ownership + eligibility server-side.

## 19. Loop / chain attempt

An attempt to make an account both a leader and a follower (or two groups form a
loop) → rejected by the topology check + partial unique indexes. `A→B, B→A` is
impossible.

## 20. Regression safety

A trader who never enables copy trading sees Atlas exactly as before: the
orchestrator is only invoked from copy endpoints; `engine`/`risk`/order-entry
behave identically for a normal single-account order (CT-M regression check).

## 21. Trader-facing messaging

Failures are clean sentences, never raw stack traces:
- `COPY PARTIALLY EXECUTED — 4 of 5 accounts executed. 100K Select — Rejected:
  contract limit exceeded.`
- `COPY GROUP PAUSED — the leader account is no longer eligible to trade. Choose
  another eligible leader to continue.`
- `FOLLOWER OUT OF SYNC — leader +2 MNQ, follower 0. Required: BUY 2 MNQ.
  [Review resync]`
