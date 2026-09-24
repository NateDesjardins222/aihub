# Atlas Native Copy Trading — V1 execution semantics

The exact, testable rules for turning one leader action into per-account
executions. Every rule here is deterministic and unit-tested (`copy-sizing`,
`copy-orchestrator` suites). Money and quantities are integers; the copier
copies **intent**, never fill prices.

---

## 1. Sizing modes

The group has a default `sizing_mode`; a follower may carry its own
multiplier/fixed value. Given a leader quantity `L` (whole contracts):

### SAME
Every enabled follower attempts `L`.
- Leader 2 MNQ → each follower 2 MNQ.

### MULTIPLIER
Follower attempts `round(L × multiplier)` under the rounding rule (§2).
- Leader 2, follower ×1.0 → 2; ×0.5 → 1; ×2.0 → 4.
- Leader 3, follower ×0.5 → `floor(1.5) = 1`.

### FIXED
Follower attempts its configured fixed quantity, independent of `L`.
- Leader 3, follower fixed 1 → 1. Leader 10, follower fixed 1 → 1.

The **leader** always trades exactly what the trader entered (`L`); sizing
applies only to followers.

## 2. Quantity rounding (deterministic, conservative)

Futures require whole contracts. The single, centrally-implemented rule for
MULTIPLIER (and any future fractional path):

> **`requested = floor(L × multiplier)`** — always round **down**.

Rationale: conservative (never sizes a follower *up* past the leader's intent),
deterministic (never alternates), and simple to reason about for risk. Never
produce a fractional contract; never silently alternate rounding direction.

**Zero handling.** If the computed quantity is `0` (e.g. leader 1 × 0.5 →
`floor(0.5) = 0`, or fixed 0), the follower does **not** participate and its
child is written `SKIPPED` with an explicit `sizing_note`
(`"MULTIPLIER 0.5 × 1 = 0.5 → 0 contracts (skipped)"`). A follower is **never**
silently dropped with no explanation — the UI shows why it did not copy.

Invalid sizing config (negative multiplier, negative/zero fixed where the mode
requires positive, non-finite) is rejected at configuration time, not at trade
time.

## 3. Instruments (same-instrument only in V1)

Launch instruments: NQ, MNQ, ES, MES, GC, MGC, CL, MCL. A follower copies the
**same** instrument the leader traded (NQ→NQ, MNQ→MNQ). V1 performs **no**
mini↔micro conversion (no NQ→MNQ). The sizing/instrument-resolution seam is
isolated so a future "product mapping" can be added without touching the
orchestrator.

## 4. Market orders

Each account receives an **independent** market-order request through
`engine.submitOrder`. Each account gets the simulated fill its *own* execution
produces — fills legitimately differ per account. The copier never assigns the
leader's fill price to a follower. It copies the *decision to buy/sell N*, not a
price.

## 5. Working orders (LIMIT / STOP)

LIMIT and STOP orders copy through the same fan-out. The leader's `limit_ticks` /
`stop_ticks` are copied **as absolute price levels** to each follower (a working
order is an instruction to rest at a price, and the trader chose that price). The
`copy_intent` records the leader order type + levels; each child order carries
the same levels and is independently validated. `copy_children.order_id` links
each follower's working order back to the intent for modify/cancel correlation.

## 6. Modify

When the leader modifies a copied *working* order, the orchestrator issues a
`MODIFY` intent that propagates the new qty/limit/stop to each still-active
follower child order via `engine.modifyOrder` (which enforces the optimistic
`version` and re-runs risk). Per follower:
- success → child updated;
- the follower order is already `FILLED`/`CANCELLED`/`REJECTED`, or the modify is
  refused → **divergence recorded** for that follower (never a false "synced").

A modify never re-opens or re-creates an order; it only adjusts a live one.

## 7. Cancel

A `CANCEL` intent attempts `engine.cancelOrder` on every active follower child
order of the target intent. Cancellation is idempotent and safely no-ops on
orders already `FILLED`/`CANCELLED`/`REJECTED`.

## 8. Brackets (copy the *distance/strategy*, not absolute leader prices)

Atlas brackets are expressed as **offsets in ticks** from the entry
(`bracketConfig` on the entry order); protective legs are created from the
*actual* fill price when the entry fills. This is exactly what copy trading
needs:

> The copier copies the leader's **bracket offsets** (stop distance, target
> distance), **not** the leader's absolute stop/target prices.

Each follower's entry carries the same offset `bracketConfig`; when *that
follower's* entry fills at *its* price, the existing engine builds *that
follower's* protective legs from *its* fill. The intended risk (e.g. "20-point
stop, 40-point target") is preserved for every account even though fills differ.
Copying absolute leader prices would corrupt a follower's risk when its fill
differs, so V1 never does that. No new bracket engine is built — the existing
`bracketConfig` / `bracketRole` machinery does the work.

## 9. OCO

Every account owns its own OCO relationship (`ocoGroupId` scoped to that
account's orders). A follower's OCO operates only against that follower's orders,
position and fills. The copy relationship is orchestration metadata and never
creates a cross-account OCO link — doing so would let one account's fill cancel
another account's order, which is forbidden.

## 10. Flatten (copy group)

A group `FLATTEN` intent independently flattens the leader and every enabled
follower (cancel relevant working orders, then market-close the position) via
`engine.flatten` per account, in parallel. Results are reported per account;
partial failures are visible; the operation is idempotent (flattening a
flat account is a no-op). Single-account emergency flatten remains available and
isolated — a broken follower can never prevent flattening another account
(separate mutexes, separate calls, `allSettled`).

## 11. Leader-context vs. account-context actions

A flatten/modify/cancel performed **in copy-group context** propagates. A
single-account emergency action (the account-scoped controls) affects **only that
account**. Intent is explicit from *which control* was used, never guessed from
which account happens to be visually selected.

## 12. Divergence (derived, per account, with a reason)

Group status is derived, not stored as truth:
- **SYNCED** — every enabled follower's net position matches the sizing-adjusted
  leader position and the last intent fully fanned out.
- **PARTIAL** — the last intent had at least one rejected/skipped child.
- **DIVERGED** — a follower's actual position differs from its expected
  (sizing-adjusted) position for a reason other than the current intent: a manual
  follower trade/flatten, a follower rejection that left it behind, a follower
  breach, a modify failure, a lifecycle change.
- **ERROR** — an unexpected execution error on a child.

Each follower shows its own state + reason ("Manually flattened", "Contract limit
exceeded", "Account breached"). Divergence is never hidden and a diverged group
is never labelled synced.

## 13. Resync (explicit, risk-validated, never silent)

Resync computes, per follower, the delta between its *expected* position
(sizing-adjusted leader net) and its *actual* position, and proposes the market
order that would close the gap:
- expected +2 MNQ, actual 0 → propose BUY 2 MNQ;
- expected +2, actual +1 → propose BUY 1;
- expected +2, actual +3 → propose SELL 1.

`GET /groups/:id/resync` returns the deltas for review; `POST /groups/:id/resync`
executes the adjustment orders **through the normal risk pipeline** (a resync
order can itself be rejected, e.g. contract limit). Resync is never forced
silently; the trader reviews and confirms.

## 14. Pause / resume

Pause stops new copy intents only — it does not flatten, cancel or move money.
Resume re-validates leader + followers + lifecycle + ownership + eligibility; if
the group is diverged, resume surfaces that rather than falsely marking it
synced.

## 15. What the copier never does

Never bypasses `risk.checkOrder`; never clamps a follower's quantity to fit
remaining capacity (it rejects the child and shows why); never assigns one
account's fill to another; never creates cross-account OCO; never rolls back
valid children on a sibling failure; never flattens on pause; never promotes a
follower to leader automatically; never converts mini↔micro.
