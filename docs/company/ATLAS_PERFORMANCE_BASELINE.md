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
