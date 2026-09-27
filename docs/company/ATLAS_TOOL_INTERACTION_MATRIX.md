# ATLAS TOOL INTERACTION MATRIX

**Engineering Phase A, Part III (STEP 22-27).** Every user-exposed drawing tool, its interaction
behavior, and the one objective interaction bug found and fixed. Source: `apps/web/src/chart/drawings/`
(`registry.ts` TOOLS, `model.ts` DrawingKind/ANCHOR_COUNT/hitTest/applyHandle, `useDrawingInput.ts`
pointer state machine, `bounds.ts` broad-phase).

## Interaction contract (STEP 23) — shared by every tool

- **CREATE:** click per anchor (`ANCHOR_COUNT`); a preview tracks the cursor between clicks. No
  drag-to-create. Position tools are 1 click → 3 stored anchors (entry/target/stop).
- **SELECT:** click within the tool's hit region → selected (`pick`→`select`). Handles beat bodies, but
  only on the already-selected object.
- **MOVE:** drag the body → `translateByBars` (moves by whole bar-index steps + price delta, so it
  survives session gaps). Magnet off during a body drag.
- **EDIT:** drag a handle → `applyHandle` moves only that anchor (roles POINT/CORNER/TIME/PRICE).
- **DELETE:** Delete/Backspace removes the selected drawing unless locked.
- **DESELECT:** click empty space → selection cleared, gesture released to the chart (pan).
- **PAN/ZOOM/RESIZE:** anchors are market coords; the paint loop re-derives screen coords every frame,
  so drawings stay pinned. **Drag threshold 3px** so a selecting click never nudges.
- **Ownership:** one state machine `IDLE | PLACING | DRAGGING`; listeners in the capture phase call
  `stopPropagation`/`preventDefault` **only** when the drawings claim the gesture — so chart pan/zoom
  and the pane separator are never blocked.

## Coordinate system (STEP 24) — VERIFIED

Every anchor is `{ time: epoch ms, price }` — **market coordinates**, never pixels (`Anchor`,
model.ts:42-46). Screen coordinates are derived at paint via the projection; the broad-phase box cache
is keyed on a projection signature (plot-corner conversions + size + DPR) so pan/zoom/scale/resize
invalidate it. Position anchors, previews and drags all produce time+price. **No tool stores pixels.**

## Event collision (STEP 25) — VERIFIED

Single capture-phase pointer machine owns gestures; `stopPropagation` fires only on a claim (tool
armed / drawing hit / drag in flight). Empty-space and locked-object presses fall through to the chart.
Listeners are container-scoped and torn down fully (no leak). The `td>div` row-resize pane separator is
outside the drawing container and unaffected — pane resize and chart pan/zoom are never eaten.

## The 27 exposed tools

| Tool (kind) | Clicks→anchors | Notes |
|---|---|---|
| TREND_LINE, RAY, EXTENDED_LINE, INFO_LINE, TREND_ANGLE, ARROW, ARROW_MARKER | 2 | line/segment; RAY & EXTENDED_LINE claim the whole plot for hit |
| HORIZONTAL_LINE | 1 | full-width row |
| HORIZONTAL_RAY | 1 | rightward ray from anchor |
| VERTICAL_LINE | 1 | full-height column |
| CROSS_LINE | 1 | full horizontal + vertical arms |
| PARALLEL_CHANNEL | 3 | 2 clicks base line, 3rd sets width; both rails + band hit |
| RECTANGLE | 2 | filled → inside; unfilled → edges |
| CIRCLE | 2 | filled → inside ellipse; unfilled → near curve |
| FIB_RETRACEMENT | 2 | editable levels, reverse, extend, shading |
| TEXT, ANCHORED_TEXT | 1 | hit = painted (rightward, multi-line) text box |
| NOTE, ARROW_MARK_UP/DOWN/LEFT/RIGHT | 1 | single-anchor stamp with a hit radius |
| MEASURE, PRICE_RANGE, DATE_RANGE | 2 | pure stats (measure.ts) |
| LONG_POSITION, SHORT_POSITION | 1→3 | plans a trade (entry/target/stop); 3 price handles + 2 time edges; never places an order |

All 27 `DrawingKind` members are user-pickable (registry test enforces one tool def + one family per
kind). None are orphaned.

## PASS / FAIL per interaction dimension (post-fix)

| Dimension | Status | Note |
|---|---|---|
| CREATE (all tools) | PASS | click-per-anchor + preview; position tools 1→3 |
| SELECT | PASS (was FAIL for 6 tools) | see the fix below |
| MOVE (body) | PASS | translateByBars, gap-safe |
| EDIT (handles) | PASS | applyHandle moves only the intended anchor (tested) |
| DELETE | PASS | Delete/Backspace; locked protected |
| PAN stability | PASS | market-coord anchoring, per-frame reprojection |
| ZOOM stability | PASS | same |
| RESIZE stability | PASS | signature folds size + DPR |
| Coordinate system | PASS | time+price, no pixels |
| Event collisions | PASS | single capture-phase owner; separator/pan unaffected |

## The objective bug found and fixed (STEP 27)

**Broad-phase `mayHit` was not a conservative superset of `hitTest`.** `pick()` rejects a candidate on
`mayHit` *before* `hitTest` runs (useDrawingInput.ts). `computeBox` (bounds.ts) special-cased only
HORIZONTAL_LINE / VERTICAL_LINE / RAY / EXTENDED_LINE; every other kind got the tight anchor box padded
by 6px. So any hit region larger than that box was unreachable:

- **CROSS_LINE** — selectable only within ~6px of its center; its arms were dead. **(objective FAIL)**
- **HORIZONTAL_RAY** — the ray body was unselectable beyond ~6px of the anchor. **(objective FAIL)**
- **TEXT / ANCHORED_TEXT** — grab area clipped to the anchor instead of the painted (rightward,
  multi-line) box. **(objective FAIL — partial)**
- **NOTE / ARROW_MARK_UP/DOWN/LEFT/RIGHT** — the stamp's hit ring clipped to ~6px. **(objective FAIL — partial)**

The existing unit tests missed this because they call `hitTest` directly, never the `mayHit`-gated
`pick` path.

**Fix (`bounds.ts` `computeBox`):** CROSS_LINE now claims the whole plot; HORIZONTAL_RAY runs from its
anchor to the right edge; TEXT/ANCHORED_TEXT get a generous rightward/vertical box (hitTest does the
exact `textScreenBounds` test); NOTE and the four ARROW_MARK_* stamps are padded by their hit radius.
Regression test `bounds.test.ts` now exercises the `mayHit` path for each (CROSS_LINE arms,
HORIZONTAL_RAY rightward-not-left, TEXT box, stamp radius). All other checks came back clean: no pixel
storage, no wrong-anchor handles, no preventDefault blocking the separator/pan, no listener leaks,
drawings stay anchored on pan/zoom/resize.

## Existing regression coverage (not duplicated)

`model.test.ts` (hitTest per kind, handles, translate-across-gap, drag threshold), `bounds.test.ts`
(broad-phase box + cache + the new superset cases), `registry.test.ts` (catalogue integrity),
`v4-catalog.test.ts` (12 fixed-anchor tools), `channels-catalog.test.ts` (parallel channel),
`measure.test.ts` (measure stats). The `hitTest`-direct tests give false confidence about selection
because they bypass `mayHit`; the new `bounds.test.ts` cases close that gap.

## What still needs Nathan's eyes

The interaction model is sound and the selection-reachability bug is fixed. Physical feel — grip
grab-ease, handle sizes, cursor affordances, TradingView-grade polish — is intentionally out of scope
this phase and is an Atlas V2 human-review item.
