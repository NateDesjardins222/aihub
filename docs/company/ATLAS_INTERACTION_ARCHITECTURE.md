# ATLAS INTERACTION ARCHITECTURE

**Engineering Phase B, STEP 1.** The interaction path from a pointer/keyboard event to a rendered
chart, and who owns each gesture. Concise by intent — it maps ownership, not every line. Source of
truth for the Phase B durability work. Companion: `ATLAS_TOOL_INTERACTION_MATRIX.md` (drawing tools),
`ATLAS_MULTI_CHART_READINESS.md` (isolation audit).

## The non-negotiable principle

**Visual coordinates are never authoritative trading state.** Authoritative: price, time, accountId,
symbol, orderId, positionId. Derived: screen X/Y, DOM position, canvas coordinate. Zoom / pan / resize /
pane change / DPR change / layout change re-derive screen coordinates from the authoritative market
value every frame; they **never** write back a market value. A market value changes only when the user
explicitly drags/edits the object and the change is confirmed by the server.

## The path

```
pointer / keyboard
  → interaction owner (see ownership table)
  → chart coordinate (clientX/Y − container rect)
  → price/time  (adapter.yToPrice / xToTime / xToIndex — library-agnostic ChartProjection)
  → snap to instrument tick (snapPrice, integer-tick registry value)
  → order/drawing INTENT
  → client optimistic state (adapter working copy / dragRef; NOT the store mid-gesture)
  → server command  (tradingApi.modify/protect/place/cancel, with expectedVersion)
  → RISK gate (server-authoritative)
  → EXECUTION (server)
  → server state  (orders/positions/pnl, monotonic seq / order version)
  → client update  (WS acct.* topics → store; REST refresh gated on seq/token)
  → chart render  (rAF reprojection of authoritative price → screen)
```

## DOM layering (why gestures don't collide)

Siblings inside one chart pane, back to front:

| Layer | Element | pointer-events | Owns |
|---|---|---|---|
| Chart | `.chart-canvas` (`containerRef`) | auto | lightweight-charts pan/zoom **and** the drawing-input capture listeners |
| Drawings paint | `.draw-canvas` | **none** (paint only) | nothing — events fall through to `.chart-canvas` |
| Order markers | `.pm` container / `.pm-tag` | **none** / `.pm-tag` **auto** | order & position markers only |

Because `.pm` markers are a **sibling** of `.chart-canvas` (not a descendant), a press on a marker never
reaches the drawing-input capture listener, and a press on a drawing/chart never reaches a marker. Where
a marker overlaps a drawing at the same pixel, the marker is topmost + `pointer-events:auto`, so the
marker wins — a single deterministic rule. Empty marker-layer space is `pointer-events:none` and falls
through to the chart.

## Ownership table

| Gesture | Owner | Mechanism |
|---|---|---|
| Chart pan / zoom / scale | lightweight-charts on `.chart-canvas` | receives the event only when the drawing machine declines (no drawing hit, no tool armed) |
| Crosshair | lightweight-charts → `onCrosshairMove` | read-only; feeds legend + synced panes |
| Drawing create | `useDrawingInput` (capture on `.chart-canvas`) | tool armed → claim (`preventDefault`+`stopPropagation`), click-per-anchor |
| Drawing select / move / handle-drag | `useDrawingInput` | CURSOR tool + `pick(point)` hits a drawing → claim; single state machine `IDLE / PLACING / DRAGGING`; 3px threshold |
| Order / SL / TP drag | `PriceMarkers` (`.pm-tag` pointerdown) | `setPointerCapture`; drag updates `dragRef.price = snap(...)`; **one** `tradingApi.modify/protect({..., expectedVersion})` on release |
| Bracket create (pull off position marker) | `PriceMarkers` `beginCreate` | first move past 6px decides leg via `legFor(position, price, markPrice)`; one `protect()` on release |
| Pane resize (divider) | lightweight-charts native separators, wired by the adapter | `td>div` separator outside the drawing container; persists split on release, double-click resets |
| Account / symbol / timeframe switch | `session` + `trading/store` + `ChartPanel` | see async ownership below |

## Authoritative-state & concurrency ownership

- **Order price on drag** — `PriceMarkers` sends the modify with the order's `expectedVersion`
  (optimistic concurrency). A partial fill or a trailing stop that moved the order during the drag
  advances the version, so the stale modify is **refused** by the server rather than applied to a price
  that changed. On any rejection the component calls `refresh()` and the line snaps back to the
  authoritative price — client and server never disagree in silence.
- **Nothing reaches the server mid-drag** — pointermove only writes `dragRef`/`createRef`; exactly one
  request fires on pointerup. No duplicate modifications, no out-of-order intent from one drag.
- **P&L / valuation** — gated on the account's monotonic server `seq` in `trading/store`; a frame or a
  late REST read older than the last applied `seq` is dropped (no phantom money, no stale resurrection).
- **Rules / account reads** — capture the accountId they were issued for; a response that lands after
  the trader switched accounts is discarded (`money-state-race.test.ts`).
- **History (symbol/timeframe)** — `ChartPanel` issues a monotonic `loadTokenRef`; a response whose
  token is not the latest is discarded, so a slow NQ page never paints over ES. Live bars are gated on
  `seriesTimeframeRef` so a stale-timeframe bar is ignored.
- **Reconnect** — `trading/store.attach` (re)subscribes the `acct.*` WS topics and runs a REST
  `refresh()` (orders/positions/trades/executions/pnl/rules); the server snapshot is authoritative and
  reconstructs the full trading state. No client replay of pre-disconnect UI state.

## Workspace vs trading state

Workspace (appearance, drawings, pane split, favourites) persists to `localStorage` and is **presentation
only**; every read is `try/catch` with a normaliser and safe fallback (`chart-store` normalises a
tampered/half-migrated workspace to defaults). Trading state is **never** sourced from `localStorage` —
it is always hydrated from the server on load/reconnect.

## Instrument authority

`packages/instruments/registry.ts` is the only source of tick size, tick value, point value and
session. Tick sizes are stored as integer `tickSizeScaled` (NQ/ES/MNQ/MES = 25, GC/MGC = 10, CL/MCL =
1; scaled by `pricePrecision` = 2 → 0.25 / 0.10 / 0.01). The client resolves the float `tickSize` from
the server instrument DTO and snaps every draggable trading price with `snapPrice` (which trims
floating-point residue with `toFixed(10)`).

## Keyboard ownership

`useDrawingInput` owns chart/drawing keys but **never** steals a key from an `INPUT/TEXTAREA/SELECT` or
while a dialog scrim (`.dp-scrim/.st-scrim`) or menu/popover is open. Delete/Backspace removes the
selected drawing only when no form has focus; Escape cancels the in-flight interaction (placement or
drag) in priority order; tool shortcuts require Alt so typing never arms a tool.

## What is library-specific vs portable

Everything trading-facing is written against the `ChartAdapter`/`ChartProjection` interface, never
against lightweight-charts directly — the seam that lets a commercial engine replace the renderer later
without touching order lines, drawings, markers or the DOM link-up. Multi-chart isolation is audited
separately in `ATLAS_MULTI_CHART_READINESS.md`.
