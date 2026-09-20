# Atlas — charting experience V3 plan

*Make the existing charting system feel expensive. Not more features — feel,
precision, speed, consistency, visual quality.*

Baseline: `fe15a55`, remote = local, tree clean. Unit 42 files / 735 tests;
drawing suites 292 checks; drawing matrix a clean sweep.

---

## Phase 0 — the autopsy, honestly

I used the chart extensively and read the interaction code before proposing a
line of change. The blunt finding, worth stating plainly: **most of what this
milestone asks for is already true.** The interaction core built in the earlier
milestones is genuinely good, and pretending otherwise to justify a big rewrite
would be dishonest. So this plan is narrow on purpose — it names what is
already right, and spends its effort on the few places that actually feel wrong.

### What is already right (and must not regress)

* **Gestures live outside React.** A pointer move records one coordinate; a
  single animation frame turns the latest coordinate into hover or geometry;
  the store is written once, on release. Dragging an anchor through 300
  pointermoves is one undo entry and zero network calls. (Covers the intent of
  Phases 19, 49, 68 — history coalescing and no full-app rerender on move.)
* **The tool state machine is complete.** IDLE / PLACING / DRAGGING, sticky
  mode, and changing tools mid-placement abandons the half-placed object rather
  than stranding a ghost preview. (Phase 2.)
* **The cursor already communicates the action** — crosshair when arming, move
  over a body, the handle's own resize cursor over an anchor, grabbing during a
  body drag. (Phase 3.)
* **Hit testing is generous and cached.** `HIT_TOLERANCE` is 6px for bodies; an
  anchor's grab region is `HANDLE_RADIUS + 4`, larger than the visible dot; a
  cached screen box rejects far-away objects before any geometry runs. (Phases
  4, 7.)
* **Escape has a priority ladder** — cancel placement, then abandon a drag,
  then close a menu, then disarm the tool, then deselect. Delete/Backspace is
  refused while a text input, a settings field or a dialog has focus. (Phases
  17, 18.)
* **Right-click is context-aware** (drawing menu vs chart menu), double-click
  opens the object's settings, lock is honoured on body drag, anchor drag and
  typed coordinates, and the floating style bar + object-specific settings
  already exist. (Phases 13, 15, 16, 21, 22.)
* **Symbol switching** already opens a searchable instrument list with the
  root, the full name and the exchange, a selected state, and a separate
  front-month contract badge; stale-response protection landed in the
  diagnostics milestone. (Phases 31, 32, 35, 36 largely satisfied.)

### What actually feels wrong — the real gaps

1. **A click can nudge a drawing (Phase 8).** There is no drag threshold. The
   moment a hit begins a gesture, the very first pointermove — even one pixel of
   hand tremor while selecting — moves the object, and release commits it
   because "did any anchor change" is the only test. On a trackpad this is
   constant. **This is the single worst feel bug and the top priority.**

2. **The magnet is invisible (Phase 10).** It snaps to an open/high/low/close,
   correctly, but nothing on screen says it happened. A trader cannot tell a
   snapped anchor from a free one, so the magnet feels unreliable even when it
   is working perfectly.

3. **The symbol search is mouse-only (Phase 33).** Typing narrows the list, but
   there is no up/down/enter/escape. A keyboard trader has to reach for the
   mouse to pick the row they already filtered to.

4. **Right offset is a touch tight (Phase 46).** 6 bars is inside the 6–10
   target but the newest candle sits closer to the axis than it should for
   comfortable live-price reading. A small, safe nudge.

### Deliberately NOT changing this milestone

The icon geometry (locked). The rendering pipeline (no evidence it needs a
rewrite; profiling already drove it). The rail/picker structure (already
grouped, compact, flyout). No new tools, no Databento, no feature expansion.
The many "audit X" phases whose subject is already correct are recorded here as
verified rather than rebuilt — inventing changes to claim a phase would make
the product worse, not better.

---

## Corrections, and how each is proved

| # | Change | Proof |
| --- | --- | --- |
| 1 | Drag threshold: a gesture does not move the object until the pointer has travelled a few pixels; below that, press-and-release is a pure selection. | Browser check: select with a 2px jitter → object unmoved; a real drag → object moves. Unit test on the threshold helper. |
| 2 | Snap indicator: while placing or reshaping with the magnet on, a small ring marks the O/H/L/C the anchor snapped to. | Browser check: place with magnet STRONG → snap ring visible at the bar's high/low; magnet OFF → no ring. |
| 3 | Symbol search keyboard nav: ↑/↓ move a highlight, Enter selects it, Escape closes. | Browser check drives the selector entirely from the keyboard. |
| 4 | Right offset 6 → 8 bars. | Visual: the live candle has breathing room; still within the 6–10 target. |

## Acceptance

* The drag threshold never lets a click move a drawing, and never blocks a real
  drag. Measured, not asserted.
* The snap indicator appears only while snapping and never lingers.
* The symbol selector is fully operable from the keyboard.
* Every existing drawing suite and the drawing matrix still pass; unit and
  server tests unchanged; no new console errors.
* Nothing in the locked icon set changes.
