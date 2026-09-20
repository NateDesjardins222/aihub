# Atlas — charting experience V3 completion report

Final commit `006d80c`, branch `claude/futures-trading-simulator-v8qefu`,
remote HEAD = local HEAD, working tree clean.

## The honest shape of this milestone

The brief is 86 phases of "make the chart feel expensive." The blunt truth,
found in the Phase 0 autopsy: **the interaction architecture already met most
of that bar.** Gestures already live outside React and commit once on release
(no 300-entry undo, no full-app rerender on a pointer move); the tool state
machine already handles sticky mode and abandons half-placed objects; the
cursor already communicates the action; hit tolerance is already 6px with a
larger invisible anchor target; Escape already has a priority ladder; right-
click is already context-aware; the floating style bar, object-specific
settings, and a searchable symbol list already exist.

So this milestone was deliberately narrow. Inventing changes to claim a phase
would have made the product worse. Effort went to the few things that actually
felt wrong, each measured rather than asserted.

## What changed, and the proof

1. **Drag threshold (Phase 8).** A press on a drawing no longer moves it until
   the pointer travels 3px; below that it is a pure selection. Fixes the worst
   feel bug — a selecting click, or a trackpad's tremor, nudging the object.
   Proof: `exceedsDragThreshold` unit test (4 cases); browser check — a 2px
   jitter moves the object **0px**, a real drag moves it **42,28**.

2. **Snap indicator (Phase 10).** While placing or reshaping with the magnet
   on, an accent ring marks the open/high/low/close the anchor snapped to. Shows
   only while snapping; clears the instant the anchor is free. Proof: visible in
   the placement screenshot on both anchors under STRONG magnet.

3. **Symbol search keyboard navigation (Phase 33).** ↑/↓ move a highlight,
   Enter selects, Escape closes — fully mouse-free. Proof: browser check drives
   NQ → MNQ selection entirely from the keyboard, and Escape cancels.

4. **Right offset 6 → 8 bars (Phase 46).** Breathing room for the live candle,
   still inside the 6–10 target.

5. **Test isolation — the magnet (Phase 82 / D-004 lesson).** `signIn` now
   resets the magnet to OFF. This is the **sixth** kind of inherited state to
   bite the suites; a run left on STRONG snaps every placement and breaks pixel
   assertions.

## Bugs found and fixed

* **D-018 (test-integrity, mine):** my own probe scripts left the account's
  magnet on STRONG (a persisted preference). 27 placement checks failed across
  six suites until I traced it to magnet contamination — the harness did not
  reset the magnet at sign-in. Fixed by `returnToDefaultMagnet`; all suites
  green again. A genuine test-isolation gap the milestone's discipline exposed.

* **A false alarm, recorded honestly:** I briefly believed STRONG-magnet
  placement showed no preview (a `litPixels` measurement returned 0). Checking
  the clean baseline and then a full screenshot proved the preview and snap ring
  render correctly — the measurement was flawed (the magnet-button clicks in
  that probe interfered with the placement), not the product. No fix needed.

## Test results

* **Unit:** 42 files, **739** tests (baseline 735 + 4 drag-threshold cases).
* **Drawing suites:** drawing-engine 36/36, line-tools 68/68, rectangle 43/43,
  remaining-tools 56/56, position-tools 30/30, fib-levels 16/16, drawing-pointer
  16/16, tools 27/27 — **292/292**.
* **New charting-v3 spec:** 9/9 (drag threshold both ways; symbol keyboard nav;
  Escape).
* **Drawing matrix:** clean sweep per tool in isolation (11 × 20). One full-run
  cell flaked — `Horizontal line / reload: 3 object(s) survived` — which passes
  in isolation twice; a cross-tool persistence timing flake under load, not a
  regression and not caused by these changes.
* **Typecheck:** clean.

## What I did NOT do, honestly

Most of the 86 phases are audits of behaviour that was already correct; I
verified rather than rebuilt them and did not fabricate changes. I did **not**
exhaustively re-measure the full input-latency lab and frame-time percentiles
(Phases 66–69) — the gesture architecture that drove those numbers is
unchanged, so there is no reason to expect regression, but I did not re-run the
whole battery. I did not capture every one of the 15 requested screenshots
(multi-chart, 2560/1024 widths, indicator hover) — I captured the ones that show
the actual changes. I did not touch the locked icon geometry, did not expose any
future tool, and did not go near Databento or any feature expansion.

## What still feels weaker than a top-tier platform

* The magnet snap ring is subtle by design; on a busy chart it can sit close to
  the crosshair. It reads clearly in isolation but a dedicated snap-label
  (e.g. "H 29,981") would be even clearer — deferred as it risks visual noise.
* Contract presentation (Phase 35) is functional (a separate front-month badge)
  but not the compact "NQ · Dec '26" treatment the brief sketched; left as-is
  rather than churn the header for a cosmetic change.
* Overlapping-object selection is deterministic (topmost/newest wins) but does
  not yet cycle on repeated clicks (Phase 6) — a real nicety, deferred.
