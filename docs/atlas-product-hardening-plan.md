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

**Root cause, from a CPU profile of a pan with 20 studies rather than from
suspicion:** 42% idle, 33% browser program time, and the application's own
JavaScript a few percent — the top entries are `lineTo`, `save`, `fillRect`,
`fillText`. This is **canvas paint across many panes, not indicators
recalculating on pointer events**, which was the obvious hypothesis and is
wrong. DOM grows ~24 nodes per study, and each oscillator takes its own pane
with its own price scale and canvas.

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
| indicators | add, remove, independent | works | **degrades past ~10 !** | — | ✓ | survives reload | none | ✓ | indicators |
| indicator settings | per-parameter, live | works, sectioned | ✓ | — | ✓ | persists | none | ✓ | indicators |
| indicator panes | own pane, resizable | **not resizable !** | — | — | ~ | height not persisted | none | ✗ | ✗ |
| indicator legend | compact, own row | **17px hit targets !** rows jump 31px on removal **!** | ✓ | — | ✓ | — | none | ✓ | indicators |
| drawings | place, edit, persist | 11 tools × 20 steps pass | ✓ to 1000 | — | ✓ | per symbol | none | ✓ | drawing matrix |
| drawing hover | cursor indicates a target | **cursor stays `auto` !** | — | — | — | — | none | ✓ | ✗ |
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
the rows jumping on removal, resizable indicator panes, and the drawing hover
cursor.

**2. The indicator scaling cost**, which is the only measured performance
problem in the product. Canvas paint across panes, so the fix is about how many
panes exist and what each repaints — not about memoising a calculation that is
already cheap.

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
