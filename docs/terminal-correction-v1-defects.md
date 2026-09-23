# Atlas — Terminal Correction & TradingView Parity V1 — defect ledger

Append-only working ledger. Starting baseline `f099cad`, branch
`claude/futures-trading-simulator-v8qefu`.

**States:** `REPRODUCED` · `ROOT_CAUSED` · `FIXED` · `VERIFIED` · `BLOCKED` ·
`NOT_REPRODUCED`. A defect is not `FIXED` until reproduced first, and not
`VERIFIED` until proven by an automated test and/or real-browser check.

Nothing here is deleted, including findings that turn out embarrassing or that
trace to a provider limitation rather than an Atlas bug.

| ID | Area | Symptom (user) | State |
| --- | --- | --- | --- |
| D-01 | Multi-chart | Side-by-side chart panes cannot be resized (locked equal width) | investigating |
| D-02 | Symbol search | Type `ES` while on `GC` + Enter → stays on `GC` | VERIFIED (fixed) |
| D-03 | Crosshair | Multi-chart time crosshair not synchronized across panes | investigating |
| D-04 | Multi-chart | No "apply chart config to other charts" action | investigating |
| D-05 | Measure tool | Too primitive; poor measurement info + interaction | investigating |
| D-06 | Fibonacci | Interaction feels bad; needs rebuild | investigating |
| D-07 | Text drawing | Hitbox tiny; only a small part selects the text | investigating |
| D-08 | Drawing toolbar | Left toolbar too small (width/icons/targets) | investigating |
| D-09 | Settings | Location/design; move to left app rail, declutter | investigating |
| D-10 | Practice | Remove user-facing Practice section (keep sim engine) | investigating |
| D-11 | Context menu | No professional chart context menu | investigating |
| D-12 | Position marker | Marker visual/interaction unacceptable (awaiting screenshot for redesign) | BLOCKED (screenshot) |
| D-13 | **P0 P&L** | Phantom ~+$8,000 P&L on load/restart, never earned | investigating |
| D-14 | **P0 scale-in** | Scale into position → TP $ value stale, SL updates | investigating |
| D-15 | Scale-in semantics | Protection quantity/value semantics undefined on scale-in | investigating |
| D-17 | Candles | Candles still visually wrong vs reference | investigating |
| D-20 | Render/time-scale | Visible bar density may differ (render vs data error) | investigating |

## Detail

Entries are filled in as each defect moves through the states. Format per defect:
reported symptom → reproduction → root cause → severity → fix → automated
regression → manual/browser verification.

---

### D-02 — Symbol search Enter selects the wrong (old) symbol
_(pending investigation write-up)_

### D-13 — P0 phantom +$8,000 P&L
_(pending investigation write-up)_

### D-14 — P0 scale-in stale TP value
_(pending investigation write-up)_
