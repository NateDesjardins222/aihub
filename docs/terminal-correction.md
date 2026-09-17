# Terminal correction milestone

The brief for this pass: *"Several features reported as complete are either
unusable, incomplete, difficult to discover, incorrectly implemented, or do not
behave as specified. My manual browser experience is the acceptance standard."*

Three words are used below and they are not interchangeable, because the brief
asked for exactly this distinction:

* **IMPLEMENTED** — the code is there.
* **AUTOMATED TESTED** — a check drives it and passes; the suite is named.
* **MANUALLY BROWSER VERIFIED** — it was used by hand in a real browser at a
  normal desktop size, and what was seen is written down.

An item never claims a later word on the strength of an earlier one.

---

## P0 — data and financial integrity

Written up in full in [`p0-data-and-pnl.md`](p0-data-and-pnl.md): the root
cause of the P&L defect (open positions re-marked against a different market
data source, a missing mark reported as zero, anchors advanced from an
unvalidated mark), the root cause of the artificial price gaps (a stale
re-published observation creating a bar in the past and moving the integrity
anchor), the fixes, and the before/after figures.

Evidence: `pnl-reconciliation.test.ts` (9), `price-integrity.test.ts` (10),
`candles.test.ts`, plus the browser reproduction of the refusal message.

---

## P1 — chart interaction

| Item | Status | Evidence |
|---|---|---|
| Wheel zoom is cursor-anchored and paced | AUTOMATED TESTED + MANUALLY BROWSER VERIFIED | `chart-navigation.spec.mjs` — 9.4% per notch, the bar under the cursor exact at 25% and 75% of the width |
| Shift-wheel pans instead of zooming | AUTOMATED TESTED | same suite |
| Price axis and time axis drag to scale | AUTOMATED TESTED | same suite — 792.9 → 1324.4 points of visible range |
| The chart opens on the recent session, not 1,206 bars | AUTOMATED TESTED | same suite; `showRecent()` replaced `fitContent()` |
| Crosshair style, thickness, strength and labels are settings | AUTOMATED TESTED | same suite — thickening paints 4,318 → 6,128 px of crosshair ink |
| The settings dialog closes on Escape and on the scrim | MANUALLY BROWSER VERIFIED | `SettingsDialog.tsx`; used by hand |
| No control overflows or overlaps down to 1280×720 | AUTOMATED TESTED | `responsive.spec.mjs` (15) — every visible control checked for `scrollWidth > clientWidth` and for sibling overlap, at five window sizes, with the splitters dragged to both extremes |

### The defect that made the drawing engine unusable

This one is worth its own section, because it is exactly the class of thing the
brief was describing: reported complete, tested, and yet the terminal in front
of the user could not draw.

`LightweightChartsAdapter.projection()` caches one projection object for the
life of the chart — deliberately, because allocating six closures per frame
showed up in a CPU profile. That object closes over the **price series**.
Rebuilding the price series — which happens on a chart style change, and on any
appearance change structural enough to rebuild it, such as the candle colours
or the scale side — left the cached projection holding a series the renderer
had already removed. A removed series answers `null` to `coordinateToPrice`, an
anchor needs both a time and a price, so `anchorAt` returned null and **every
drawing placement was silently refused**. The tool still armed, the crosshair
still moved, nothing threw, and no object appeared.

Fix: `createPriceSeries()` invalidates the projection cache, one line, at the
point the series dies.

Regression check: `drawing-engine.spec.mjs` now switches the chart style to
Bars, places a horizontal line, switches back to Candles and places another.
With the fix removed the suite fails at its third check with `0 lit pixels`.

---

## P3 — indicators

| Item | Status | Evidence |
|---|---|---|
| Every indicator is an editable instance | AUTOMATED TESTED | `indicators.spec.mjs` (22) |
| Adding one opens its own settings, with a real numeric length | AUTOMATED TESTED | same — Length, Source, Colour, Thickness, Line style, Opacity |
| The length is visible without opening anything | AUTOMATED TESTED + MANUALLY BROWSER VERIFIED | legend rows read `EMA 9 close 29740.94`, then `EMA 21 close 29737.20` |
| EMA 21 / 50 / 200 at once, independent, distinct colours | AUTOMATED TESTED | same — three rows, three lengths, and each further instance of a kind takes the next palette colour so two EMAs are never the same line |
| Values follow the crosshair | AUTOMATED TESTED | same — 29720.26 at 30% across, 29724.42 at 75% |
| Hide, settings, duplicate and remove from the row itself | AUTOMATED TESTED | same |
| A multi-plot indicator is one row, not three | AUTOMATED TESTED | same — `BB 20 2 close` with its three values |
| An oscillator's row sits in its own pane | AUTOMATED TESTED + MANUALLY BROWSER VERIFIED | same — EMA row at y=92, RSI row at y=643; screenshot `indicators-three-emas.png` |
| Instances survive a reload | AUTOMATED TESTED | same — 5 → 5 |
| The indicator menu's gear opens that indicator | MANUALLY BROWSER VERIFIED | it used to open the chart settings dialog on its Symbol tab, which had nothing to do with the indicator the gear sat next to |

Still owed here: nothing identified, but the panes have had no per-pane height
work (an oscillator pane cannot be resized by dragging its separator yet).
