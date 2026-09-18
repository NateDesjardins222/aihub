# Atlas — product hardening: completion report

The brief for this milestone was unusual, and it decides what this report is:

> *"This is NOT a feature-expansion milestone. Do NOT try to impress me by
> adding a bunch of new features. QUALITY IS THE FEATURE. TEST IT. BREAK IT.
> MEASURE IT. FIX IT. SIMPLIFY IT. POLISH IT. STRESS IT. USE IT. REPEAT."*

So every claim below is a number produced by driving the real application, and
where a first measurement was **wrong** the correction is written down rather
than quietly replaced. Three words are used and are not interchangeable:

* **IMPLEMENTED** — the code is there.
* **AUTOMATED TESTED** — a check drives it and passes.
* **MANUALLY VERIFIED** — it was used by hand and what was seen is written down.

The measurements themselves live in `docs/atlas-product-hardening-plan.md`,
which was written before any UI was changed, exactly as the brief asked.

---

## 1. What was asked, and what was done

| the brief | outcome |
| --- | --- |
| P0 plan document before touching the UI | `docs/atlas-product-hardening-plan.md`, 33-workflow inventory, written from measurements |
| P0 extreme speed audit | 19 scenarios, p50/p95/p99/worst, baseline stored |
| P0 find every frame drop | one found, root-caused, fixed, re-measured |
| P0 frame-time distribution, not average FPS | the instrument reports distributions and counts over 20/33/50ms |
| P0 drawing stress to 1000 | no degradation, verified by painted pixels |
| P0 indicator stress to 30 | the one real defect of the milestone; fixed |
| P0 multi-chart stress | linear and cheap |
| P0 endurance / memory | 18 minutes, 236 cycles, no leak |
| P0 rapid input abuse | 19 checks, all passing |
| P0 race conditions | covered by the same suite |
| P0 zero console errors | held as a check in every suite |
| P1 chart, drawing and indicator feel | measured; indicator panes fixed properly |
| P1 resizable indicator panes | implemented, persisted, 14 checks |
| P1 account panel a bit bigger | 36px → 42px bar, 15px tabular figures |
| P1 declutter, visual system | one real finding; the rest deliberately left alone |
| P1 customisation, themes, colour | five themes with live preview, a colour control of our own |
| P2 micro-interactions, menus, panels | audited from computed style, 25 checks |
| P2 responsive 2560 → 900, tablet | extended both ends; two defects found and fixed |
| P2 journal at scale | 1,435 trades; found a truncation the UI was hiding |
| P2 execution UX stress | 13 checks against the engine's own state |
| P2 failure and recovery, reloads | 14 checks |
| P3 performance regression harness | `tools/perf-check.mjs`, proved both ways |
| P3 visual regression harness | `tests/browser/visual.spec.mjs`, 22 checks |
| P3 150+ manual interaction checks | **159**, each with a readable consequence |

---

## 2. The instrument, and two corrections to it

Nothing could be trusted until the measuring instrument was.
`tools/perf/probe.mjs` records every `requestAnimationFrame` delta and measures
input latency three ways, because each way lies on its own: the Event Timing
API rounds `duration` to 8ms in Chromium, and an `event.timeStamp` → frame
measurement stops at the callback rather than at the pixels.

Two flaws in my own first draft, corrected before anything was reported:

1. **"Frames over 16.7ms"** counted floating-point noise on a 60Hz display — it
   reported 98 of 98 frames during a demonstrably smooth pan. The thresholds
   are now 20ms (the first honest sign of a missed frame), 33ms and 50ms.
2. **"Startup 16,614ms"** was not the application: it was the shared sign-in
   helper sleeping on purpose. Measured by polling for milestones, startup is
   **~420ms** to a live price.

---

## 3. Product-quality audit

`docs/atlas-product-hardening-plan.md` holds a 33-row inventory: every
workflow, with columns for expected behaviour, what was actually measured,
performance, failure modes, responsive behaviour, persistence, errors, and
whether it is manually or automatically covered. The ordering of this milestone
came out of that table rather than out of the brief's section numbers — proven
defects first, appearance last.

---

## 4. Speed audit

19 scenarios, each driving real pointer, wheel and keyboard input.

| | p50 | p95 | worst | frames >50ms | long tasks |
| --- | --- | --- | --- | --- | --- |
| crosshair sweep | 16.7ms | 16.8ms | 17ms | 0 | 0 |
| chart pan | 16.7ms | 16.7ms | 17ms | 0 | 0 |
| wheel zoom | 16.7ms | 16.7ms | 17ms | 0 | 0 |
| price axis drag | 16.7ms | 16.7ms | 17ms | 0 | 0 |
| time axis drag | 16.7ms | 16.7ms | 17ms | 0 | 0 |
| drawing place / body drag / anchor drag | 16.7ms | 16.8ms | 17ms | 0 | 0 |
| symbol switch | 16.7ms | 16.7ms | 17ms | 0 | 0 |
| timeframe switch | 16.7ms | 16.7ms | 17ms | 0 | 0 |
| indicator add / remove | 16.7ms | 16.8ms | 17ms | 0 | 0 |
| settings open, context menu | 16.7ms | 16.7ms | 17ms | 0 | 0 |
| panel resizes | 16.7ms | 33.3ms | 33ms | 0 | 0 |
| window resize, layout 1→4→1 | 16.7ms | 16.8ms | 17–33ms | 0 | 0 |

Startup, by milestone: navigation → shell 43ms, credentials → terminal 217ms,
canvas 23ms, candles painted 53ms, a real price on the status line 83ms —
**~420ms in total**.

**AUTOMATED TESTED.** `tools/perf-baseline.mjs`, stored in
`tests/browser/baselines/performance.json`.

---

## 5. Frame drops: profile → identify → fix → re-measure

One real frame-drop source was found in the whole product, and the first
diagnosis of it was **wrong**. That is worth reporting in full, because the
brief asked for the method rather than for the verdict.

**The symptom.** Twenty studies on a chart dropped a fifth of their frames in
one run and none in the next, on a machine whose own arithmetic yardstick — a
fixed 20-million-iteration loop, timed inside the page — said it was equally
free both times (36–42ms in every round).

**The wrong answer.** A CPU profile of a pan with 20 studies read 42% idle, 33%
browser program time, and `lineTo`, `save`, `fillRect`, `fillText` on top. That
was read as canvas paint across many panes.

**The experiment that settled it.** The configurations were interleaved instead
of laddered, and the variables separated one at a time:

| what was varied | result |
| --- | --- |
| 20 oscillators, each in its own pane | 60fps, 0 frames over 33ms — not the panes |
| 2,587 bars on screen, no studies | 60fps, 0 frames over 33ms — not the bars |
| 20 studies, **0 ticks during the pan** | p95 16.7ms, **0 frames over 33ms** |
| 20 studies, **19–23 ticks during the pan** | p95 33–50ms, **21–24 frames over 33ms** |

**The real cause.** Every tick that moved the bar in progress recomputed every
study over every bar the chart held — about **31ms per tick** with 20 studies,
landing inside a frame. A pan during a moving market dropped frames; the
identical pan during a still one did not.

**The fix, in two halves.**

* Nothing is recomputed whose answer cannot have changed: results are cached
  against a bar revision, and an unchanged series is no longer handed back to
  the renderer to re-validate point by point. **Worst single pass at 20
  studies: 62.7ms → 8.7ms.**
* A tick computes only as far back as its own answer reaches. Each indicator
  declares that distance; VWAP declares "all of it", because its anchor is the
  session. **Arithmetic per tick over 1,500 bars: 4.12ms → 1.18ms at 20
  studies, 5.43ms → 1.71ms at 30.**

**What could not be measured, said plainly.** The end-to-end A/B — the same pan
with and without the fix, on a chart holding 1,500 bars while the market ticks
— needs a moving market, and the feed was quiet for most of this work. A replay
was tried as a substitute and **was not one**: a replay opens on nine bars and
builds up, so a declared window of 620 is longer than the history and the new
path never runs. Those runs are reported as a failed experiment, not as
evidence.

What IS tested end to end is correctness, in `live-indicators.spec.mjs`, and it
earned its place immediately: it caught this very change leaving the crosshair
reading `—` over every bar printed since the last full redraw.

**IMPLEMENTED. AUTOMATED TESTED** (`tail-window.test.ts`, 17 cases to 1e-9
relative; `live-indicators.spec.mjs`, 9 checks). **MANUALLY VERIFIED.**

---

## 6. Frame-time distribution, not average FPS

The brief: *"A terminal averaging 60 FPS but freezing every few seconds is NOT
smooth."* Every performance number in this milestone is a distribution with
counts of frames over 20ms, 33ms and 50ms beside it, and the regression gate in
part 27 fails on the counts rather than on the average.

---

## 7. Drawing stress — 0 to 1,000 objects

| objects | pan fps | pan p95/worst | crosshair | zoom | long tasks | heap |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 60 | 16.8 / 17 | 60 | 60 | 0 | 13.6MB |
| 100 | 60 | 16.7 / 17 | 59 | 60 | 0 | 22.3MB |
| 250 | 60 | 16.8 / 17 | 59 | 59 | 0 | 14.4MB |
| 500 | 60 | 16.7 / 17 | 59 | 59 | 0 | 11.0MB |
| 750 | 60 | 16.7 / 17 | 59 | 59 | 0 | 14.4MB |
| **1000** | **60** | **16.7 / 17** | **58** | **60** | **0** | 15.6MB |

**This was too clean to report unverified.** The brief warns against benchmarks
that pass because the work is not happening, so the painted pixels were
counted: **0 at none, 32,914 at a hundred, 108,911 at a thousand.** Nothing was
throttled and no interaction was disabled. DOM stays at 313 nodes because the
objects are painted on a canvas rather than built as elements.

---

## 8. Indicator stress — 1 to 30, and combinations

The ladder is in the plan document. Its headline numbers (pan p95 doubling
between 10 and 20 studies, a 133ms worst frame at 30) are **partly an artefact
of when the market was moving**, which is exactly what part 5 unpicks. The
honest summary after the fix: study count costs arithmetic per tick, that
arithmetic is now 3.5× cheaper and no longer repeated for studies whose answer
has not changed, and 20 studies with no ticks are indistinguishable from none.

---

## 9. Multi-chart stress

| layout | pan fps | p95/worst | long tasks | heap | DOM | canvases |
| --- | --- | --- | --- | --- | --- | --- |
| 1 chart | 60 | 16.8 / 17 | 0 | 11.2MB | 290 | 8 |
| 2 charts | 60 | 16.7 / 17 | 0 | 11.3MB | 387 | 16 |
| 3 charts | 60 | 16.7 / 17 | 0 | 18.6MB | 480 | 24 |
| 4 charts | 60 | 16.8 / 17 | 0 | 20.8MB | 573 | 32 |
| 4 charts + 250 drawings | 60 | 16.7 / 17 | 0 | 32.1MB | 662 | — |

93 DOM nodes and 8 canvases per chart. **No action needed.**

---

## 10. Endurance and memory

18 minutes and **236 cycles** of pan, zoom, timeframe change, symbol change,
indicator add/remove and a trip through the journal - one heap, DOM and canvas
reading per cycle.

| | heap min | heap mean | heap max | DOM | canvases |
| --- | --- | --- | --- | --- | --- |
| first half | 9.6MB | 17.8MB | 37.5MB | 288–290 | 8 |
| second half | 11.0MB | 21.0MB | 38.0MB | 288–290 | 8 |

The heap saw-tooths between collections, so the number that matters for a leak
is the floor: it moved 1.4MB in eighteen minutes with no trend. DOM nodes and
canvases are flat. **No leak, zero page errors.**

**Said plainly:** the brief's "6-hour trader" test was run as eighteen minutes
of continuous use, not six hours. The shape of the curve is flat and the DOM
and canvas counts do not move, which is what a leak would show up in first, but
six hours was not observed and is not claimed.

---

## 11. Rapid input abuse

`tests/browser/abuse.spec.mjs`, 19 checks: six symbol changes in under a
second, seven timeframe clicks, five layout switches, indicator add/remove
hammering, drawing create/undo/redo hammering, six settings cycles, a timeframe
click landing inside a symbol load, six fast panel drags, four fast account
switches.

The questions are about STATE, not about whether a click landed: the chart and
the order ticket agree on the instrument, exactly one interval is active, what
is painted agrees with what is stored, and nothing is stranded on the screen.
**19/19, no console errors, chart alive at the end.**

---

## 12. Race conditions

Covered by the same suite — a timeframe click during a symbol load, a close and
an entry in the same second, three Reverses faster than they can fill — and by
`execution-stress.spec.mjs`, which compares the terminal against the engine
after each one. **No divergence found.**

---

## 13. Console errors

Every suite ends on the same check, and the standard is zero. The one place
errors are tolerated is the deliberate refusal window in `execution-stress`,
where an order placed before a replay has a price is correctly rejected with a
422; those are excluded by a recorded noise floor rather than by widening the
check.

---

## 14. Chart feel

p50 16.7ms on every gesture, with the pan responding in 8.3ms at p95 and the
crosshair in 15.0ms. The one remaining signal is the **wheel zoom's response
tail** (31.7ms at p95), which was investigated rather than guessed at:

* the handler's own cost is 0.00–0.20ms — there is no application work to remove;
* applying the zoom as a bar-spacing change instead of a visible-range change was **no faster**;
* **coalescing wheel events to one write per frame made it three times worse** (p50 20.8 → 63.2ms), because deferring to a frame *adds* a frame. Measured, reverted, and written down so nobody tries it again.

**Conclusion: the tail belongs to the renderer's scheduling, not to our code.**

---

## 15. Drawing feel

The drawing suites pass unchanged after the colour control was replaced under
them: `drawing-pointer` 16/16, `drawing-engine` 36/36, `line-tools` 68/68,
`rectangle` 43/43, `remaining-tools` 56/56, `fib-levels` 16/16,
`position-tools` 30/30.

The 11-tool × 20-step matrix (`tools/drawing-matrix.mjs`) was re-run for this
report: select, place, reselect, drag the body, drag every anchor, edit, style,
duplicate, copy/paste, undo, redo, lock, unlock, hide/show, zoom, pan, change
the interval, **change the instrument**, reload, delete — for Trend line,
Horizontal line, Vertical line, Ray, Extended line, Rectangle, Fib
retracement, Measure, Text, Long position and Short position.

**All 220 cells pass.**

One finding from the previous milestone is **withdrawn as false**: "hovering a
drawing does not change the cursor" was read off `.draw-canvas` while the code
sets the cursor on the container. A body gives `move`, a selected handle gives
`nwse-resize` or `nesw-resize`.

---

## 16. Indicator quality

Five studies added, hidden, re-shown, re-configured, duplicated and removed in
the interaction pass, each with a readable consequence. Two defects fixed:

* **The legend's hit targets were 17px** and are now 22px, with the ink
  unchanged — the padding is the target.
* **Removing one study could remove the next one.** Four moving averages have
  rows of identical width, so their remove buttons line up exactly; the list
  restacking under a pointer that has not moved put the next one's button
  precisely where the last one was. Measured both ways: unguarded, two clicks
  in the same place remove two studies; guarded, they remove one. The list
  still restacks immediately — it has to say what is on the chart — but the
  controls wait until the pointer moves.

---

## 17. Resizable indicator panes

Called out in the brief as explicitly incomplete. The renderer already drew a
nine-pixel grip with a row-resize cursor; what was missing was everything
around the drag, and the everything is what made it feel unfinished: nobody was
told when a drag ended, so the split was never saved; there was no way back to
automatic; the grip said nothing about what it was; and adding another study
re-balanced the panes from scratch.

Now: the split is held, adapted when a pane appears or disappears (the price
pane keeps its share, the panes below divide what is left), reported, saved
beside the instrument and the interval, applied before the first paint, and
restored by a double-click.

One trap found by measuring rather than reasoning: a chart passes through a
single pane twice — at startup before the workspace arrives, and when the last
study is removed — and adapting a three-pane split to one pane produced a
one-element array whose saving overwrote the trader's arrangement with their
own reload.

**IMPLEMENTED. AUTOMATED TESTED** (`pane-resize.spec.mjs`, 14 checks: the grip
exists and is 9px, a drag changes the split 545/182 → 395/332, a second
oscillator does not undo it, it survives a reload exactly, a double-click
restores 545/91/90, and removing every study gives the whole 728px back).
**MANUALLY VERIFIED.**

---

## 18. The account panel and the P&L boxes

The brief: *"JUST A BIT BIGGER and easier to read… Do not make them huge. Do
not sacrifice significant chart space."*

The bar went 36px → 42px; the boxes 26px → 30px; the labels 10px → 11px; the
figures 13px → 15px with tabular figures locked on so a moving P&L does not
shuffle its own digits. The two P&L boxes carry a heavier weight than balance
and drawdown, because they are the two a trader looks at fifty times an hour.
Measured after: bar 42px, chart 756px — six pixels of a 950px window.

Only the four metrics are there. No flashing, no glow, no gaming effects.

---

## 19. Declutter and the visual system

One real finding on the trading surface: with the session shut, the status line
read **"MARKET CLOSED … closes 0:26"** — two statements a foot apart, one of
them false. The countdown now stands down when the feed says the market is
closed, except in a replay, which closes bars on its own clock. Kept as an
invariant so it holds whatever the session is doing when the suite runs.

The rest of what the pass looked at — duplicated status between the account bar
and the chart, the density of the price scale, the tool rail — was **left
alone**, because "I would have laid it out differently" is not a defect and
churning a working terminal on taste is how quality milestones go wrong.

The visual system was already disciplined and the audit says so with numbers:
156 animated properties, every one of them between 90ms and 110ms because
almost all of them come from a single duration token and a single easing token,
and only about forty hard-coded colours outside the token file — which is why a
light theme was possible at all.

---

## 20. Customisation: themes, colour, live preview

**Five themes**, not fifty: Atlas Dark, Midnight, Graphite, OLED, Clean Light. A
theme carries both halves — the canvas appearance and the design tokens the
panels are built from — because a chart that does not match its own window is
worse than one that was never themed.

**The preview is the real thing.** Hovering a card applies it to the real chart,
the real panels and the real P&L boxes; moving away puts back exactly what was
there, captured on the way in rather than read on the way out. Saving is
suspended for the duration, because a hover is not a decision.

**Clean Light** meant the hard-coded whites had to go; they are now two tokens.
The suite measures contrast rather than trusting the palette: **17.6:1** on the
P&L figures, **7.5:1** on the labels and the symbol.

**The colour control is ours.** The native `<input type="color">` was the front
door and is the wrong one: it looks like a different application, it cannot
express the `rgba()` half these settings hold, and it opens a modal window over
the chart you are judging the colour against. It is now one button among the
swatches. In its place: forty curated colours legible on both a dark and a
light canvas, an opacity slider, the hex to type when it matters, and the
colours just used. It renders through a portal because it lives inside dialogs
that clip, and it takes Escape before the dialog does.

**IMPLEMENTED. AUTOMATED TESTED** (`appearance.spec.mjs`, 19 checks).
**MANUALLY VERIFIED** — screenshots of every theme and of the picker.

---

## 21. Micro-interactions

Read from what the browser computed, not from what the stylesheets say: **156
animated properties, every one between 90ms and 110ms**, nothing over a quarter
of a second, nothing under 60ms, and **nothing with an infinite iteration
count**. No glow, no bounce, no confetti, no celebration.

---

## 22. Menus and dialogs

Five surfaces — symbol search, indicator catalogue, layout menu, settings
dialog, chart overflow — each opened, dismissed with Escape, opened again,
dismissed with a click outside, and then the page checked for popovers and
scrims left behind. The journal drawer answers Escape like everything else, and
closing a dialog leaves focus on a node that still exists.

**25 checks, all passing, no defect found** — which is itself worth recording:
the shared `Popover` is why every menu behaves alike.

---

## 23. The bottom panel

Dragged taller, collapsed to 22px, reopened at the height it had rather than at
a default, and the height survives a reload (370px → 370px). Five tabs open and
mark themselves active. **AUTOMATED TESTED** in `responsive` and in the
interaction pass.

---

## 24. Responsive stress and the tablet pass

**Widened at both ends.** 2560, 2304 and 2048 were added, where the failure is
not spilling but *stranding* — a chart that stops growing and leaves a band of
empty workspace. Nothing spills or overlaps anywhere from 2560 down to 900, and
the workspace is filled at every width.

**A tablet is not a narrow window.** Two defects found on a real touch context:

1. A finger cannot hover, and the indicator legend hid its controls until a row
   was hovered — so a study could be added on a touch screen and then neither
   configured nor removed. Where there is no pointer the controls are always
   there.
2. At 820px the top bar cut the DELAYED chip in half and wrapped the clock onto
   two lines, and the bar's height is the chart's height. Below 1000px the
   session cluster steps out entirely: half a word is worse than no word, and
   both the clock and the session state are on the chart's status line too.

**AUTOMATED TESTED** — `tablet.spec.mjs`, 15 checks, landscape and portrait;
`responsive.spec.mjs`, 50 checks.

---

## 25. The journal at scale

Eleven trades prove the calendar renders and nothing about a trader two years
in, so 1,435 trades across nine months were written straight into the database
(through the engine it would have measured the engine) and removed again in a
`finally`, because the suites share one account.

| | |
| --- | --- |
| journal opens on the calendar | 144ms |
| paging back nine months | median 166ms, worst 169ms |
| scrolling 1,435 rows | p50 17ms, **0 frames over 50ms** |
| narrowing to one day | 445ms |
| the overview over the whole history | 651ms |

**And a defect the scale exposed.** The list asked the server for 500 trades,
showed 500, and said nothing about the other 935 — a trader scrolling to the
bottom of what looked like their whole history was 500 trades into it. It now
asks for one more row than it shows, which is how it knows there is more
without the server counting anything, and says so: *"The most recent 500
trades. There are older ones."* with the way to see them beside it. Loading all
1,435 took 1,283ms.

---

## 26. Order and execution UX under stress

`execution-stress.spec.mjs`, 13 checks, every one comparing the terminal
against what the ENGINE says it holds — a disagreement is a failure however
reasonable the terminal's version looks.

Five BUY clicks in under a second: five contracts. A close and an entry in the
same second: one position. Three Reverses faster than they can fill: one
position in one instrument. A size changed six times then sent: seven on the
screen, seven in the engine. Flatten leaves nothing working. A reload agrees.

---

## 27. Failure, recovery, startup and reload

`recovery.spec.mjs`, 14 checks.

* **Ten reloads:** median 304ms to a chart with candles on it, worst 382ms, the
  workspace back all ten times, no drift in DOM nodes or canvases, nothing on
  the console.
* **Five reloads that interrupt each other:** comes up in 325ms with the
  workspace whole.
* **The bars endpoint dead:** the terminal still draws its chrome and says what
  went wrong rather than showing an empty chart, and comes back 852ms after the
  endpoint does.
* **The save endpoint dead:** a change raises the save warning rather than
  being swallowed — a silent failed save is only discovered on the next reload,
  when the work is already gone — and the warning clears when saving works
  again.

---

## 28. Regression harnesses, the interaction pass, and what still needs work

**The performance gate.** `tools/perf-check.mjs` measures, compares and exits
non-zero. Its rules are about the shape of the distribution rather than about a
number moving, because this milestone measured the same configuration at p95
33.4ms and 16.7ms an hour apart and a gate that fails on noise is a gate nobody
reads: p95 must worsen by both 8ms and half again; a scenario with no frame
over 50ms may not start having them; long tasks may not grow by more than
three. **Proved both ways** — a real run exits 0 and names what got faster; a
doctored run exits 1 naming all three reasons while ignoring a 2.7ms wobble.

**The visual harness.** `tests/browser/visual.spec.mjs` compares the structure
of each chart state — what is painted and where — against a stored baseline,
because exact-pixel comparison over live market data would be dishonest.

**The interaction pass.** `tests/browser/interaction-pass.mjs`, **159 checks**,
run twice. Every one performs a real click, drag, keystroke or wheel and reads
back something that would be different if it had not worked.

### The new-user pass, and the trader who is still here at hour six

The mechanical half is `first-run.spec.mjs`, 19 checks: every button on the
rail, the tool rail, the chart header, the ticket and the account bar has a
name; no raw enum reaches the screen; the entry buttons say how much they will
trade; the close buttons are unavailable when there is nothing to close; an
empty panel says it is empty and an unbuilt one names itself. All pass.

The half that cannot be automated is a judgement, and here it is, from using
the terminal to write the 159-check pass:

**What a newcomer gets right without being told.** The four figures on the
account bar read at a glance. BUY and SELL carry the size on the button, so
there is no question what is about to happen. The five destinations are on the
rail and stay there at every width. The indicator catalogue names studies in
words rather than initials. Escape closes everything.

**Three pieces of friction, found by hitting them myself.**

1. **The drawing tool list opens one category at a time.** Finding Ray means
   expanding a group first. I wrote a test that failed on this before I
   understood it, which is a fair proxy for a new trader hunting for a tool.
2. **A replay starts paused, and nothing says so where the eye is.** The
   account bar carries a REPLAY PAUSED pill, but the chart looks like a chart
   that has stopped updating. I assumed twice, in two different scripts, that a
   replay I had started was running.
3. **Keyboard shortcuts are only discoverable through a right-click.** Delete,
   Ctrl+C/V/D and Ctrl+Z all work and are listed in the object's context menu.
   Nothing lists them anywhere else.

None of the three is a defect and none was changed: they are design decisions
someone should make deliberately rather than have me churn on a hunch.

### Everything, run end to end

| suite | | suite | |
| --- | --- | --- | --- |
| terminal | 20/20 | abuse | 19/19 |
| responsive | 50/50 | live-indicators | 9/9 |
| chart-navigation | 32/32 | recovery | 14/14 |
| indicators | 37/37 | appearance | 26/26 |
| drawing-pointer | 16/16 | tablet | 15/15 |
| drawing-engine | 36/36 | visual | 22/22 |
| position-tools | 30/30 | polish | 25/25 |
| fib-levels | 16/16 | tools | 27/27 |
| multi-chart | 25/25 | replay-brackets | 12/12 |
| journal-calendar | 21/21 | layout | 8/8 |
| journal-scale | 16/16 | admin | 28/28 |
| rectangle | 43/43 | acceptance | 17/17 |
| line-tools | 68/68 | first-run | 19/19 |
| remaining-tools | 56/56 | **interaction-pass** | **159/159** |
| drag-protect | 29/29 | | |
| execution-interaction | 30/30 | | |
| execution-stress | 13/13 | | |
| stress | 62/62 | | |
| perf-panes | 11/11 | | |
| pane-resize | 14/14 | | |

**1,025 browser checks and 700 unit tests, all passing.**

The full run came back three checks down out of about eight hundred, and
**none of the three was the product** — each is written up in the commit that
fixed it, because a test that asks the wrong question is worth exactly as much
as a bug:

* `live-indicators` asked a replay for 45 bars and got 44; what matters is that
  the history exceeds the 22-bar window, which 40 says with margin.
* `appearance` expected six scale switches to survive a reload independently.
  They cannot: a price scale is logarithmic or percentage and not both.
* `acceptance` treated an order refusal with the market shut as an honest
  outcome and then failed on the 422 that same refusal wrote to the console.

### What still needs work — nothing here is hidden

1. **The vendor feed is 602 seconds delayed at p50** and cannot support
   sub-minute timeframes. Out of scope for this milestone by instruction, and
   still the single biggest quality problem in the product.
2. **The wheel-zoom response tail** (31.7ms p95) belongs to the renderer's
   scheduling. The one optimisation available made it three times worse.
3. **The end-to-end A/B of the tick fix was never run under a live moving
   market.** The component measurements are solid; the whole-system one waits
   for a busy session.
4. **Endurance was 18 minutes, not six hours.**
5. **Bollinger is still the only multi-line indicator with per-line controls**,
   and fans, arcs and time zones are not built.
6. **The Quotes tab is not built** — it names itself and the milestone that
   delivers it, which is the honest behaviour, but it is empty.
7. **A light theme has only been checked for contrast and layout**, not lived
   in. If something looks wrong in Clean Light it will be a detail nobody has
   looked at yet.
8. **The indicator legend still restacks when a study is removed.** The
   accidental second removal is fixed; the movement itself is inherent to a
   list and was left alone.
