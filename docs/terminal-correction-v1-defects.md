# Atlas — Terminal Correction & TradingView Parity V1 — defect ledger

Append-only working ledger. Starting baseline `f099cad`, branch
`claude/futures-trading-simulator-v8qefu`.

**States:** `REPRODUCED` · `ROOT_CAUSED` · `FIXED` · `VERIFIED` · `BLOCKED` ·
`NOT_REPRODUCED`. A defect is not `FIXED` until reproduced first, and not
`VERIFIED` until proven by an automated test and/or real-browser check.

Nothing here is deleted, including findings that turn out embarrassing or that
trace to a provider limitation rather than an Atlas bug.

| ID | Area | Symptom (user) | State |
| --- | --- | --- | --- |
| D-01 | Multi-chart | Side-by-side chart panes cannot be resized (locked equal width) | VERIFIED (browser: divider drag continuous, clamped, persists, dbl-click resets) |
| D-03 | Crosshair | Multi-chart time crosshair not synchronized across panes | VERIFIED (browser: peer follows timestamp + paints vertical time cursor) |
| D-04 | Multi-chart | No "apply chart config to other charts" action | VERIFIED (browser: indicator copied to peer pane) |
| D-16 | Chart render | **Regression:** chart container collapsed to 0 height → blank panes (candles never painted) | FIXED + VERIFIED (browser) |
| D-02 | Symbol search | Type `ES` while on `GC` + Enter → stays on `GC` | VERIFIED (fixed) |
| D-05 | Measure tool | Too primitive; poor measurement info + interaction | FIXED (browser pass pending) |
| D-06 | Fibonacci | Interaction feels bad; needs rebuild | IMPROVED (already feature-rich; extend-aware hit; browser tuning pending) |
| D-07 | Text drawing | Hitbox tiny; only a small part selects the text | VERIFIED (unit; browser pass pending) |
| D-08 | Drawing toolbar | Left toolbar too small (width/icons/targets) | FIXED (browser pass pending) |
| D-09 | Settings | Location/design; move to left app rail, declutter | VERIFIED (browser: Settings opens from the left app rail) |
| D-10 | Practice | Remove user-facing Practice section (keep sim engine) | VERIFIED (browser: rail = Trade/Journal/Settings; engine + replay API intact) |
| D-11 | Context menu | No professional chart context menu | VERIFIED (browser: background right-click → real actions); visual match to screenshot pending |
| D-12 | Position marker | Marker visual/interaction unacceptable (awaiting screenshot for redesign) | CORRECTNESS DONE (tabular nums, DM Sans, honest protected-qty $); VISUAL REDESIGN BLOCKED (screenshot) |
| D-13 | **P0 P&L** | Phantom ~+$8,000 P&L on load/restart, never earned | investigating |
| D-14 | **P0 scale-in** | Scale into position → TP $ value stale, SL updates | VERIFIED (fixed) |
| D-15 | Scale-in semantics | Protection quantity/value semantics undefined on scale-in | DEFINED + enforced |
| D-17 | Candles | Candles still visually wrong vs reference | AUDITED — data/agg/render sound; residual is provider origin (see candle-audit) |
| D-20 | Render/time-scale | Visible bar density may differ (render vs data error) | AUDITED — render config sound (see candle-audit) |

## Detail

Entries are filled in as each defect moves through the states. Format per defect:
reported symptom → reproduction → root cause → severity → fix → automated
regression → manual/browser verification.

---

### D-16 — chart container collapsed to zero height (blank panes) — FIXED, VERIFIED

**Reproduction.** Real-browser acceptance run: open a multi-chart layout (or
reload while on one). Every pane shows its header and live O/H/L/C, but the plot
is blank — no candles paint. Measured `.chart-canvas` = `706px` wide, `0px`
tall.

**Root cause.** A self-inflicted regression from the D-03 time-cursor work. Its
mount established a positioning context for the cursor by reading the container's
INLINE `style.position`
(`if (!init.container.style.position) init.container.style.position = 'relative'`).
The chart container is positioned by a stylesheet rule
(`.chart-canvas { position: absolute; inset: 0 }`), whose value never surfaces on
the inline `.style.position`, so the guard always read empty and forced
`position: relative` inline. That inline value overrode the stylesheet's
`absolute`; with the element no longer absolute, `inset: 0` stopped applying and
the container collapsed to content height (0). `LightweightChartsAdapter.resize()`
guards on `clientHeight > 0`, so the chart then never resized and painted
nothing. It was invisible to unit tests (jsdom has no layout) and to the header,
which reads data, not geometry — exactly the class of defect that only a real
browser catches, and the reason this milestone required one.

**Fix.** Check the COMPUTED position and add `relative` only when it is
`static`; an `absolute`/`relative` container is already a valid containing block
for the absolutely-positioned time cursor. No inline override, so the
stylesheet's absolute fill stands.

**Verification (real browser).** ONE and TWO_V both paint candles;
`.chart-canvas` is `706px` tall and `position: absolute` in every pane
(screenshots `two_v_fixed.png`). tc-v1 acceptance 17/17.

### D-02 — Symbol search Enter selects the wrong (old) symbol
_(pending investigation write-up)_

### D-13 — P0 phantom +$8,000 P&L — ROOT_CAUSED, client fixes VERIFIED

**Reproduction / root cause (two client fabrication paths):**
1. **Stale-retained UP&L (primary).** The valuation WebSocket-frame merge in
   `trading/store.ts` coalesced nullable P&L with `??`
   (`valuation.openPnlMicros ?? state.pnl.openPnlMicros`). When the server sends
   `openPnlMicros: null` (a position can no longer be priced), the client
   **discarded the authoritative null and kept the last good number** — a phantom
   P&L the account no longer has — and never refreshed `marked`/`unmarkable`, so
   the "NOT PRICED" badge stayed suppressed. Any earlier UP&L (e.g. a bootstrap
   mark) thus persisted on screen as a number the user "never made".
2. **Fabricated open P&L in the blotter.** `ActivityPanel` used
   `live?.openPnlMicros ?? 0` and `?? a.equityMicros`, and the accounts-list
   endpoint returns `openPnlMicros: 0` / `equityMicros = balance` — fabricated
   zeros/derived equity for accounts with no live mark.

**Fix (client):** `trading/pnl-merge.ts` `mergePnlFrame` applies a frame field
even when null (unknown stays unknown), keeps a prior value only when the frame
omits the field, and refreshes `marked`/`unmarkable`. `ActivityPanel` shows "—"
for equity/open P&L without a live valuation instead of fabricating.

**Regression:** `trading/pnl-merge.test.ts` (4) — an authoritative null clears
the stale +$8,000 and un-suppresses the badge; a real number replaces; an
omitted field is retained; zero is applied as zero.

**Verification:** web suite 230/230; typecheck clean. Server-side reconciliation
(candidate A: marking an open position at a stale bootstrap price on restart) is
tracked next — a deterministic reload/reconcile test on the engine valuation.

### D-14 — P0 scale-in stale TP value — ROOT_CAUSED, FIXED, VERIFIED (unit/server)

**Reproduction / root cause.** The client dollar math (`chart/protection.ts`
`estimatePnlMicros`) is symmetric and already uses the live `position.qty` for
both legs — it is NOT where TP and SL diverge. The divergence is server-side and
by leg **origin**, not leg type:
- **Standalone protection** (`setProtection` → `syncProtection`, engine.ts:2197)
  grows to the whole live position: `target = filledQty + |position.qty|`.
- **Entry-attached bracket children** (`syncBrackets`, engine.ts:2286) were
  **capped at the entry's own fill**: `target = min(entry.filledQty, …)`. So when
  the trader scaled in with a separate (unbracketed) order, a bracket-child leg
  stayed sized to the original entry while a standalone leg grew — exactly the
  "SL updated, TP stale" report (whichever leg was the bracket child went stale).

Second, worse hazard: the chart TP/SL dollar label used the **full position
qty** for both legs, so a capped TP (which only closes the original quantity)
was **overstated** to the full scaled-in position — the chart and the order book
silently disagreed on the one leg that did not grow.

**Fix.**
- Server (engine.ts `syncBrackets`): when there is exactly one bracketed, filled
  entry for the instrument (the common case, and the user's), its legs grow to
  cover the whole live position (`cap = +∞`), so a scale-in is protected on both
  legs. With several bracketed entries each leg stays capped at its own entry's
  fill, so their protection sums to the position rather than multiplying it (no
  over-exit). Smallest authoritative change; standalone `syncProtection` and the
  single-entry partial-fill growth/shrink paths are unchanged.
- Client (`protection.ts` + `PriceMarkers.tsx`): the protective dollar label now
  uses the order's **actual protected quantity** (`min(order.remainingQty,
  |position.qty|)`), never overstating a partial leg to the full position.

**Regression:** `brackets.test.ts` "the sole bracket grows to protect a
scale-in" (live + replay) — open 1 + bracket, scale in to 2 unbracketed, assert
BOTH legs reach qty 2. `protection.test.ts` D-14 cases — a partial protected qty
values only what it protects; zero/negative → null. Server suite green; web 232.

### D-15 — scale-in protection semantics (defined)

Atlas's intended behaviour, now consistent across both protection paths: **a
protective leg tracks the live position it protects.** It grows on a scale-in and
shrinks on a partial manual exit, for standalone protection AND for a sole
entry-bracket. Invariant: protective quantity per side never exceeds the aligned
position (no over-exit) and, for a single protection, equals it (no orphaned,
unprotected contracts; no stale TP quantity). Multiple independent bracketed
entries on one instrument keep per-entry caps that sum to the position. The chart
never shows a protective value for more contracts than the order will close.
