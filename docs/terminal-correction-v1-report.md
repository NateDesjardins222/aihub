# Atlas — Terminal Correction & TradingView Parity V1 — final report

Branch `claude/futures-trading-simulator-v8qefu`, from LOCKED BASELINE
`f099cad`.

**Standard held:** stop polishing around broken core behaviour; make the
features that already exist behave correctly. Every defect followed
REPRODUCE → DIAGNOSE → FIX → REGRESSION TEST → VISUALLY VERIFY. Visual and
interactive behaviours were verified in a **real browser** (Chromium via
Playwright, against the real server + PostgreSQL), not from unit tests alone.

Companion documents:
- `docs/terminal-correction-v1-defects.md` — the append-only defect ledger.
- `docs/terminal-correction-v1-candle-audit.md` — the candle-integrity
  investigation and evidence.

---

## 1. What a real browser found that unit tests could not

The headline result of this phase is a defect that **only** a real browser could
surface, and it was mine:

**D-16 — the chart container collapsed to zero height; every pane painted
blank.** The D-03 synchronized-time-cursor work set the chart container's
positioning context by reading its *inline* `style.position` and, finding it
empty, forced `position: relative` inline. But the container is positioned by a
stylesheet rule (`.chart-canvas { position: absolute; inset: 0 }`), so the inline
override cancelled the `absolute` fill and the container fell to 0px tall. The
chart's own resize guard (`clientHeight > 0`) then declined to resize, and no
candles were painted. jsdom has no layout, so every unit test passed; the header
still showed live O/H/L/C, so the data path looked healthy. **Fixed** by checking
the *computed* position and only adding `relative` when it is `static`.
**Verified** in-browser: ONE and TWO_V both paint candles, `.chart-canvas` is
706px tall and `absolute` in every pane.

This is the justification for the milestone's insistence on real-browser
verification, in one bug.

---

## 2. Defects — reproduction, root cause, fix, tests

### P0 — phantom P&L and scale-in protection

**D-13 — phantom ~+$8,000 P&L on load/restart.** Two client fabrication paths.
(1) The valuation-frame merge in `trading/store.ts` coalesced nullable P&L with
`??`, so an authoritative `openPnlMicros: null` (a position that can no longer be
priced) was discarded and the last good number kept — a phantom the account no
longer had — with the "NOT PRICED" badge suppressed. (2) `ActivityPanel` used
`?? 0` / `?? equityMicros`, fabricating zeros/derived equity for accounts with no
live mark. **Fix:** `trading/pnl-merge.ts` `mergePnlFrame` applies a frame field
even when null (unknown stays unknown), keeps a prior value only when the frame
omits the field, and refreshes `marked`/`unmarkable`; `ActivityPanel` shows "—"
without a live valuation. **Regression:** `pnl-merge.test.ts` (4).

**D-14 / D-15 — scale-in TP value stale while SL updates.** Server-side, by leg
origin: standalone protection (`syncProtection`) grew to the whole live position,
but entry-attached bracket children (`syncBrackets`) were capped at the entry's
own fill, so a bracket leg stayed sized to the original entry while a standalone
leg grew. The chart compounded it by labelling a capped TP with the *full*
position quantity. **Fix:** a sole bracketed entry grows its legs to the whole
live position; multiple bracketed entries keep per-entry caps that sum to the
position (no over-exit). The chart label uses the order's actual protected
quantity. **Regression:** `brackets.test.ts` grow-on-scale-in (live + replay),
`protection.test.ts` D-14 cases.

### Charting correctness

**D-02 — symbol search Enter selected the wrong symbol.** The substring filter
matched "Futures" (contains "es") on all eight instruments and Enter took the
first row (NQ). **Fix:** `symbol-search.ts` ranks exact-root > prefix >
substring > text and resolves Enter by that ranking. **Regression:**
`symbol-search.test.ts` (9). **Browser:** typing `ES`+Enter from GC loads ES; a
description match ("gold") resolves to GC.

**D-01 — side-by-side panes could not be resized.** Added a real draggable grid
divider (not preset ratios): continuous pane resize, clamped so neither pane
collapses, persisted with the workspace, double-click resets to even.
**Regression:** `layout-split.test.ts` (6). **Browser (tc-v1):** drag shrinks a
pane continuously, clamp holds, split survives a reload, double-click resets.

**D-03 — multi-chart crosshair not synchronized.** Panes now sync by
**timestamp**: the peer paints a vertical-only TIME cursor (never a horizontal
price line from another instrument). **Browser (tc-v1 + multi-chart):** the peer
follows the broadcast timestamp and paints `.lw-time-cursor`; range and interval
sync also verified in `multi-chart`.

**D-04 — no "apply chart config to other charts".** Added to the header overflow
and the context menu; copies chart type + indicators (not symbol/interval) to the
other visible panes. **Browser (tc-v1):** an indicator on p1 appears on p2 after
the action.

**D-05 — Measure tool too primitive.** Rebuilt the readout: price delta, ticks,
percent, dollar value, bar count, elapsed time, direction arrow, in a dark chip.
**Regression:** `measure.test.ts` (6). **Browser:** `remaining-tools` places,
selects, moves, configures and deletes it.

**D-06 — Fibonacci interaction.** Hit-testing now honours `extendLeft`/
`extendRight` (grabbable across the extended, visible width) and selects on any
visible level line. **Regression:** `model.test.ts` extend + level cases.
**Browser:** `fib-levels`.

**D-07 — text hitbox tiny.** `textScreenBounds` gives TEXT a full multiline,
padded, left-aligned bounding box for hit-testing. **Regression:** `model.test.ts`
D-07 cases. **Browser:** `remaining-tools` "clicking its body selects it".

**D-08 — left toolbar too small.** Rail 40→44px, buttons 30→34px, icons 14→16px,
gap 1→2px.

### Terminal shell

**D-09 — Settings location/design.** Reachable from the left app rail; DM Sans,
lighter dialog edge. **Browser (tc-v1):** Settings opens from the rail.

**D-10 — remove the user-facing Practice section.** Removed the Practice/Replay
nav, surfaces, panels and settings tab. **Preserved** the simulation engine, the
replay HTTP surface, the `useTraining` store and the PRACTICE account type — the
reliability spine is untouched. **Browser (tc-v1):** the rail is
Trade / Journal / Settings; the replay API still drives sessions (the test
harness itself now trades a recording purely through that API).

**D-11 — professional chart context menu.** A right-click on the chart background
opens a real menu with real actions only (Reset chart view, Copy price, Remove
drawings/indicators, Apply to entire layout, Settings) — no fabricated trading
actions. **Browser (tc-v1):** the menu opens with Reset chart view + Copy price.
Final visual match to the supplied TradingView screenshot remains pending (see
§5).

**D-12 — position marker.** Correctness done: tabular-nums, DM Sans, honest
protected-quantity dollar label. Final visual redesign is **blocked** on the
TradingView position-marker screenshot (see §5).

### Data / rendering integrity (reopened from scratch)

**D-17 / D-20 — candles "still visually wrong".** A dedicated audit
(`marketdata/candle-integrity.ts` + 8 tests, and
`docs/terminal-correction-v1-candle-audit.md`) separated raw OHLC, contract
identity, timestamps/bucketing, session alignment, missing/duplicate bars, the
forming candle, aggregation, bar spacing and render/time-scale config. Findings:
aggregation and the forming-bar fold are sound (open preserved, H/L monotonic,
live bucket on the exchange clock); the provider integrity gate is sound; the
render config is sound (barSpacing 7, rightOffset 8); contract identity is
correct (NQ=F continuous front-month). **Verdict: primarily class C** — a
provider/contract-origin difference (yahoo-delayed continuous `=F` vs a
CME-direct reference), not an Atlas aggregation or render defect. Databento is
PAUSED per standing constraint, which is what would close the gap; no credentials
were requested. No Atlas data/render bug was found — **except** the render
regression D-16 above, which the candle audit's "render config sound" conclusion
did not catch because it inspected configuration, not live layout. The audit
conclusion stands for aggregation and configuration; D-16 was a layout bug.

---

## 3. Browser acceptance (real Chromium, real server, real PostgreSQL)

Market state at run time: NQ **OPEN**, feed FRESH (delayed), demo account.

| Suite | Result | Covers |
| --- | --- | --- |
| `tc-v1` | 17/17 | D-02 Enter, D-01 divider drag+persist+reset, D-03 time-cursor sync, D-04 apply-config, D-11 context menu, D-10 Practice gone, D-09 settings-from-rail, K persistence |
| `multi-chart` | 25/25 | layouts, per-pane independence, crosshair/range/interval sync, maximize/restore, reload persistence |
| `pane-resize` | 14/14 | study-pane splitter: grip, drag, persist, double-click auto, cleanup |
| `fib-levels` | 16/16 | Fibonacci placement, levels, extend, styling, clear |
| `remaining-tools` | 56/56 | ray, extended line, vertical line, **Text** (body-select = D-07), **Measure** (D-05): place/select/move/settings/delete |

**Browser total: 128/128** (tc-v1 17, multi-chart 25, pane-resize 14, fib-levels
16, remaining-tools 56).

Screenshots retained: `two_v_fixed.png` (candles render in both panes),
`tc-v1-divider.png`, `tc-v1-crosshair.png`, `tc-v1-context-menu.png`.

### Acceptance A–P

Each item, with how it was verified (RB = real browser; UT = unit/server
regression):

- **A. Symbol search Enter loads the typed instrument** — PASS (RB tc-v1: ES,
  and "gold"→GC; UT symbol-search 9).
- **B. Multi-chart panes resize by a real draggable divider, continuously,
  clamped** — PASS (RB tc-v1: 682→409px, clamp held; UT layout-split 6).
- **C. Dragged split persists across reload** — PASS (RB tc-v1: identical after
  reload).
- **D. Divider double-click resets to even** — PASS (RB tc-v1).
- **E. Timestamp-synchronized crosshair; vertical TIME cursor only** — PASS (RB
  tc-v1 + multi-chart: peer follows timestamp, paints `.lw-time-cursor`; price
  axis not driven).
- **F. Range / interval sync** — PASS (RB multi-chart).
- **G. Apply chart config to other charts** — PASS (RB tc-v1: indicator copied
  to peer).
- **H. Text drawing full-body hitbox** — PASS (RB remaining-tools "clicking its
  body selects it"; UT model D-07).
- **I. Fibonacci interaction / extend-aware hit** — PASS (RB fib-levels; UT
  model).
- **J. Measure readout rebuilt** — PASS (RB remaining-tools; UT measure 6).
- **K. Workspace persistence (splits, layout, per-pane state)** — PASS (RB tc-v1
  + multi-chart reload).
- **L. Chart context menu with real actions** — PASS (RB tc-v1); final visual
  match to screenshot pending (§5).
- **M. Practice section removed, sim engine preserved** — PASS (RB tc-v1: rail =
  Trade/Journal/Settings; replay API still drives the harness).
- **N. Settings reachable from the left rail** — PASS (RB tc-v1).
- **O. Candles render correctly in every layout** — PASS after D-16 fix (RB:
  candles paint in ONE and TWO_V); provider-origin parity is class C (§2, §5).
- **P. Scale-in TP/SL + P&L reload correctness** — PASS by deterministic
  server/unit regression (brackets live+replay, protection, pnl-merge); a
  real-browser rewire of the legacy execution suites is follow-up (§5).

---

## 4. Test totals

<!--TOTALS-->

---

## 5. Remaining blocked / pending

- **D-11 context-menu final visual match** and **D-12 position-marker visual
  redesign** are blocked on the TradingView screenshots the brief named. No such
  image is present in this session's context. All screenshot-independent
  correctness (functional actions, sizing, typography, protected-quantity,
  hitbox, interaction) is done; only the final pixel match to those references is
  deferred, exactly as the brief permits.
- **Candle provider parity (D-17)** is a provider-origin difference that closes
  only with the paused Databento (CME-direct) feed. Databento remains PAUSED per
  the standing constraint; no credentials were requested.
- The pre-existing execution browser suites (`drag-protect`,
  `execution-interaction`, `execution-stress`, `replay-brackets`,
  `live-indicators`) contain their own inline Practice-drawer helpers from the
  prior milestone and were **not** rewired in this pass; the shared harness
  (`signIn`/`returnToLive`/`tradableMarket`) was. Scale-in TP/SL and P&L-reload
  behaviour is covered by the deterministic server/unit regressions
  (`brackets.test.ts`, `protection.test.ts`, `pnl-merge.test.ts`); a full
  real-browser rewire of those legacy suites is follow-up work.

---

## 6. Final state

<!--FINAL-->
