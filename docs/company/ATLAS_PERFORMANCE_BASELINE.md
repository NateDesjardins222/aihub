# ATLAS PERFORMANCE BASELINE

**Product Recovery Phase 2 — STEP 25.** Measured, not guessed. From `2fe43da`, dev environment
(simulation, delayed feed). Purpose: locate where "laggy feel" comes from before any Atlas rebuild.
**No Atlas redesign in this phase.**

## Measurements (headless, dev)
| Signal | Measured | How |
|---|---|---|
| API `/ready` round-trip | **~3 ms** | fetch, warm |
| Historical bars fetch (`/marketdata/bars` NQ 1m, ~1500 bars) | **~17 ms** | fetch |
| Terminal navigation → first chart `<canvas>` present | **~300 ms** | Playwright, DOMContentLoaded→selector |
| Terminal DOMContentLoaded / load | ~18 ms / ~21 ms | Navigation Timing (preview server) |
| Main JS bundle | **753 KB (227 KB gzip), single chunk** | Vite build report (resource transferSize read 0 under the preview server, so the build figure is authoritative) |

## Interpretation
- **Server/data latency is not the problem.** API and history are single/low-double-digit ms; the
  chart is interactive within ~300 ms in a headless run. There is **no gross server or data-latency
  bug** to root-cause here — consistent with the architecture: market ticks bypass React and write
  straight to canvas, account updates are debounced/coalesced, P&L is applied by monotonic server seq
  (no re-render storm).
- **The "laggy feel" is interaction quality, not throughput.** The owner's complaints — chart feel,
  tool behavior, tools obstructing price, DOM/order interaction, bracket interaction — are
  interaction-design and rendering-polish problems that belong to the Atlas rebuild phase, not a
  measurable latency defect fixable safely here.

## Minor debt found (document, do not fix now)
- **Monolithic 753 KB bundle** — a real first-paint cost; the Atlas rebuild should code-split
  (chart/terminal lazily, vendor separately). Not a runtime-lag cause once loaded.
- **Redundant polling** — `useFreshness` polls REST every 5 s per pane and replay status every 3 s,
  duplicating the WebSocket `md.status` heartbeat. Low cost; dedupe during the rebuild.

## Not measured here (honest scope)
- **Real order → fill → UI round-trip latency** requires an open market and live in-browser order
  flow; deferred to a live session. `UNVERIFIED` headless.
- **Sustained tick-render frame timing under load** (the actual "feel") needs a live feed + frame
  profiling in a real browser; the Atlas rebuild phase should instrument `requestAnimationFrame` and
  input-to-paint latency directly. `UNVERIFIED` here.

## Recommendation
Do not micro-optimize blindly. The Atlas quality rebuild (a later, dedicated phase) should own:
code-splitting, input-to-paint instrumentation, tool/DOM interaction redesign, and the polling
dedupe. Nothing here is a P0/P1 latency bug.

---

## Engineering Phase A addendum (STEP 31) — hot-path audit from `65ca5ec`

**Scope of STEP 31:** re-audit the chart hot paths (bar request/normalization, series update,
pointer/drag, pane resize) for rerender storms, store churn, and unthrottled handlers, and confirm the
Phase A edits added no per-frame cost. Live in-browser frame timing under a real feed is **not** run
here (no live feed, no visual inspection this phase) — it stays `UNVERIFIED`, as in the baseline above.

### Hot paths — code-level findings (all already sound)
| Path | Mechanism | Verdict |
|---|---|---|
| **Live bar → series** (`applyLiveBar`) | Incremental `series.update(newestPoint)`; a full `setData` redraw only when an *interior* bar is revised or the transform is stateful (Heikin-Ashi). Indicators recompute over the full series but hand the renderer **tail-only** the newest point. | PASS — the earlier CPU-profile hot spot (`setSeriesData`/`checkItemsAreOrdered` on every tick) is already designed out. |
| **History fetch + normalize** | `/marketdata/bars` ~17 ms warm (baseline); normalization is O(n) faithful; client `applyHistory`/`prependHistory` order+de-dup once per page. | PASS |
| **Pointer / drag** (`useDrawingInput`) | Single capture-phase `pointermove` sets a flag + last point; a self-rescheduling `requestAnimationFrame` loop does the work **at most once per frame** and early-outs when nothing moved. Selection is gated by the broad-phase `mayHit` box before `hitTest`. | PASS — rAF-coalesced, no per-event layout, no rerender storm. |
| **Pane resize / separator** | Separator wiring is `requestAnimationFrame`-scheduled (coalesced, prior frame cancelled); split persists on release, not per drag frame. | PASS |
| **Store churn** | Bars live in the adapter, **not** React/Zustand state; `chart-store` is appearance-only. Ticks bypass React entirely (write straight to canvas). | PASS — no bar-driven re-render. |

### Phase A edits: added cost measured
- **`orderBarsAscendingUnique`** (new; runs once per `applyHistory`/`prependHistory`): measured
  **0.0076 ms/call** on the normal already-ordered 1200-bar path (a cheap ordered-check no-op),
  **0.0125 ms** at 5000 bars, and **0.28 ms** in the pathological fully-shuffled 1200-bar case. It is
  **not** on any per-frame path. Negligible.
- **`computeBox` broad-phase fix** (`bounds.ts`): pure geometry, same call site and frequency as before
  (once per drawing per frame, already cached per projection signature). No new cost; it only widens
  four boxes so `mayHit` stops rejecting real hits.
- **OrderTicket copy → status line**: *removes* DOM (a mapped per-follower row list becomes one line).
  Strictly less render work.

**Conclusion:** no rerender storm, no store churn, no unthrottled handler — before or after Phase A.
Nothing here is a P0/P1 latency defect. Sustained tick-render frame timing under a live feed remains
`UNVERIFIED` and belongs to a live browser-profiling session (Atlas V2), unchanged from the baseline.
