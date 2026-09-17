# Terminal quality pass — item by item

The brief for this pass was explicit about reporting:

> DO NOT tell me "Implemented TradingView-style drawings." unless you actually
> verified the behavior… For EVERY item report: IMPLEMENTED TESTED VERIFIED or
> INCOMPLETE.

So every line below carries its own evidence. **VERIFIED** means a check was
driven in a real browser against the real server and the real market data, and
its result is quoted; **TESTED** means it is covered by an automated check that
passes; **IMPLEMENTED** means the code is there and was exercised by hand but
has no automated check of its own; **INCOMPLETE** means exactly that.

Run the automated evidence with `pnpm test` (workspace suites) and
`pnpm test:browser` (the browser suites, which need the server, the database
and Chromium).

## Phase 1 — profile first

| Item | Status | Evidence |
|---|---|---|
| Instrument the terminal rather than guess | VERIFIED | `tests/perf/instrument.mjs`, `tests/perf/profile.mjs`, `tests/perf/cpu.mjs`; numbers in `docs/chart-performance-audit.md` |
| Identify what costs a frame | VERIFIED | eight findings, worst first, each with the measurement that found it |
| Target 60 FPS | VERIFIED | `tests/browser/stress.spec.mjs`: 58–61 fps during an unpaced pan at every object count, worst frame 19–35ms |

## Phase 2 — drawing rendering

| Item | Status | Evidence |
|---|---|---|
| Border colour, opacity, width and style are independent settings | VERIFIED | `rectangle.spec.mjs` — separate `Border opacity` and `Fill opacity` controls asserted |
| Fill colour and opacity are independent, with real alpha | VERIFIED | `rectangle.spec.mjs` alpha profile: nothing inside the fill is opaque, mean alpha 20/255 |
| Subtle defaults that never cover price action | VERIFIED | same check: default fill mean alpha under 45/255 with zero opaque pixels |
| A legacy `rgba()` style migrates rather than breaks | TESTED | `model.test.ts` — "normalising a stored style" |

## Phase 3 — per-tool behaviour

The rectangle was rebuilt first and is the reference; the other three were then
held to the same checks.

| Item | Status | Evidence |
|---|---|---|
| Rectangle, all twenty points | VERIFIED | `rectangle.spec.mjs`, 43/43 |
| Trend line | VERIFIED | `line-tools.spec.mjs` (68/68), part 1 — create, preview, select by the line itself, move, reshape one end, extend left/right, text, price label, zero drift, delete |
| Horizontal line | VERIFIED | `line-tools.spec.mjs`, part 2 — one-click placement, full-width rule, a 13px price chip 1px from the axis, drag by price, a pan that does not move it, label toggle |
| Fib retracement | VERIFIED | `line-tools.spec.mjs`, part 3 — levels add/remove/hide/recolour/fade/name, reverse against an asymmetric set, shading, extensions, save as default and as a template |
| Clean unselected drawings; small professional anchors when selected | VERIFIED | `visual.spec.mjs` — a selected object paints more than the same object unselected, and only then; handles are painted for `SELECTED` alone (`paint.ts`) |
| Escape, Delete, Ctrl+C, Ctrl+V, Ctrl+Z, Ctrl+Shift+Z | VERIFIED | `rectangle.spec.mjs` — all six, including Ctrl+Shift+Z bringing a pasted copy back; `line-tools.spec.mjs` repeats copy/paste/undo on the fib |
| Double-click opens settings | VERIFIED | all four tools, in the two suites above |
| Right-click opens a context menu | VERIFIED | `rectangle.spec.mjs` (lock/unlock through the menu) |
| Anchors attached to TIME + PRICE with zero drift | VERIFIED | every tool: anchor prices read from the object tree before and after a pan, compared exactly |
| Magnet OFF / WEAK / STRONG | VERIFIED | `tools.spec.mjs` — the rail control cycles through all three, and the modes are checked by behaviour: with it OFF two clicks four pixels apart give two prices (29,483.94 and 29,479.64), with it STRONG both give 29,537.50, and that price is then found among the 2,939 prices the served bars actually printed |
| Compact settings dialog | VERIFIED | row labels asserted per tool; the level editor fits five controls on one row |
| Per-level colour, opacity, visibility and label | VERIFIED | `line-tools.spec.mjs` — fading one level fades that line alone (231→38 mean alpha, its neighbours unchanged) |
| Ray, extended line, vertical line, text, measure | VERIFIED for the shared interaction, INCOMPLETE per tool | `remaining-tools.spec.mjs` (56/56) puts each of the five through the shared architecture: placement, the tool returning to the cursor, selection from its own body, a body drag that follows the pointer to within six pixels, the settings its registry entry declares and no others, anchors unchanged through a pan, and Delete. Also `tools.spec.mjs` 26/26 and `drawing-engine.spec.mjs` 34/34. What is still owed is the per-tool detail - each one's own extensions, styling and readout - not the interaction |

## Phase 4 — execution

| Item | Status | Evidence |
|---|---|---|
| Position marker shows mainly P&L | VERIFIED | `drag-protect.spec.mjs` — the marker leads with the money and carries no side, entry or +SL/+TP |
| Press-hold-drag the position to create TP above / SL below (reversed for a short) | VERIFIED | `drag-protect.spec.mjs`, all four directional cases |
| Live preview while creating | VERIFIED | same suite: the preview line is present mid-drag |
| SL/TP as clean draggable lines showing price, ticks and dollars, updating continuously | VERIFIED | `execution-interaction.spec.mjs` — sampled mid-drag without releasing: `-847t −$4,235.00` → `-1182t −$5,910.00` |
| Working order: drag = modify | VERIFIED | `execution-interaction.spec.mjs` — 29420.75 → 29380.00, and the server holds the new price |
| Working order: X = cancel | VERIFIED | `drag-protect.spec.mjs` (protective legs) and `execution-interaction.spec.mjs` (entry order) |
| Working order: right click = options | VERIFIED | `execution-interaction.spec.mjs` — quantity up/down and cancel, each a real engine request; quantity 1 → 2 confirmed in the orders table |
| Right click on a stop, a target or the position | VERIFIED | `execution-interaction.spec.mjs` — a stop offers break-even and removal (the break-even item moved the real order to the entry price, 29460.75); the position offers close, reverse and removing its protection, and Escape closes the menu having done nothing |
| No unnecessary confirmation modal | VERIFIED | `execution-interaction.spec.mjs` — nothing modal on screen during or after a drag |
| ENTRY / STOP / TARGET / WORKING ORDER / FILLED POSITION told apart | VERIFIED | `execution-interaction.spec.mjs` reads each level's painted rule: the filled position at its entry is solid blue, a stop dashed red, a target dashed green, a working entry order dotted and coloured by side, and each carries its own label (`LONG`, `SL`, `TP`, `BUY LMT`). The position, stop and target are compared while all three are on screen together; the working order's rule is compared against those three values |
| Minimal order entry: no TIF, no DAY/GTC prominence, no tick-value essay | VERIFIED | `execution-interaction.spec.mjs` — the ticket's own text asserted to contain none of it |
| Market / Limit / Stop / Stop-limit | VERIFIED | the four options asserted; a limit order placed, rested, modified and cancelled in the same suite |
| Every action is server-side | VERIFIED | every assertion above is checked against the orders the engine holds, not against the DOM |

## Phase 5 — performance architecture

| Item | Status | Evidence |
|---|---|---|
| Pointer movement does not trigger app-wide React state | VERIFIED | `interaction.ts` holds the gesture in a mutable record; audit before/after in `chart-performance-audit.md` (92 commits per drag → none) |
| Painting is driven by change, not by the clock | VERIFIED | signature-gated repaint in `DrawingCanvas.tsx` and `PriceMarkers.tsx` |
| Hit-testing has a cheap rejection first | VERIFIED | `bounds.ts` `BoundsCache`, invalidated by `projectionSignature` |
| NO network or database traffic during a drag | VERIFIED | `rectangle.spec.mjs` watches every `/api/` request with a timestamp: zero between pointerdown and pointerup, two after release |
| Persist asynchronously after the interaction | VERIFIED | `useDrawingInput.ts` — one `updateDrawing` + `commitHistory` on pointer-up; `preferences.ts` debounces the write |

## Phase 6 — visual fidelity and typography

| Item | Status | Evidence |
|---|---|---|
| Modern compact trading typography | IMPLEMENTED | `styles/theme.css` — Inter and JetBrains Mono, both self-hosted, 11/12/13/15/18/22 scale, 24/28/34px controls |
| Tabular numerals everywhere a number moves | IMPLEMENTED | `.num` sets `font-variant-numeric: tabular-nums`; used by every price, tick and money label including the new dragged-level readout |
| Compact interval selector | VERIFIED | `terminal.spec.mjs` — the favourite intervals are plain text controls, and are configurable |

## Phase 7 — testing

| Item | Status | Evidence |
|---|---|---|
| 1, 10, 50, 100 and 250 drawings | VERIFIED | `stress.spec.mjs` 62/62 — each count seeded through the trader's own stored workspace and reloaded |
| Pan, zoom, resize at every count | VERIFIED | same suite; frame counts from `requestAnimationFrame` inside the page during the gesture |
| Timeframe change, and back | VERIFIED | same suite — every anchor identical after the round trip |
| Instrument change, and back | VERIFIED | same suite — another instrument shows none of NQ's objects, and NQ restores all of them |
| Rapid mouse / crosshair / dragging with no stutter | VERIFIED | worst frame during an unpaced gesture: pan 19ms at 1 object, 35ms at 250; crosshair 18–25ms throughout |
| Visual regression screenshots for every major state | TESTED | `visual.spec.mjs` 23/23 with a structural baseline in `tests/browser/baselines/visual-states.json`; the trade states come from `drag-protect` and `execution-interaction`, named in the suite's manifest |

A note on what "visual regression" can mean here: the chart is drawn over real
market data, so the same state does not produce the same pixels an hour later.
Comparing whole screenshots would either fail every run or be given a
tolerance so wide it proved nothing. `visual.spec.mjs` therefore compares the
STRUCTURE of each state - how much of the drawing layer is painted, and where -
which turns out to be exactly reproducible (0% drift between runs) because the
objects are placed at fixed fractions of the plot. The screenshots are kept for
a human to look at, which is what a screenshot is good for.

## Known gaps

* **The remaining five tools have the shared interaction but not the per-tool
  pass.** `remaining-tools.spec.mjs` proves that ray, extended line, vertical
  line, text and measure place, select, move with the pointer, keep their
  anchors through a pan, offer exactly the settings they declare and delete.
  What none of them has had is the detail work the rectangle, trend line,
  horizontal line and fib got: the measure's readout, text styling, and
  whatever each tool's own settings should grow to.
* **Two behaviours worth writing down, found while checking the five.** A
  drawing anchored to a price the current view does not cover is legitimately
  off screen after a pan - it still exists and its anchors are unchanged - and
  the chart stops scrolling forward once the newest bar plus its right margin
  is in view, so a forward pan is not always a pan. Both were mistaken for
  defects by a first draft of the suite.
* **`docs/drawing-tools.md` is a specification I wrote** because the brief's
  own tool specification was never supplied. It is the list the work is
  measured against and it has not been reviewed.
* **Items from the earlier terminal brief remain unstarted** - multi-chart
  layouts, the journal page, the remaining tool families, crosshair
  customisation, the collapsible bottom panel and the navigation pass. They are
  feature work, and this pass was told to stop feature development.
