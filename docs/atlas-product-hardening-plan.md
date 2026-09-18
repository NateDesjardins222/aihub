# Atlas product hardening — the plan, and what the measurements already say

The brief for this milestone is unusual and worth restating, because it decides
what this document is for: *"This is NOT a feature-expansion milestone… The
purpose is to identify weak areas BEFORE blindly changing them."*

So nothing here is a guess. Every "current behaviour" below was produced by
driving the real application and recording what happened. Where a number is
absent it says so rather than being estimated, and where a first measurement
was **wrong** the correction is written down, because a plan built on a bad
measurement is worse than no plan.

Three instruments, all re-runnable:

```
node tools/perf-baseline.mjs [--save]      # every interaction, p50/p95/p99/worst
node tools/perf-startup.mjs [runs]         # navigation to a usable chart
node tools/perf-stress.mjs drawings|indicators|charts|endurance [arg]
```

Three words are used and are not interchangeable: **IMPLEMENTED** (the code is
there), **AUTOMATED TESTED** (a check drives it and passes), **MANUALLY
VERIFIED** (it was used by hand and what was seen is written down).

---

## What the instrument had to be, before it could be trusted

The existing checks reported average FPS and the worst frame. That is not
enough, and the brief says why: *"A terminal averaging 60 FPS but freezing every
few seconds is NOT smooth."* `tools/perf/probe.mjs` records the whole frame-time
distribution and measures input latency three ways, because each one lies on its
own:

| | what it is | what it is good for | how it lies |
| --- | --- | --- | --- |
| `frames` | every rAF delta, kept | real p50/p95/p99 and counts over 20/33/50ms | says nothing about input |
| `interactions` | the Event Timing API | the browser's own input→paint account | Chromium rounds `duration` to 8ms |
| `response` | `event.timeStamp` → next frame | full precision | stops at the callback, not the pixels |

**Two flaws in my own first draft, corrected before anything was reported:**

1. *"Frames over 16.7ms"* counted floating-point noise on a 60Hz display — it
   reported 98 of 98 frames during a demonstrably smooth pan. The thresholds are
   now **20ms** (the first honest sign of a missed frame), 33ms and 50ms.
2. The first sweep reported **"startup 16,614ms"**. That is not the application:
   it is the shared sign-in helper sleeping on purpose so that later checks are
   not racing it. Measured properly by polling for milestones, startup is about
   **420ms**.

---

## Performance, as measured

### Startup — median of three runs

| milestone | ms |
| --- | --- |
| navigation → sign-in form or shell | 43 |
| credentials accepted → terminal | 217 |
| → a chart canvas exists | 23 |
| → candles actually painted | 53 |
| → status line carries a real price | 83 |
| **total to a usable chart** | **~420** |

DOM 290 nodes, heap 10.7MB, 1KB transferred (the bundle is served from cache on
a warm preview). **No action needed.**

### Every interaction, at rest

Frame times at the default workload are essentially perfect: p50 16.7ms
everywhere, **zero frames over 50ms and zero long tasks in every scenario**.
The full table is in `tests/browser/baselines/performance.json`.

The one signal in the whole sweep: **wheel zoom's response tail**.

| | p50 | p95 |
| --- | --- | --- |
| our wheel handler | 20.8ms | 37.9ms |
| the renderer's own wheel handling | 20.4ms | 21.4ms |

Investigated properly rather than guessed at:

* The handler's own cost is **0.00–0.20ms**. There is no application work to
  remove.
* Applying the zoom as a **bar-spacing** change instead of a visible-range
  change — which is what the renderer's internal path changes — was **no
  faster** (both 2 frames, p50 36.7 vs 36.8ms).
* **Coalescing wheel events to one write per animation frame made it three
  times worse** (p50 20.8 → 63.2ms, 1 frame → 3), because deferring to a frame
  *adds* a frame. Measured, reverted, and recorded here so nobody tries it
  again.

**Conclusion: the remaining tail belongs to the renderer's scheduling, not to
our code, and the one optimisation available made it worse.** Logged as a known
issue rather than chased; the right-edge-anchored zoom the previous milestone
was explicitly asked for twice is worth more than 16ms at p95.

### Drawings — 0 to 1000 objects

| objects | pan fps | pan p95/worst | crosshair fps | zoom fps | long tasks | heap |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 60 | 16.8 / 17 | 60 | 60 | 0 | 13.6MB |
| 100 | 60 | 16.7 / 17 | 59 | 60 | 0 | 22.3MB |
| 250 | 60 | 16.8 / 17 | 59 | 59 | 0 | 14.4MB |
| 500 | 60 | 16.7 / 17 | 59 | 59 | 0 | 11.0MB |
| 750 | 60 | 16.7 / 17 | 59 | 59 | 0 | 14.4MB |
| **1000** | **60** | **16.7 / 17** | **58** | **60** | **0** | 15.6MB |

No degradation at all, and DOM stays at 313 nodes because the objects are
painted on a canvas rather than built as elements.

**This was too clean to report unverified.** The brief warns against benchmarks
that pass because the work is not happening, so the painted pixels were counted:
**0 at none, 32,914 at a hundred, 108,911 at a thousand.** The objects are on
the canvas and the frame rate is real. **No action needed.**

### Multi-chart — 1 to 4 panes

| layout | pan fps | pan p95/worst | long tasks | heap | DOM | canvases |
| --- | --- | --- | --- | --- | --- | --- |
| 1 chart | 60 | 16.8 / 17 | 0 | 11.2MB | 290 | 8 |
| 2 charts | 60 | 16.7 / 17 | 0 | 11.3MB | 387 | 16 |
| 3 charts | 60 | 16.7 / 17 | 0 | 18.6MB | 480 | 24 |
| 4 charts | 60 | 16.8 / 17 | 0 | 20.8MB | 573 | 32 |
| 4 charts + 250 drawings | 60 | 16.7 / 17 | 0 | 32.1MB | 662 | — |

Linear and cheap: 93 DOM nodes and 8 canvases per chart. **No action needed.**

### Indicators — the one real scaling problem

| studies | pan fps | pan p95/worst | timeframe worst frame | long tasks | heap | DOM |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 60 | 16.7 / 17 | 17ms | 0 | 15.3MB | 310 |
| 5 | 60 | 16.7 / 17 | 17ms | 0 | 61.6MB | 396 |
| 10 | 57 | 16.8 / 33 | 33ms | 0 | 44.1MB | 529 |
| 20 | 52 | **33.4** / 67 | 83ms | 1 | 38.5MB | 783 |
| 30 | 52 | **33.3** / 100 | **133ms** | **13** | 118.0MB | 1037 |

And the combinations:

| | pan fps | pan p95/worst | crosshair fps | zoom fps | long tasks | heap |
| --- | --- | --- | --- | --- | --- | --- |
| 100 drawings + 10 studies | 60 | 16.7 / 17 | 59 | 59 | 0 | 41.2MB |
| 250 + 10 | 60 | 16.7 / 17 | 55 | 59 | 1 | 73.1MB |
| 500 + 10 | 53 | 16.8 / 83 | 51 | 58 | 13 | 87.7MB |
| 250 + 20 | 60 | 16.8 / 33 | 53 | 51 | 5 | 116.4MB |

**Pan p95 doubles between 10 and 20 studies. A timeframe switch with 30 of them
freezes for 133ms — a visible stall.** Drawings and indicators compound: 500
drawings alone is 60fps, 10 studies alone is 57fps, together they are 53fps with
13 long tasks.

#### The first root cause was wrong, and the ladder above is partly an artefact

A CPU profile of a pan with 20 studies read 42% idle, 33% browser program time
and a few percent application JavaScript, with `lineTo`, `save`, `fillRect` and
`fillText` on top. That was read as **canvas paint across many panes**. It was
not, and the ladder above cannot be reproduced on demand: the same 20 studies
measured p95 33.4ms in one run and 16.7ms in the next, on a machine whose own
arithmetic yardstick (a fixed 20-million-iteration loop, timed in the page)
said it was equally free both times — 36 to 42ms in every round.

So the configurations were interleaved instead of laddered, and the variables
separated one at a time:

| what was varied | result |
| --- | --- |
| 20 oscillators, each in its own pane | 60fps, **0 frames over 33ms** — pane count is not the cost |
| 20 overlays, all on the price pane | degraded in some runs, clean in others |
| 2,587 bars on screen, no studies | 60fps, 0 frames over 33ms |
| 20 studies, **0 ticks during the pan** | **p95 16.7ms, 0 frames over 33ms** |
| 20 studies, **19–23 ticks during the pan** | **p95 33–50ms, 21–24 frames over 33ms, 600–700ms of indicator arithmetic** |

**The cost is the live market, not the pointer and not the paint.** Every tick
that moves the bar in progress recomputed every study over every bar the chart
held — measured at ~31ms per tick with 20 studies — and each of those lands
inside a frame. A pan during a moving market drops a fifth of its frames; the
identical pan during a still one drops none. The bimodality in the ladder is
whether the market happened to be moving.

Two fixes, both measured:

* **Nothing is recomputed whose answer cannot have changed.** An indicator is a
  pure function of the bars and its parameters, so results are cached against a
  bar revision, and a study whose answer is unchanged is not handed back to the
  renderer either — `setData` on an unchanged series makes the library
  re-validate every point it holds. Adding the twentieth study used to
  recompute the other nineteen: **worst single pass 62.7ms → 8.7ms** at 20
  studies, measured in the page.
* **A tick computes only as far back as its own answer reaches.** Each
  indicator declares that distance (`tailBars`); VWAP declares null and keeps
  the whole history because its anchor is the session. Arithmetic per tick over
  1,500 bars: **4.12ms → 1.18ms at 20 studies, 5.43ms → 1.71ms at 30**, and
  `tail-window.test.ts` holds every declared window to the full-history answer
  to within 1e-9 relative across fifteen parameter combinations.

**What could not be measured, and why it is said rather than fudged.** The
end-to-end A/B — the same pan, with and without the fix, on a chart holding
1,500 bars while the market ticks — needs a moving market, and the feed was
quiet for most of this work. A replay was tried as a substitute and **was not
one**: a replay opens on nine bars and builds up, so at 46 bars a declared
window of 620 is longer than the history and the windowed path never runs. The
before/after runs under it are therefore identical, and they are reported here
as a failed experiment rather than as evidence of anything.

What IS end-to-end tested is correctness, in `tests/browser/live-indicators.spec.mjs`:
under a playing replay, with a Bollinger band whose 22-bar window IS shorter
than the history, the values keep moving, the band keeps its 37 points over 56
bars instead of collapsing to its window, and the lines it is drawn from keep
theirs. **That suite caught a real regression in this very change**: leaving
the cached plot untouched on a windowed tick made the crosshair read `—` over
every bar printed since the last full redraw.

DOM still grows ~24 nodes per study, and each oscillator still takes its own
pane with its own price scale and canvas. That was never the problem.

### Endurance — eighteen minutes of continuous use

Around 150 cycles of pan, zoom, timeframe change, symbol change, indicator
add/remove and a trip through the journal, sampled 236 times.

| | heap min | heap mean | heap max | DOM | canvases |
| --- | --- | --- | --- | --- | --- |
| first half | 9.6MB | 17.8MB | 37.5MB | 288–290 | 8 |
| second half | 11.0MB | 21.0MB | 38.0MB | 288–290 | 8 |

The heap saw-tooths between collections; what matters for a leak is the floor,
and it moved 1.4MB in eighteen minutes with no trend. DOM nodes and canvases
are flat. **No leak. Zero page errors.**

### Rapid input and races — nineteen ways to use it badly

Six symbol changes in under a second, seven timeframe clicks, five layout
switches, indicator add/remove hammering, drawing create/undo/redo hammering,
six settings cycles, a timeframe click landing inside a symbol load, fast panel
drags, fast account switches. The checks are about state, not about whether a
click landed: the chart and the order ticket agree on the instrument, exactly
one interval is active, what is painted agrees with what is stored, and nothing
is left stranded on the screen.

**19 of 19 pass**, no console errors, chart alive at the end. Kept as
`tests/browser/abuse.spec.mjs`.

---

## Workflow inventory

Status keys: **✓** verified this milestone · **~** partially · **✗** not yet ·
**!** defect found.

| workflow | expected | current (measured) | performance | failure modes | responsive | persistence | errors | manual | automated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| application startup | usable chart quickly | ~420ms to a live price | ✓ | none seen | ✓ | workspace restored | none | ✓ | perf-startup |
| login | credentials → terminal | 217ms | ✓ | not yet tested: wrong password, expired token | ✗ | token in localStorage | none | ~ | acceptance |
| account selection | switch account, figures follow | works | ✗ not timed | not yet tested under load | ✓ | selection persists | none | ~ | acceptance, admin |
| chart loading | candles painted | 53ms after canvas | ✓ | not yet tested: empty/failed bars | ✓ | n/a | none | ✓ | terminal |
| symbol switching | new instrument, old objects gone | works | 60fps | **race not yet tested** | ✓ | per-symbol drawings | none | ✓ | drawing matrix |
| timeframe switching | re-fold, keep view | works | **133ms worst at 30 studies !** | — | ✓ | favourites persist | none | ✓ | chart-navigation |
| chart navigation / pan | direct, 1 frame | p50 9.2ms, 1 frame | ✓ 60fps | — | ✓ | viewport kept | none | ✓ | chart-navigation |
| zoom (wheel) | right edge anchored | p50 20.8ms, p95 37.9ms **!** | tail worse than built-in | — | ✓ | — | none | ✓ | chart-navigation |
| crosshair | follows pointer, reads values | 58–60fps at every load | ✓ | — | ✓ | shape persists | none | ✓ | chart-navigation |
| price scale | drag scales, double-click restores | 384.8 → 656.8 → 384.8 | ✓ | — | ✓ | — | none | ✓ | chart-navigation |
| time scale | drag spaces, double-click restores | 186 → 139.8 → 183.9 bars | ✓ | — | ✓ | — | none | ✓ | chart-navigation |
| indicators | add, remove, independent | works | ✓ after the tick fix | — | ✓ | survives reload | none | ✓ | indicators, tail-window |
| indicator settings | per-parameter, live | works, sectioned | ✓ | — | ✓ | persists | none | ✓ | indicators |
| indicator panes | own pane, resizable | drag, double-click to reset | ✓ | — | ✓ | split persists | none | ✓ | pane-resize |
| indicator legend | compact, own row | 22px targets; rows still jump up to 31px when one is removed **!** | ✓ | — | ✓ | — | none | ✓ | indicators |
| drawings | place, edit, persist | 11 tools × 20 steps pass | ✓ to 1000 | — | ✓ | per symbol | none | ✓ | drawing matrix |
| drawing hover | cursor indicates a target | `move` on a body, `nwse-resize` / `nesw-resize` on a handle | ✓ | — | — | — | none | ✓ | drawing-pointer |
| drawing settings | object-appropriate | sectioned | ✓ | — | ✓ | persists | none | ✓ | remaining-tools |
| Fibonacci | arbitrary levels | 11.1/33.3/88.8/261.8 verified | ✓ | — | ✓ | templates save | none | ✓ | fib-levels |
| Long/Short Position | drawings, never orders | verified: no orders | ✓ | — | ✓ | persists | none | ✓ | position-tools |
| multi-chart | independent panes | 1–4 verified | ✓ 60fps | — | ✓ | layout persists | none | ✓ | multi-chart |
| order entry | server-authoritative | verified live | ✗ not timed | **rapid input not yet tested** | ✓ | server state | none | ✓ | terminal, acceptance |
| positions / working orders | reconcile with server | verified | ✗ | — | ✓ | server | none | ✓ | execution-interaction |
| SL / TP | dollars only at rest | `−$1,860.00` / `+$1,870.00` | ✗ | — | ✓ | server | none | ✓ | drag-protect |
| P&L | reconciles everywhere | 8 instruments to the cent | ✗ | — | ✓ | server | none | ✓ | pnl-reconciliation |
| account statistics | authoritative | BAL = start + RP&L exactly | ✗ | — | ✓ | server | none | ✓ | acceptance |
| bottom panel | resize, collapse, persist | 370px → 370px across reload | ✓ | — | ✓ | ✓ | none | ✓ | responsive |
| Journal | calendar first | opens on Calendar | ✗ **not stress-tested** | — | ✓ | ✓ | none | ✓ | journal-calendar |
| Settings | live, sectioned | works | ✓ | — | ✓ | ✓ | none | ✓ | tools |
| Appearance / themes | live preview | **no presets, native colour inputs !** | — | — | ~ | ✓ | none | ~ | ✗ |
| navigation (rail) | always reachable | 44px, 5 destinations | ✓ | — | ✓ | — | none | ✓ | responsive |
| reload | everything returns | drawings 1→1, studies 11→11 | ✓ | **repeat reloads not yet tested** | ✓ | ✓ | none | ✓ | responsive |
| reconnect | recovers cleanly | **not yet tested** | — | — | — | — | — | ✗ | ✗ |
| responsive layouts | nothing spills | 7 widths to 900px | ✓ | — | ✓ | ✓ | none | ✓ | responsive |

---

## What this milestone will do, in order

The inventory decides the order — not the brief's section numbering, and not
what would be most fun to build.

**1. Things already proven broken.** The indicator legend's 17px targets (done),
resizable indicator panes (done), and the rows jumping when a study is removed.

The drawing hover cursor was on this list and should not have been: the first
reading looked at `.draw-canvas` while the code sets the cursor on the
container. Hovering a body gives `move` and a selected handle gives
`nwse-resize` or `nesw-resize`. **The finding was wrong and is withdrawn.**

**2. The indicator scaling cost** — done, and it was not what the first profile
said. It is the live market: every tick recomputed every study over the whole
history. Fixed by caching what cannot have changed and by giving each indicator
a declared tail window, both measured above.

**3. The untested columns above.** Race conditions, rapid input, reconnect,
repeat reloads, Journal at scale, execution UI under abuse, memory over hours.
Every ✗ in that table is a place a product can embarrass itself and nobody has
looked.

**4. Then, and only then, appearance.** The account bar sizing, the declutter
pass, theme presets and the customisation experience. These are the most
visible items in the brief and the least likely to be where the product is
actually weak, which is exactly why they come last.

## Known issues carried in from before

* The vendor feed is 602 seconds delayed at p50 and cannot support sub-minute
  timeframes. Not this milestone's to fix, and explicitly out of scope.
* Bollinger bands are the only multi-line indicator with per-line controls.
* Fans, arcs and time zones are not built; the Fibonacci family is one tool.
