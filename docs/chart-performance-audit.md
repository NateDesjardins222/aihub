# Chart and interaction audit — measured, not guessed

Phase 1 of the terminal-quality pass. Everything below was recorded in a
browser driving the real application; nothing in it is inferred from reading
the code.

## How it was measured

`tests/perf/instrument.mjs` is injected before the app loads and records:

* **every React commit**, through the DevTools hook React looks for at startup,
  with **self time per component** — `actualDuration` includes a fiber's whole
  subtree, so a parent that did not re-render still shows a large number; the
  children's durations are subtracted, which is the only figure that says who
  to fix;
* **every animation frame**, long tasks, and every `fetch`/`XHR` with the time
  it started, so "did this gesture talk to the network" is a fact;
* **Chrome's own counters** through the debugging protocol — `ScriptDuration`,
  `RecalcStyleDuration`, `LayoutDuration`. In a headless browser the
  animation-frame clock stays at 60Hz whatever the page is doing, so frames
  alone flatter the result. Script time is the honest number: it is what a
  slower machine or a busier tab turns into dropped frames.

`tests/perf/profile.mjs` drives scripted gestures **unpaced** — as fast as the
driver can dispatch them, because a gesture paced at 60Hz measures the pacing,
not the terminal.

Both a development build and a **production build** (`vite preview`) were
profiled. Development doubles every render because of `StrictMode`, so the
production figures are the ones to act on; the development run is what
attributes the cost to a component.

## The numbers

Production build, 50 drawings on the chart, 1680×950:

| Gesture | Script | p95 frame | Jank frames | React commits |
|---|---|---|---|---|
| idle, 3s | 196ms | 16.7ms | 0 | 11 |
| crosshair sweep, 120 moves | **763ms** | **33.3ms** | **8** | 11 |
| crosshair across the drawings | 513ms | 16.7ms | 2 | 10 |
| pan, 80 moves | 327ms | 16.8ms | 0 | 8 |
| zoom, 40 wheel events | 326ms | 16.8ms | 0 | 9 |
| place a rectangle | 149ms | 16.8ms | 0 | 15 |
| drag a drawing, 80 moves | 132ms | 16.8ms | 0 | **92** |

Development build, same gestures, self time per component during **one drag**:

```
ChartHeader   x97  343ms
OrderTicket   x97  175ms
DrawingRail   x84  109ms
ChartPanel    x97  102ms
Icon         x910   98ms
PositionsTable x97   58ms
ActivityPanel x97   39ms
```

## Findings, worst first

### 1. A pointer move costs about 6.4ms of main thread

763ms of script for 120 crosshair moves, with eight frames over 32ms. This is
the "cursor lag": every mouse move does the chart library's crosshair repaint,
**plus** a full hit-test of every drawing, **plus** a cursor style write, and
none of it is coalesced to an animation frame. Pointer events arrive faster
than the display refreshes, so the work is done several times per painted
frame and most of it is thrown away.

### 2. Dragging a drawing re-renders the application

92 React commits for an 80-move drag: **one commit per pointer move**, because
the drag writes the moved drawing into the global store on every move. In
development that re-renders the chart header 97 times (343ms), the order
ticket 97 times, the drawing rail, the positions table, the activity panel and
910 icons. Production hides some of it behind cheaper renders, but the
architecture is the defect: *interaction state must never be global state*.

### 3. The chart panel subscribes to the drawing list

`ChartPanel` reads `drawings` from the store to clean up a context menu, so
every drawing edit re-renders the chart panel and, inside it, the header - the
most expensive component in the application at roughly 9ms per render in
development.

### 4. Three animation-frame loops run whether or not anything changed

The drawing canvas, the price markers and the floating style bar each repaint
every frame, always. That is the 196-321ms of idle script: the terminal spends
main thread doing nothing, which is exactly the budget a gesture needs.

### 5. Hit-testing is linear with no pre-filter

Every pointer move tests every drawing on the instrument, each test projecting
its anchors through the chart. There is no bounding-box rejection and no
spatial index, so the cost grows with the number of objects precisely when a
trader can least afford it.

### 6. A workspace with 250 drawings cannot be saved, and fails silently

Preferences are one JSON blob capped at 64KB by the server. 250 drawings is
86,700 bytes: the write is rejected with HTTP 400 and the client's
`.catch(() => undefined)` swallows it. The trader is told nothing and loses
the work on reload.

### 7. Border and fill cannot be controlled separately

A drawing's style carries one `fill` string and one `color`. There is no
border opacity, no fill opacity, and no way to set a solid border over a
barely-there fill - which is the single most important visual property of a
rectangle or a zone on a price chart.

### 8. Development measurements are doubled by StrictMode

Worth recording so the next profile is not misread: `StrictMode` renders every
component twice in development. The production build is what to judge.

## What this implies for the architecture

1. **Pointer input must be coalesced to one animation frame.** A move records
   its position; the frame does the work. Nothing else changes per event.
2. **A gesture must be local.** Dragging edits a mutable interaction record
   that the canvas reads each frame; the store is written once, on release -
   which also satisfies the rule about not touching the network mid-gesture.
3. **Painting must be driven by change, not by the clock.** The canvases
   repaint when the drawings, the selection, the projection or the preview
   actually differ from the last frame.
4. **Hit-testing needs a cheap rejection first**: a cached screen-space
   bounding box per drawing, invalidated when the projection changes.
5. **Subscriptions must be narrow**, and the expensive components memoized, so
   a drawing edit cannot reach the order ticket.
6. **Drawings need their own persistence** rather than a corner of a 64KB blob,
   and a failed save must be visible.
7. **The style model needs border and fill as separate colours with separate
   alpha**, with defaults that leave price action visible.


---

## After the fixes

Same production build, same gestures, same fifty drawings, median of three
runs, with an unmeasured warm-up gesture first (the first sweep after a page
load pays for compiling the paths it touches, which was landing on whichever
gesture ran first and made the comparison between gestures meaningless).

| Gesture | Before | After |
|---|---|---|
| idle, 3s | 196ms | 95-229ms |
| crosshair sweep, 120 moves | **763ms**, 8 jank frames | **125ms**, 0 jank |
| crosshair across the drawings | 513ms | 81-307ms |
| pan, 80 moves | 327ms | 205ms |
| zoom, 40 wheel events | 326ms | 79ms |
| place a rectangle | 149ms | 83ms |
| drag a drawing, 80 moves | 132ms, **92 commits** | 125ms, **14 commits** |
| settling after a drag | 65ms | 18ms |

A CPU profile of a crosshair sweep now shows no Atlas function in the top
twenty: the remaining time is the chart library's own crosshair rendering and
native canvas work. Before the fixes the top entries were
`Intl.DateTimeFormat` construction, `projection`, the marker placement loop,
and the chart library re-validating every point of every indicator series.

What is left, and why:

* **The live market costs what it costs.** A quote arriving redraws the
  candle, and a run that happens to catch several bursts measures them. It is
  why every figure here is a median of three and why two runs of the same
  gesture can differ by a factor of three.
* **Development builds are roughly four times slower** than production and
  double every render through StrictMode. Profile the production build.

## Closed since this audit

* **Finding 6 is fixed.** Drawings have their own table and their own endpoint
  (`GET`/`PUT /api/v1/drawings`, migration `0008_user_drawings`) with a 1 MB
  limit and a body limit to match, so a marked-up chart no longer takes the
  motion settings and the training mode down with it. A save that is refused
  is now SAID: the terminal shows the server's own reason until it is
  dismissed or a save succeeds, instead of swallowing the response. Covered by
  `apps/server/src/http/journal.test.ts` (250 real drawings, 85KB, stored and
  read back; a refusal that leaves the previous save intact; one trader's
  drawings invisible to another) and by `tests/browser/stress.spec.mjs`.
