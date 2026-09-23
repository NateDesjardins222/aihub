# Atlas — Charting Tools Visual Rebuild + Market Motion/Candle Correction V2 — final report

## 1. Hashes
- **Starting baseline (prompt):** `69efc6d` (Terminal Correction V1 close).
- **Actual starting tip:** `26d176c` (the branch had advanced one commit past
  `69efc6d`: the zoom-out fix). All V2 work builds on `26d176c`.
- **Final hash:** filled in the closing commit; it is the tip of
  `claude/futures-trading-simulator-v8qefu`.

## 2. Standard held
This was treated as a visual + interaction quality problem, not a testing
problem. Every change was inspected in a real browser against the real server
and PostgreSQL and captured as a screenshot; the reference screenshots were the
product requirement. Companion docs: `charting-visual-rebuild-v2-defects.md`
(ledger), `-market-motion.md` (V-06), `-candle-audit.md` (V-07).

## 3. Tools added
Three genuinely-functional drawing tools, fully wired (model kind + anchor
tables + hit-test + paint + registry ToolDef + native icon + store persistence
+ keyboard shortcut):
- **Cross Line** (LINES) — a horizontal + vertical through one point. Alt+C.
- **Horizontal Ray** (LINES) — horizontal from the anchor rightwards. Alt+J.
- **Arrow** (ARROWS) — a trend line with a filled arrowhead.

The eleven pre-existing tools (Trend Line, Ray, Extended Line, Horizontal Line,
Vertical Line, Rectangle, Fib, Text, Measure, Long/Short Position) were
reorganised into the reference categories and restyled.

## 4. Tools deferred (and why)
Not shipped as fake rows — omitted from the menu and listed here honestly. Each
needs geometry/plumbing beyond a visual pass:
- **Channels** (Parallel, Regression Trend, Flat Top/Bottom, Disjoint) — 3–4
  anchors + parallel-offset math + regression fit.
- **Pitchfork** — 3 anchors + median/parallel tine geometry.
- **Brushes** (Brush, Highlighter) — freehand point-stream capture + smoothing +
  a new stored point-array model.
- **Arrow marks** (Up/Down/Left/Right, Arrow Marker) — glyph-stamp model.
- **Shapes**: Rotated Rectangle (rotation handle), Path (poly-point), Circle
  (ellipse geometry + hit-test).
- **Projection**: Forecast, Bars Pattern, Ghost Feed, Projection — bar-copy /
  projection models.
- **Volume-based**: Anchored VWAP, Fixed Range Volume Profile — need per-bar
  volume plumbed to the client and a histogram renderer.
- **Measurer**: Price Range, Date Range (the existing Measure is the Date-and-
  Price range); Info Line, Trend Angle (LINES variants).

These are the honest next tranche; the milestone chose depth (Fib, Long/Short,
menu, typography, motion, candles) over shipping ~30 shallow placeholders.

## 5. Fib — before / after
- Before: default label was "23.6%  30824.90" (percent AND price); labels in
  `ui-monospace`.
- After: default label is the percentage alone — 0.0% / 23.6% / 38.2% / 50.0% /
  61.8% / 78.6% / 100.0% — in DM Sans; "Show prices" is an opt-in setting
  (default off). Level lines span the object; anchors small; compact floating
  toolbar. Screenshot `cvr-fib-selected.png`.

## 6. Long / Short — before / after
- Before: fixed 20/40-tick box (looked crushed); the two were near-identical; the
  overlay stacked pts, R, ticks and dollars.
- After: box sized to the visible range (stop ≈ 8 % of height, target 2×, floor
  20 ticks) so it is never crushed; a coloured LONG/SHORT badge on the entry
  line; long = green target above / red stop below, short = the mirror; money off
  by default so the overlay reads pts, R, ticks in DM Sans. Screens
  `cvr-long-selected.png`, `cvr-short-selected.png`.

## 7. Typography changes
One `labelFont()` helper in `paint.ts` returns a literal DM Sans stack for every
canvas label. This both removed the `ui-monospace` "engineering" look and fixed a
real bug: `ctx.font = "…px var(--font-ui)…"` cannot be parsed by a canvas context
(no CSS `var()`), so TEXT/MEASURE/RECTANGLE labels had been silently falling back
to the 10px default. The rail flyout row also uses `var(--font-ui)`.

## 8. Icon implementation
Native inline SVG (`ui/Icon.tsx`, 16×16, 1.4 stroke, `currentColor`). New
`horizontal-ray` icon added; existing `cross-line` and `arrow-marker` geometry
wired to the new tools. No emoji, no icon-library substitutes, no raster.

## 9. Drawing interaction changes
Scale-aware position spawn; LONG/SHORT hit-tests unchanged (bounding box); new
kinds have hit-tests (cross = either arm; horizontal-ray = rightward; arrow =
segment). Alt-key tool shortcuts (T/H/J/V/C, Shift+R) bound in
`useDrawingInput`. All existing create/select/move/edit/delete/undo/redo,
magnet, persistence paths are unchanged and still pass their suites.

## 10. Market-motion measurements
See `-market-motion.md`. Live: provider cadence `observedCadenceMs` ≈ 5.3–6.9 s;
poll seed 5 s; vendor delay ~601 s; bus dropped duplicate 1.19 %, quarantine
0.15 %, out-of-order 0.05 % of 45 188; aggregator 15/15 prices accepted.

## 11. Why the tick movement is slow
**The free Yahoo feed only publishes a new price about every 5–10 seconds
(measured ~6 s), so between prints there is genuinely nothing new to draw; the
SMOOTH easing then spreads each print over ≤1.2 s.** Atlas adds no throttle or
batching and its gates drop ~1.3 %. Provider-bound; the paused Databento feed is
the fix. The ~600 s delay is a separate provider property.

## 12. Candle audit
See `-candle-audit.md`. Fresh live pull of 31 consecutive NQ 1m bars: 0 OHLC
violations, 0 integrity violations, exact 60 s spacing, no gaps/dupes, valid
forming bar, tick-aligned. Classified: DATA/AGG/FORMING/RENDER sound; residual is
class C (provider origin — delayed continuous `=F`). Renderer is lightweight-
charts native `CandlestickSeries` (sharp, DPR-correct).

## 13. Remaining provider limitations
Exact per-bar parity and freshness versus a realtime CME-direct reference cannot
be achieved on `yahoo-delayed` (delayed, continuous, Yahoo-aggregated). Closed
only by the professional Databento feed, which is PAUSED; no credentials were
requested this milestone.

## 14. Unit totals
- Web unit: **247 passed (18 files)**.
- Full workspace `pnpm -s test`: <!--UNIT--> (filled in the closing commit).
- Workspace typecheck: clean (web, server, core).

## 15. Browser totals
- `cvr-v2` acceptance probe: **10/10** (Fib percent-only, Cross Line, Horizontal
  Ray, Arrow, Long, Short, Text, Measure, reference-category menu, no errors).
- Drawing torture suites (existing, re-run against the changes): <!--TORTURE-->.

## 16. Drawing torture totals
<!--TORTURE2-->

## 17. Performance
The three new tools reuse the existing imperative paint path (rAF signature gate
in `DrawingCanvas`); no new per-mousemove React state. No measured regression in
the drawing suites' timing.

## 18. Screenshot / visual acceptance results
- Fib: percentage-only, DM Sans — PASS (`cvr-fib-selected.png`).
- Long/Short: distinct, uncrushed, minimal labels — PASS (`cvr-long-selected.png`,
  `cvr-short-selected.png`).
- Tool menu: reference categories + native icons + shortcuts — PASS
  (`cvr-tool-menu.png`).
- Measure / Text: DM Sans readout — PASS (`cvr-measure.png`, `cvr-text.png`).

## 19. Remaining defects / deferred
- The ~30 deferred tools in §4.
- V-06 provider cadence and V-07 per-bar parity — provider-bound (paused feed).
- Fib/Long/Short/Measure floating-toolbar and per-tool settings inherited from
  TC-V1 are functional; deeper per-tool visual polish beyond the acceptance
  gates is future work.
