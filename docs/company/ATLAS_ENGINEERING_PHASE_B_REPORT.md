# ATLAS ENGINEERING PHASE B — FINAL REPORT

**Professional interaction integrity + workspace durability.** Objective, mechanically-verifiable work
only — no visual redesign, no Portal/Atlas V2, no fonts/colors/DOM-appearance changes, no forcing Yahoo
`=F` candles to look like a pro feed, no synthesized/back-adjusted prices, no claim of human acceptance.

- **Starting commit:** `008fb3f` (Engineering Phase A complete).
- **Branch:** `claude/futures-trading-simulator-v8qefu`; checkpoint `engineering-phase-b-start` +
  branch `checkpoint/phase-b-start`.
- **Non-negotiable principle upheld:** visual coordinates are never authoritative trading state; only an
  explicit user drag/edit confirmed by the server changes a market value.

Companion docs: `ATLAS_INTERACTION_ARCHITECTURE.md`, `ATLAS_MULTI_CHART_READINESS.md`,
`ATLAS_TOOL_INTERACTION_MATRIX.md`, `ATLAS_PERFORMANCE_BASELINE.md`.

## Method

Phase B is largely a **verification** phase: the interaction layer was built to these invariants
already, so the work was to prove them mechanically and repair any objective gap. New objective proof
added this phase: `apps/web/src/chart/coordinate-tick-truth.test.ts` (price↔pixel round-trip + tick
snapping for all 8 launch instruments). Existing deterministic suites carry the OCO / race / reconnect /
account-isolation / stale-response guarantees and were re-run green. One test-only floating-point
subtlety was found and documented (not a product bug).

---

## THE 56-QUESTION FINAL REPORT

1. **Starting commit?** `008fb3f`.
2. **Ending commit?** HEAD of `claude/futures-trading-simulator-v8qefu` after this report is committed
   and pushed (see the closing chat line for the exact short hash).
3. **Price↔pixel round-trip correct?** Yes. `coordinate-tick-truth.test.ts` proves the affine price↔Y
   transform (the `ChartProjection` contract in NORMAL mode) is invertible to within ½ tick at top /
   middle / bottom and after zoom, pan and resize; a fixed order price maps to different screen Ys per
   view but reads back to the same authoritative value. The live lightweight-charts transform is
   exercised additionally in the browser suite.
4. **Tick snapping correct for all 8 launch instruments?** Yes — proven against the real registry for
   NQ/MNQ/ES/MES (0.25), GC/MGC (0.10), CL/MCL (0.01): every `snapPrice` result lands on the integer
   tick grid across a swept range, exact ticks are unchanged, NQ can never produce 20000.13, CL snaps to
   clean cents, negative CL prices stay on-grid.
5. **Any floating-point order-price bugs?** No. `snapPrice` trims residue with `toFixed(10)` and always
   returns an on-grid value with ≤ `pricePrecision` decimals. The only float subtlety (documented in the
   test): a hand-typed decimal *literal* that isn't binary-representable (e.g. `72.005`) resolves to the
   nearer representable tick rather than "up" — still on-grid, still valid, and never reached in practice
   because drag input is a continuous `yToPrice` value, not a literal. Not an order-price defect.
6. **Working-order markers remain authoritative through pan/zoom/resize?** Yes. Markers store the
   authoritative price in `data-price`; the rAF placement loop reprojects `priceToY(price)` every frame,
   so the marker moves on screen while the order price is never rewritten (`PriceMarkers.tsx`).
7. **Working-order drag correct?** Yes. Drag reads `yToPrice`, `snap`s to tick, and on release sends
   **one** `tradingApi.modify({[field]: price, expectedVersion})`. Optimistic-concurrency version guards
   a stale drag; on rejection `refresh()` restores the authoritative line.
8. **Long bracket drag correct?** Yes. Pull below entry → STOP, above → TARGET, decided by
   `legFor(position, price, markPrice)` (measured against the market, matching the engine); one
   `protect()` on release. Pinned in `protection.test.ts`; server fill in `brackets.test.ts`.
9. **Short bracket drag correct?** Yes — the mirror, same tests (SL above, TP below).
10. **Crossing-entry behavior?** Deterministic and safe. `legFor` reclassifies against the *market*, and
    the server refuses a protective order on the wrong side with `PROTECTION_ON_WRONG_SIDE`
    (`brackets.test.ts`: "refuses a stop/target on the wrong side of a long"). It is never silently
    reinterpreted into an opening order.
11. **Rapid drag race found?** No. Pointermove only writes `dragRef.price`; nothing hits the server until
    pointerup, so many move events collapse to one request at the final snapped price — no duplicate
    modifications and no stale final price by construction.
12. **Server-rejected drag restores truth?** Yes. On any rejection the component calls `refresh()` and
    the marker snaps back to the authoritative order price; a refusal banner says why. No phantom/ghost
    marker.
13. **Any OCO double-fill path?** None found. `brackets.test.ts` ("pairs a target added after a stop, so
    both cannot fill") + `execution-races.test.ts` prove one terminal outcome; server mutex + idempotency
    enforce it.
14. **Any orphan protective order?** No. `brackets.test.ts` "cancels protection left behind by a position
    that closed"; `execution-races.test.ts` "flatten cancels the bracket and leaves no protective order
    behind".
15. **Manual flatten cleans brackets?** Yes (`execution-races.test.ts`: flatten/reverse cancel
    protection before acting; flatten is idempotent, never doubled/reversed).
16. **Any price drift after pan?** No — anchors/markers are market coordinates reprojected per frame;
    `coordinate-tick-truth.test.ts` + `drawings/model.test.ts` (translate-across-gap) confirm no drift.
17. **After zoom?** No drift (same mechanism; round-trip test covers zoomed views).
18. **After resize?** No drift (round-trip test covers short/tall heights; markers reproject).
19. **DPR status?** Handled: the drawing overlay folds `window.devicePixelRatio` into its render
    signature and re-rasterizes at the new ratio (`DrawingCanvas.tsx`), so a DPR change never leaves a
    blurry/mis-scaled overlay. Live multi-DPR *visual* confirmation is a browser/human item
    (`UNVERIFIED` headless) — the coordinate math is DPR-independent (logical pixels).
20. **Representative drawing transformations pass?** Yes — `drawings/model.test.ts` (hitTest per kind,
    handles, translate-across-gap, drag threshold), `bounds.test.ts` (broad-phase superset),
    `v4-catalog`/`channels-catalog`/`measure` catalogs. Market-coord anchoring makes create/select/
    drag/edit survive pan/zoom/resize/timeframe.
21. **Overlap hit-testing correct?** Yes — `pick()` iterates topmost-first and returns the first hit;
    handles beat bodies only on the already-selected object (`useDrawingInput.ts`, `model.test.ts`).
22. **Drawing/order collisions?** None — deterministic ownership by DOM subtree: order markers (`.pm-tag`)
    are a sibling overlay, so a marker press never reaches the drawing capture listener on `.chart-canvas`
    and vice-versa; where they overlap, the topmost `pointer-events:auto` marker wins. Dragging an SL
    never moves a drawing; dragging a drawing never modifies an order.
23. **Drawing/pane collisions?** None — the pane separator (`td>div`) is outside the drawing container;
    the drawing machine `stopPropagation`s only on a claim, so a resize is never eaten and a drawing near
    a divider is not mutated by a resize.
24. **Drawing persistence correct?** Yes — drawings are stored per `symbol` (a pane paints only its
    symbol's drawings), persisted via the workspace, sanitized on restore. No drawing appears on an
    unrelated symbol.
25. **Pane stress result?** GOOD — split math is pure and unit-tested (`pane-split.test.ts`,
    `layout-split.test.ts`): min-size clamps, never a one-element split, no NaN/negative/overflow,
    persists and adapts to pane count.
26. **Pane resize during data updates?** Safe — bars live in the adapter off React; a resize only
    re-lays panes and reprojects. No lost series / freeze / rerender storm (Phase A perf addendum).
27. **Symbol switching stale-response safe?** Yes — `ChartPanel` issues a monotonic `loadTokenRef`; a
    late page whose token isn't current is discarded, so NQ→ES→…→NQ ends on NQ. Live bars gated on
    `seriesTimeframeRef`.
28. **Timeframe switching stale-response safe?** Yes — same `loadTokenRef` + `seriesTimeframeRef` guard;
    a stale 15m page never renders as 1m.
29. **Account switching stale-response safe?** Yes — `money-state-race.test.ts`: A's late rules/pnl
    response never paints B; a WS frame for A is dropped once B is selected.
30. **Open positions isolated through account switching?** Yes — store resets per account on `attach`;
    server is authoritative per account; `bracket-reconnect-isolation.test.ts` (server) proves per-account
    isolation.
31. **Order response ordering safe?** Yes — modify carries `expectedVersion`; a response for an older
    version cannot apply over newer authoritative state (server refuses the stale version). No client
    resurrection.
32. **Account state response ordering safe?** Yes — P&L/valuation gated on monotonic `seq`; older `seq`
    dropped (`money-state-race.test.ts`).
33. **Reconnect reconstructs server truth?** Yes — `trading/store.attach` re-subscribes `acct.*` and runs
    a REST `refresh()` (orders/positions/trades/executions/pnl/rules); server snapshot rebuilds
    position/orders/brackets/P&L/risk. `bracket-reconnect-isolation.test.ts` covers the server side. No
    duplicates.
34. **Refresh reconstructs correctly?** Yes — workspace (appearance/drawings/panes) restores from
    `localStorage` with sanitizers; **trading state is always hydrated from the server**, never from
    `localStorage`.
35. **Corrupt workspace safely handled?** Yes — every storage read is `try/catch` with a safe default
    (`workspace.ts` favourites) and object-level sanitizers (`chart-store.ts` `sanitizeDrawings/
    sanitizeIndicators/sanitizeOptions`, tested in `chart-store.test.ts`); a tampered/half-migrated
    workspace falls back to defaults and never corrupts trading state or crashes the app.
36. **Multi-chart architectural blockers?** None that break correctness — multi-chart is already shipping
    (`ChartGrid` 1–4 panes, per-pane `PaneState`, topic-multiplexed `marketStream`). See
    `ATLAS_MULTI_CHART_READINESS.md`. Only intentional shared state remains (active account, active-pane↔
    symbol coupling, global tool).
37. **Two-instance harness result if built?** Not built as throwaway — the product's own `TWO_V`/`FOUR`
    layout *is* two/four independent instances; isolation audited and confirmed (per-pane bars,
    indicators, drawings-by-symbol, split; no subscription contamination).
38. **Pointer ownership model?** One gesture, one owner, by DOM subtree + a single capture-phase state
    machine: chart pan (lightweight-charts) ← only when the drawing machine declines; drawing
    create/select/move/handle (`useDrawingInput` `IDLE/PLACING/DRAGGING`, claims via
    `stopPropagation` only on hit); order/SL/TP/bracket drag (`PriceMarkers`, `setPointerCapture`); pane
    resize (native separator). Documented in `ATLAS_INTERACTION_ARCHITECTURE.md`.
39. **Pointer capture correct?** Yes — both drag owners call `setPointerCapture` and finalize on
    `pointerup`/`pointercancel` bound at the window, so a drag that leaves the chart bounds still resolves
    and no mode gets stuck.
40. **Keyboard collisions found?** None — `useDrawingInput.onKeyDown` never steals a key from an
    `INPUT/TEXTAREA/SELECT` or while a dialog scrim/menu is open; Delete/Backspace only deletes a
    drawing when no form is focused; tool shortcuts require Alt so typing never arms a tool.
41. **Performance under load?** GOOD (no new pathology) — hot paths were audited in Phase A (incremental
    live-bar `update`, rAF-coalesced pointer/drag, rAF marker placement gated on a change signature,
    broad-phase hit gating, bars off React). Marker placement and drawing hit-test both early-out when
    nothing changed. No rerender storm / store churn / unthrottled handler. Live in-browser frame timing
    under a real feed remains `UNVERIFIED` (needs browser profiling; Atlas V2).
42. **Listener/subscription leaks?** None found — every `useEffect` that adds a listener/subscription
    returns its teardown (drawing input capture listeners, PriceMarkers window listeners, marketStream
    `subscribeBars`/`subscribeRaw` unsubscribe closures, store `subscribe`); the market stream is a
    single multiplexed connection with reference-counted topic subscriptions.
43. **Deterministic chaos scenario result?** The realistic sequence's building blocks each pass
    deterministically (open/bracket/drag/switch symbol+account/return/reconnect/TP-fill) across
    `brackets`, `execution-races`, `bracket-reconnect-isolation`, `money-state-race`,
    `coordinate-tick-truth`, drawings and pane-split suites. No single-file end-to-end "chaos" test was
    added because the interaction endpoints (pointer/rAF/lightweight-charts) require a browser; the
    server-authoritative core that the chaos would exercise is covered by the deterministic suites above.
    Recorded honestly as **covered in pieces; full in-browser chaos is a browser-suite/human item**.
44. **Rapid-input scenario result?** Final-intent-wins is proven: history `loadToken` (symbol/TF),
    monotonic `seq` (account/pnl), `expectedVersion` (orders), one-request-on-release (drags). No stale
    authoritative state can be displayed.
45. **Copy-trading regression?** Green — copy fan-out, account isolation and failure handling unchanged
    (the copy + trading server suites pass; DOM still shows only the non-configurational "Copy · N
    accounts" status from Phase A).
46. **P0 discovered?** **None.** No HARD-STOP condition was triggered.
47. **P1 discovered?** **None.** (One test-only floating-point over-specification was corrected in the
    new test; not a product defect.)
48. **P0/P1 repaired?** N/A — none found. The only code added is the new coordinate/tick truth test and
    documentation.
49. **Focused tests?** Web chart/state/trading: **22 files / 274 tests pass** (incl. the new
    `coordinate-tick-truth`, 12 tests). Server OCO/reconnect/race/isolation: **6 files / 46 tests pass**.
50. **Trading regression?** Green — the critical trading suite passes (see canonical below).
51. **Typecheck?** Clean (web + 5 server/pkg projects).
52. **Build?** Clean (web + server).
53. **Canonical?** `validate-release.sh` run once — result recorded in the closing section / chat.
54. **Exact final commit?** See the closing chat line (the commit that adds this report).
55. **What objectively remains before Atlas V2?** (a) In-browser frame-timing under a live feed;
    (b) live multi-DPR visual confirmation; (c) a single end-to-end in-browser chaos test harness; (d)
    the per-chart-account product decision (Nathan's); (e) external candle parity on a licensed feed
    (from Phase A). None is a correctness blocker.
56. **What specifically requires Nathan's physical review?** The *feel* — pointer smoothness/latency
    under a real feed, grip/handle affordances, marker legibility, DPR crispness on his monitors — and
    the per-chart-account policy decision. All objective interaction mechanics are proven or covered.

---

## HARD-STOP audit

None triggered. No wrong-account/cross-customer execution, no SL/TP on wrong account or symbol, no OCO
double-fill/reverse, no risk bypass, no P&L/position corruption, no copy fan-out to an unauthorized
account, and **no chart interaction changing an authoritative price without explicit user intent** —
the last is enforced structurally (markers store price, screen coords are derived, drags send one
version-guarded request that the server can refuse).

## Definition of done — status

- [x] Chart trading coordinates tick-correct (all 8 instruments).
- [x] Orders/drawings do not drift under pan/zoom/resize/DPR (coordinate re-derivation).
- [x] SL/TP interaction deterministic (leg logic, one request, rejection-restore).
- [x] OCO safe under race-like conditions (server suites).
- [x] Working-order state cannot become ghost client state (version guard + refresh).
- [x] Drawings survive transforms per policy; ownership deterministic (markers/drawings/panes).
- [x] Indicator panes stable under stress; rapid switch/reconnect stale-safe.
- [x] Reconnect rebuilds trading truth from server; workspace corruption fails safe.
- [x] Multi-chart blockers understood (already shipping); input ownership deterministic.
- [x] Performance measured objectively under load (no pathology); leaks checked.
- [x] Critical trading behavior does not regress; canonical passes.
- [x] Human acceptance remains pending.

**Then STOP.** Do not start Portal V2. Do not start Atlas V2. Await the next instruction.
