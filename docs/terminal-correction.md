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

---

## P2 — the drawing engine

### Long and Short position tools

New. They plan a trade and they never place one: nothing in them reaches the
order router, the account or the engine.

| Item | Status | Evidence |
|---|---|---|
| A long and a short position tool, in their own rail category | AUTOMATED TESTED + MANUALLY BROWSER VERIFIED | `position-tools.spec.mjs` (30) — "Risk and reward" in the catalogue; screenshots `position-long.png`, `position-both.png` |
| Entry, target and stop, from ONE click at a 2:1 default | AUTOMATED TESTED | same — 40 ticks up, 20 down, every price rounded to the instrument's tick |
| Each level dragged independently | AUTOMATED TESTED | same — the stop handle offers a resize cursor, drags the stop alone, and leaves the entry and the target to the tick |
| The body drags the whole trade without changing it | AUTOMATED TESTED | same — all three prices move, risk and reward unchanged |
| Risk and reward in ticks, with the ratio | AUTOMATED TESTED | same — "Risk 20 ticks · reward 40 ticks · R:R 2.00" |
| Priced in dollars by a contract count | AUTOMATED TESTED | same — 1 contract $100/$200, 3 contracts $300/$600 on NQ's $5 tick |
| Account risk as a percentage | AUTOMATED TESTED | same — $300 of a $50,000 account is "0.60% of the account" |
| Prices can be TYPED, not only dragged | AUTOMATED TESTED | same — a Coordinates group with Entry, Target and Stop; typing the stop moved the stop alone |
| It never places an order | AUTOMATED TESTED | same — no position opened, 27 order rows before and 27 after, and the account bar byte-identical |
| Both survive a reload | AUTOMATED TESTED | same |
| Unit arithmetic | AUTOMATED TESTED | `model.test.ts` — the 2:1 default, the short mirror, ticks/dollars/percent by hand, no ratio when the stop is at the entry, independent handles, the box's hit area |

### Two defects found while building them

**A saved position was thrown away on every reload.** Loading a chart checked
each stored object's anchor count against the number of CLICKS its tool takes.
A position tool takes one click and stores three anchors, so every one of them
failed that check and was silently dropped. The two numbers are now separate
(`ANCHOR_COUNT` for placement, `STORED_ANCHORS` for what a finished object
holds).

**An object edited outside a gesture could not be clicked where it was.** The
hit-test bounds cache is invalidated by a view change and by the end of a drag.
Geometry also changes with neither: a price typed into the settings dialog, an
undo, a template that moves a level. Those left a stale rectangle, so the
object rejected clicks on itself and accepted clicks where it used to be. The
cache now also compares the drawing object it computed from, which the store
replaces on every edit. Regression test: `bounds.test.ts`.

**A thick dashed or dotted line painted solid.** The dash pattern was fixed at
`[1, 3]` for dotted while the line cap was always round, so at five pixels wide
each cap was wider than the gap after it. The pattern now scales with the line
width and round caps are dropped whenever a pattern is in use.

### The Fibonacci level editor

| Item | Status | Evidence |
|---|---|---|
| Type any level, add, delete | AUTOMATED TESTED | `fib-levels.spec.mjs`, `line-tools.spec.mjs` — a custom 161.8% draws beyond the object |
| Per-level colour, opacity, name, visibility | AUTOMATED TESTED | `line-tools.spec.mjs` — fading one level fades that line alone |
| Per-level THICKNESS and LINE STYLE | AUTOMATED TESTED | `fib-levels.spec.mjs` — thickening one level paints 1,840 more pixels; dotting the same level breaks it up; setting it back paints exactly as before |
| Labels on the left or the right | AUTOMATED TESTED | same — the painted ink moves from 3,979/2,039 px left/right to 1,738/3,244 |
| Shading between levels, with its own opacity | AUTOMATED TESTED | same — mean alpha rises with shading on, stays faint at the default, and trebles at 0.5 |
| Presets, templates, save as default, reset | AUTOMATED TESTED | `drawing-engine.spec.mjs` (36) |
| Reverse, extend left/right, show prices, show levels | AUTOMATED TESTED | `line-tools.spec.mjs` |

---

## P4 — multi-chart layouts

| Item | Status | Evidence |
|---|---|---|
| An obvious chart layout control | AUTOMATED TESTED + MANUALLY BROWSER VERIFIED | `multi-chart.spec.mjs` — in the terminal's own top bar, its icon showing the layout in use; screenshot `grid-menu.png` |
| 1 / 2 vertical / 2 horizontal / 3 / 4 | AUTOMATED TESTED | same — each layout checked for its pane COUNT and its SHAPE (two side by side are 706px wide and the same height; two stacked are 1413px wide and the same height) |
| Each chart its own instrument | AUTOMATED TESTED | same |
| Each chart its own interval | AUTOMATED TESTED | same — 1m beside 15m |
| Each chart its own indicators | AUTOMATED TESTED | same — an RSI added to one chart appears on that chart alone |
| The active chart is obvious, and is what the ticket trades | AUTOMATED TESTED + MANUALLY BROWSER VERIFIED | same — an inset outline, and the order ticket's contract follows it |
| A chart can fill the layout and come back | AUTOMATED TESTED | same |
| A sync menu: crosshair, time, symbol, interval | AUTOMATED TESTED | same — the crosshair and the range are checked by what the OTHER pane applied, and the range is checked for not running away |
| The layout survives a reload | AUTOMATED TESTED | same |
| Four charts at once, on four intervals | MANUALLY BROWSER VERIFIED | screenshot `grid-four.png` — 1m, 5m, 15m and 1h of NQ, the active one outlined |

Two notes on how it is built, because both were deliberate:

* **Every pane is the same `ChartPanel`.** There is no separate multi-chart
  code path to drift out of step with the single-chart one; one chart is a
  layout with one pane.
* **Crosshair and range sync never go through React.** A crosshair move is a
  pointer-rate event; four panes re-rendering to move a vertical line is
  exactly the cost the performance work removed, multiplied by four. They go
  through a publish/subscribe with no state, and each pane applies what it
  receives inside its own animation frame.

And one defect the sync produced, twice, worth writing down: two panes
following each other's range **zoomed themselves into a five-minute window in
about a second**. A renderer reports a range change on its own next frame
rather than inside the call that caused it, so an in-call suppression flag
caught nothing. Only the pane being worked in now publishes, and an applied
range is quiet for 350ms. `multi-chart.spec.mjs` checks the range after a pan
is still more than twenty minutes wide.

---

## P5 — the journal

| Item | Status | Evidence |
|---|---|---|
| A real monthly calendar, Sunday to Saturday | AUTOMATED TESTED + MANUALLY BROWSER VERIFIED | `journal-calendar.spec.mjs` (18) — 40 cells in whole weeks; screenshot `journal-calendar.png` |
| Daily net P&L and trade count in each cell | AUTOMATED TESTED | same — "15 +$3,632.12 2 trades" |
| Green and red days | AUTOMATED TESTED | same — a wash plus an edge, so a green week is scannable |
| Weekly totals and a monthly total | AUTOMATED TESTED | same — five weekly totals, and "+$3,435.22 · 2 days · 7 trades · 1 green" |
| Month navigation | AUTOMATED TESTED | same — limited to months with something in them, opening on the most recent |
| Click a day to see its trades | AUTOMATED TESTED | same — "Showing 2026-09-15 · 2 trades", and a way back to all of them |
| Click a trade for its full detail, with MAE and MFE | AUTOMATED TESTED | same — "SHORT ES 1 7689.5 → 7659.5 +$1,497.31 2.99R held 5h 00m MAE -$200.00 MFE $2,300.00" |
| Put a trade back on the chart | AUTOMATED TESTED | same — and it now takes the TRADE's instrument: recalling an ES trade while the chart was on NQ used to do nothing at all, because the pane owns its instrument and changed it straight back |

---

## P6 — visual pass

### The typeface was chosen, not assumed

The brief asked for Geist, Inter and IBM Plex Sans to be **tested**. All three
were installed, the terminal was rendered in each at the sizes it actually
uses, and the results were measured in the browser rather than eyeballed:

| | account-bar metric group | header button | line box for `x` |
|---|---|---|---|
| Inter | 463px | 116px | 16px |
| Geist | 461px | 114px | 17px |
| IBM Plex Sans | 457px | 115px | 17px |

Screenshots: `docs/milestones/terminal-correction/font-inter-crop.png`,
`font-geist-crop.png`, `font-plex-crop.png` - the same account bar and chart
header in each.

The three are within 1.3% of each other for width, so horizontal space - the
thing that matters in a terminal, because it is width the chart wants - does
not separate them. What does: Atlas's small uppercase labels (`BAL`, `EQ`, `DD
LEFT`, `MAE`) live at 11px with letter-spacing, and every figure in the
platform is JetBrains Mono. Inter's caps hold their counters at that size and
its lowercase sits closest to JetBrains Mono's proportions; Plex is the most
characterful of the three and the least neutral beside it.

**Kept Inter.** The trial imports and both trial packages were removed again, so
nothing is shipped for a font that is not used. This is a decision recorded
rather than a change made: churning the typeface for its own sake is not a
quality improvement, and the measurement is what makes that a judgement rather
than an excuse.

### Indicator panes keep the price in view

With four oscillators on the chart the price pane was down to about 40% of the
height. The price is what is being traded, so the price pane's share now grows
with the number of indicator panes rather than being a fixed multiple of one.

---

## P7 — performance and the manual pass

### Performance

`stress.spec.mjs` measures the single-chart budget: a pan, a crosshair sweep
and a wheel zoom with 1, 10, 50, 100 and 250 objects on the chart, requiring
more than 30fps and no frame over 120ms. Measured (62/62 passed):

| objects | pan | crosshair | wheel |
| --- | --- | --- | --- |
| 1 | 60 fps, worst frame 17ms | 61 fps, worst frame 19ms | worst frame 17ms |
| 10 | 60 fps, worst frame 18ms | 61 fps, worst frame 18ms | worst frame 17ms |
| 50 | 60 fps, worst frame 18ms | 61 fps, worst frame 17ms | worst frame 19ms |
| 100 | 61 fps, worst frame 21ms | 61 fps, worst frame 17ms | worst frame 17ms |
| 250 | 60 fps, worst frame 19ms | 61 fps, worst frame 21ms | worst frame 18ms |

Two hundred and fifty objects cost about 2ms of worst-case frame time over one
object, which is the point of the screen-bounds cache: the paint pass walks
cached rectangles rather than re-projecting every anchor.

`perf-panes.spec.mjs` (new) measures what multi-chart added: the same three
gestures with FOUR charts open, and again with four charts keeping their
crosshair and their time range in step - which is the worst case, because every
pointer move then moves four charts. Measured (11/11 passed):

| charts | pan | crosshair | wheel |
| --- | --- | --- | --- |
| one | 61 fps, worst frame 18ms | 61 fps, worst frame 17ms | 61 fps, worst frame 18ms |
| four open | 60 fps, worst frame 18ms | 61 fps, worst frame 18ms | 61 fps, worst frame 18ms |
| four in step | 60 fps, worst frame 20ms | 61 fps, worst frame 18ms | 61 fps, worst frame 18ms |

Keeping four charts in step costs nothing measurable in frame rate (61 fps with
one chart, 61 with four, 61 synced) and about 2ms of worst-case frame time on a
pan. The suite asserts the synced figure stays above half the single-chart
figure, so a future regression that makes sync expensive fails the build rather
than being noticed by a trader.

### The manual pass

`tests/browser/manual-pass.mjs` is not a suite. It walks the whole terminal at
1680x1050 and photographs every step, so the pass can be judged by eye: an
assertion cannot tell you that a label is ugly, a control is hidden or a panel
is cramped. Its steps: sign in, three intervals, two instruments, wheel zoom in
and out, a pan, reset the scales, draw all nine ordinary tools, place both
position tools, select one and open its style bar and its settings, the object
tree, add two indicators and see their settings and rows, the layout menu, four
charts, maximize and restore, two charts, the journal's four tabs including a
day drilldown and a trade's detail, practice, the ticket's presets, all five
blotter tabs, the blotter collapsed, every settings section, and back to a
clean single chart.

I ran it, opened every one of the thirty-nine screenshots and looked at them.
Five things were visibly wrong and are fixed; the pass was then re-run and each
fix re-checked in the same shot that had shown the fault.

| what the screenshot showed | why | fix |
| --- | --- | --- |
| The object tree opened downwards from a button 20px clear of the bottom edge, so eleven objects and the "remove all" action shared a 169px slot | every popover opened downwards, unconditionally | a popover flips above its anchor when the space below is cramped and there is more of it above (`verticalPlacement`, unit-tested) |
| "MA 20 close" printed through the OHLC in a narrow pane | the legend was pinned 26px down, which is right only while the status line is one line - two charts and the journal wrap it onto three | the legend reads the status line's height each frame and starts below it |
| A position tool's coordinates clipped "29700.50" to "2970(", and the dialog ended halfway through a checkbox row | a price was given the 66px width a contract count gets, and the dialog was capped at 640px in a 1050px window | wider price fields; both dialogs tall enough for their longest panel |
| Every colour well in the settings dialog looked the same pale grey | Chromium's swatch sits inside its own 4px wrapper with a light border of its own | the wrapper's padding and the swatch's border are zeroed |
| The journal printed an exit of "29455.5" beside an entry of "29460.75" | the number was rendered raw rather than at the instrument's precision | prices are formatted at the instrument's `pricePrecision` |
| A practice account's profit target read "$1,000,000.00", a goal it was 0.01% of the way towards | the practice template carries an unreachable placeholder rather than no target | the blotter prints "no target" for a practice account |

The screenshots behind these are `docs/milestones/terminal-correction/`.

---

## What is NOT finished

Written plainly, because the brief asked for exactly this list rather than for
a claim of completeness.

* **The five secondary drawing tools still have no per-tool pass.** Ray,
  extended line, vertical line, text and measure place, select, move, keep
  their anchors through a pan, offer the settings their registry entry declares
  and delete - `remaining-tools.spec.mjs` proves all of that. What none of them
  has had is the detail work the rectangle, trend line, horizontal line, fib
  and the two position tools got: the measure's readout, text styling, and
  whatever each tool's own settings should grow to.
* **Indicator panes cannot be resized by dragging their separator.** The price
  pane's share of the height adapts to how many panes are below it, but a
  trader cannot set it by hand.
* **The drawing toolbar's contextual bar is a style bar, not a full contextual
  toolbar.** Style, lock, duplicate and delete are on it; coordinates and
  visibility are in the settings dialog rather than beside the object.
* **Only two Fibonacci tools' worth of the family exists.** The retracement is
  complete, including the level editor; fans, arcs, time zones and the
  extension-as-its-own-tool are not built.
* **The alerts, watchlist, hotkey editor and screenshot-with-annotations
  features** that a TradingView-class terminal has are not in this milestone
  and were not asked for in it.

---

## Defects found and fixed in this pass, in one list

Each one was found by using the terminal, not by reading the code.

1. **Every drawing placement was silently refused** after a chart style change
   or any appearance change structural enough to rebuild the price series. The
   cached projection held a removed series, which answers null for every price.
2. **A saved position tool was thrown away on every reload**, because loading
   checked a stored object's anchor count against the number of clicks its tool
   takes.
3. **An object edited outside a gesture could not be clicked where it was**: a
   typed price, an undo or a template left a stale hit-test rectangle.
4. **A thick dashed or dotted line painted solid**, because the dash pattern was
   fixed while the line cap was always round.
5. **The indicator menu's gear opened the chart settings dialog**, not the
   indicator it sat beside.
6. **Recalling a trade from the journal did nothing** when the trade was on
   another instrument.
7. **The chart offered a stop where a stop cannot go**: the leg was decided
   against the entry while the engine decides against the market, so a drag on a
   position that had moved against the trader previewed a stop and came back
   refused.
8. **A position opened inside a recording could be stranded**: the guard that
   stops a recording re-pricing a live position also refused the way back.
9. **The price pane shrank to 40% of the chart** with four oscillators under it.
10. **The order ticket grew past its height budget** because the preset row
    wrapped at the default panel width.
11. **The object tree was unusable at the bottom of the rail** - see the manual
    pass table above, along with the legend collision, the clipped coordinate
    fields, the pale colour wells, the unpadded journal price and the practice
    account's fictional profit target. Those six were found by looking at the
    screenshots, which is what the screenshots are for.
12. **The chart showed one market while the account traded another.** The worst
    of them, and the last one found. See below.

---

## The chart showing the wrong market

This one is worth its own section, because it is the exact failure mode the
brief exists to prevent and because of how it was found.

A protective-drag check started failing: dragging DOWN from a long's marker
produced a TARGET. Screenshotting the moment showed why. The account held
`NQ LONG 1 @ 29459.75`, marked at `29458.75`, and the chart above it was
showing NQ at **29720** - the live session - with "REPLAY PAUSED" over it and
a note reading "The replay has not emitted any bars yet. Press play." The
position marker was clamped to the bottom edge of the plot because its price
was nowhere near the range being drawn, and a drag "below" it landed on the far
side of a market that was not the market being traded. The blotter was right
the whole time; only the candles were lying.

Three separate causes, all in the browser and none in the engine:

1. **An empty bars response was treated as "nothing new".** The rule was "an
   empty response over the same instrument leaves the series alone", added so
   that loading a replay that has not emitted anything would not wipe the chart
   and take the price scale (and every order marker's coordinate) with it. It
   did not ask whether the response came from the same SOURCE. A new source with
   nothing to show is the opposite case, and it was being handled as the same
   one. The comparison now includes the provider, and an empty page from a new
   provider clears the chart. An empty chart that says why is honest; the old
   behaviour was not.
2. **Clearing the bars left the indicators drawn.** `renderIndicators` returned
   early when there were no bars, so a moving average computed from the live
   session kept its line - and the price scale that line implied - over an
   emptied chart. No bars now means no indicator values.
3. **A paused replay that is moved announces nothing.** Restart, Step, Skip and
   Seek all advance the recording without putting a bar on the stream, so a
   chart correctly emptied at cursor zero stayed empty for the rest of the
   session even after the recording had half an hour of bars to give it. The
   chart now asks again when the recording's cursor has moved and it is holding
   nothing - only then, so a replay that is playing normally re-fetches nothing.

What made this hard to see is that every honest signal was already there: the
mode badge said REPLAY PAUSED, the note said the replay had emitted nothing,
the blotter showed the real mark. The candles were the one thing that was
wrong, and candles are the thing a trader reads.

---

## Test results, as run on this machine

Workspace suites (`pnpm test`): unit and integration, including the P0
arithmetic and the drawing geometry.

Browser suites (`pnpm test:browser`), each against the real server, the real
database and the real delayed market data:

| Suite | Result |
|---|---|
| terminal | 20/20 |
| responsive | 15/15 |
| chart-navigation | 23/23 |
| indicators | 22/22 |
| drawing-pointer | 16/16 |
| drawing-engine | 36/36 |
| position-tools | 30/30 |
| fib-levels | 16/16 |
| multi-chart | 25/25 |
| journal-calendar | 18/18 |
| rectangle | 43/43 |
| line-tools | 68/68 |
| remaining-tools | 56/56 |
| drag-protect | 25/25 |
| execution-interaction | 30/30 |
| stress | 61/62, then 62/62 after the interval check was corrected |
| perf-panes | 11/11 |
| visual | 22/22 |
| tools | 26/26 |
| replay-brackets | 12/12 |
| layout | 8/8 |
| admin | 28/28 |
| acceptance | 20/20 |

Three of those runs failed first and were fixed rather than explained away:
the drag-protect stop-leg disagreement (a product defect, fixed in the
product), the execution suites being handed a recording by a crashed
predecessor (a harness defect, fixed in the harness), and the stress interval
check looking for an object where the terminal no longer opens (a test
expectation, corrected).
