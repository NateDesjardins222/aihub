# ATLAS ENGINEERING PHASE A — FINAL REPORT

**Market data truth + chart correctness + interaction foundation.** Objective, mechanically-provable
engineering only. No Portal V2, no Atlas V2 visual rebuild, no subjective brand/design work, no new
products, no new drawing tools, no chart-library replacement, no real providers/money. Conducted while
the owner is away and cannot visually inspect the app, so every claim below is backed by a test, a
measurement, or a code reference — never by "it looks right".

- **Starting commit:** `65ca5ec` (Product Recovery Phase 3 complete).
- **Branch:** `claude/futures-trading-simulator-v8qefu`.
- **Priority order held:** P0 candle truth → P1 pane architecture → P1 tool interaction → P2 copy
  separation.

Companion docs: `ATLAS_MARKET_DATA_PIPELINE.md`, `ATLAS_CONTRACT_POLICY.md`,
`ATLAS_CANDLE_TRUTH_REPORT.md` (27 questions), `ATLAS_TOOL_INTERACTION_MATRIX.md`,
`ATLAS_PERFORMANCE_BASELINE.md` (Phase A addendum). Status docs updated: `PRODUCT_BEHAVIORAL_TRUTH.md`,
`PRODUCT_UX_DEBT.md`, `KNOWN_ISSUES.md`.

---

## What changed (the whole diff, in one place)

| File | Kind | Why |
|---|---|---|
| `apps/web/src/chart/bar-order.ts` | NEW | `orderBarsAscendingUnique` — strictly-ascending, unique-by-time (last-wins), no-op if already ordered. |
| `apps/web/src/chart/bar-order.test.ts` | NEW | 5 tests. |
| `apps/web/src/chart/LightweightChartsAdapter.ts` | EDIT | `applyHistory` orders/de-dups via the new module before render (root-cause fix for a possible freeze). `fitSplit` delegates to the pure `adaptSplit`. |
| `apps/web/src/chart/pane-split.ts` | NEW | Pure `adaptSplit`/`automaticSplit` split math (extracted + unit-tested). |
| `apps/web/src/chart/pane-split.test.ts` | NEW | 8 tests. |
| `apps/web/src/chart/drawings/bounds.ts` | EDIT | `computeBox` now makes the broad-phase box a conservative superset of `hitTest` for CROSS_LINE / HORIZONTAL_RAY / TEXT / ANCHORED_TEXT / NOTE / ARROW_MARK_*. |
| `apps/web/src/chart/drawings/bounds.test.ts` | EDIT | +4 cases exercising the `mayHit` path (the gap the old `hitTest`-direct tests missed). |
| `apps/server/src/marketdata/candle-truth.test.ts` | NEW | 4 tests: null minute dropped never fabricated; faithful normalization; bucket-open ms; count = minutes − nulls. |
| `scripts/bar-truth.ts` | NEW | Bar-truth diagnostic: raw Yahoo vs `normalizeBar`, minute-by-minute MATCH/VALUE_MISMATCH/MISSING + bar-count parity. |
| `apps/web/src/panels/OrderTicket.tsx` / `.css` | EDIT | Copy in the order DOM reduced from a per-follower preview to a single non-configurational "Copy · N accounts" status line. Execution fan-out unchanged. |
| `docs/company/*` | DOCS | This report + the five companion docs + three status-doc updates. |

**No production code path for order triggering, execution, contract mapping, positions, P&L, risk, or
copy routing was changed.** The chart fixes touch rendering/selection; the copy change touches DOM
*display* only. This is the guardrail behind every HARD-STOP condition.

---

## THE 35-QUESTION FINAL REPORT

### Scope & provenance
1. **Starting commit?** `65ca5ec`.
2. **Ending commit?** The HEAD of `claude/futures-trading-simulator-v8qefu` after this report is
   committed and pushed (the final commit of Phase A; see the branch log / the closing chat message
   for the exact short hash).
3. **Did the phase stay in objective scope (no V2 visual work, no new products/tools, no real
   providers/money)?** Yes. Every change is a correctness fix, an extracted+tested pure function, a
   diagnostic, a DOM *reduction*, or documentation.

### P0 — Market data / candle truth
4. **Are Atlas candles the correct market bars at the provider boundary?** Yes — **faithful**. Measured
   minute-by-minute (no sampling) against the live dev provider with `scripts/bar-truth.ts`.
5. **What is the candle root cause of the owner's "wrong candles"?** Three distinct, non-overlapping
   causes, none of which is corrupted math: **(a)** the dev **data source** (Yahoo free 1m returns
   `null` for a meaningful fraction of minutes → real gaps + fewer bars than a pro feed); **(b)**
   **continuous front-month `=F`** for every symbol vs a reference showing a specific/back-adjusted
   contract (different O/C, roll jumps); **(c)** one genuine **client robustness bug** —
   `applyHistory` rendered bars without ordering/de-dup. **(d)** open- vs close-time labeling is a
   convention difference, not an error.
6. **Which layer was wrong?** Only the **client render-entry layer** (`applyHistory`). The provider
   adapter, normalization, contract mapping, server folding, and cache are all faithful.
7. **What exactly was fixed?** `applyHistory` now runs `orderBarsAscendingUnique` before handing bars
   to lightweight-charts — matching what `prependHistory` already did. This prevents a `setData`
   throw/freeze and any misplacement when a page arrives unordered or with a duplicate time.
8. **Was the rendered chart patched, or the earliest incorrect layer?** The **earliest incorrect
   layer** (client normalization on ingest), not the rendered chart. We never mutate historical OHLC or
   timestamps to make the picture look nicer — that would be dishonest.
9. **NQ parity?** 1810 raw grid minutes → 1741 normalized bars, **0 value mismatches, 0 extra bars**;
   69 vendor-`null` minutes dropped. Faithful.
10. **ES parity?** 1809 → 1740, **0/0**; 69 null + 1 trailing live row. Faithful.
11. **GC parity?** 1809 → 1748, **0/0**; 61 null + 1 trailing. Faithful.
12. **CL parity?** 1809 → 1748, **0/0**; 61 null + 1 trailing. Faithful.
13. **Bar-count parity?** Normalized count = (raw grid minutes − vendor-null minutes − trailing
    live-price row). Every "missing" bar is accounted for as a vendor `null`; **nothing is silently
    dropped by Atlas code**.
14. **Timestamp semantics correct?** Yes. Epoch **seconds** (exchange-absolute) → ms; **open-time**
    (bucket start) end to end; timezone applied only at display, never to the numeric bar time. **0
    timestamp shifts** observed.
15. **Session-calendar / filtering correct?** No bar-level session filter exists (`includePrePost=true`,
    ETH included). Session windows only align coarse-timeframe buckets. No session-boundary errors
    found.
16. **Aggregation correct?** Yes. Folding is **server-side** from a 1m base (`foldBars`); the client
    never aggregates. open=first / high=max / low=min / close=last / volume=sum is covered by existing
    handoff/fold/candle-integrity tests.
17. **Any wrong OHLC, wrong volume, duplicates, or wrong-contract math?** None. 0 value mismatches
    across thousands of minutes; volumes carried through unchanged; 0 vendor duplicates in the measured
    windows (and the client now collapses any that ever appear); contract math correct (continuous `=F`
    is policy, not a mis-map).
18. **What remains uncertain on candles?** **EXTERNAL REFERENCE PARITY UNVERIFIED** — Atlas vs a
    reference platform (e.g. TradingView/broker) on the *same contract + session* is not testable
    headless. This needs Nathan's eyes or a licensed feed. Stated honestly; not faked.

### P1 — Indicator / volume pane architecture
19. **Is the Volume pane resizable by dragging the divider?** Yes. Volume is a **first-class indicator
    pane** (`overlay:false`), so it uses the same native lightweight-charts separator drag as every
    other pane — the specific complaint ("can't resize the volume/indicator panes") is resolved by the
    architecture already in place, now proven by extracted split-math tests.
20. **Does the pane split persist across reload?** Yes — the split is read back on release
    (`readSplit`) and persisted; on load it is re-applied and adapted to the current pane count
    (`adaptSplit`), so adding/removing a study never throws away the trader's arrangement.
21. **Do multiple panes work (2+ oscillators below price)?** Yes. Panes are allocated in add-order; the
    price pane keeps its share and lower panes divide the remainder (`adaptSplit`, unit-tested for the
    1-pane, 2-pane, and 3-pane cases including the "never destroy a split by adapting to one pane" bug).
22. **Overlay-vs-pane distinction correct?** Yes — overlay indicators draw on the price pane; pane
    indicators (incl. Volume) get their own resizable pane with a separator + double-click reset.

### P1 — Chart tool interaction
23. **How many tools were audited?** All **27** exposed `DrawingKind` tools (full inventory + clicks →
    anchors + hit model in `ATLAS_TOOL_INTERACTION_MATRIX.md`).
24. **How many pass each interaction dimension now?** All pass (CREATE / SELECT / MOVE / EDIT / DELETE /
    pan-zoom-resize stability / coordinate system / event collisions). SELECT was FAIL for six tools
    before the fix.
25. **What objective interaction bug was found?** The broad-phase `mayHit` box was **not a conservative
    superset of `hitTest`**, so `pick()` rejected real hits before `hitTest` ran. Six tools were
    unselectable across their real hit region: **CROSS_LINE** arms, **HORIZONTAL_RAY** body,
    **TEXT/ANCHORED_TEXT** box, and the **NOTE/ARROW_MARK_*** stamps.
26. **Root cause?** `computeBox` special-cased only a few line kinds and gave everything else a tight
    anchor box padded 6px; any hit region larger than that box was dead.
27. **Fixed?** Yes, at root cause in `bounds.ts`, with regression cases that exercise the `mayHit` path
    (the old tests called `hitTest` directly and so gave false confidence).
28. **Coordinate system correct?** Yes — every anchor is `{time: epoch ms, price}` (market coords),
    screen coords derived per frame; **no tool stores pixels**, so drawings stay pinned on
    pan/zoom/scale/resize.
29. **Event collisions?** None — a single capture-phase pointer state machine owns gestures and calls
    `stopPropagation` only on a claim, so chart pan/zoom and the pane separator are never eaten.
30. **What chart-tool work is explicitly NOT done (and shouldn't be)?** Physical *feel* — grip
    grab-ease, handle sizes, cursor affordances, TradingView-grade polish. Out of scope this phase;
    Atlas V2 human-review item. No new tools were added.

### P2 — Copy-trading architecture separation
31. **Is copy CONFIGURATION removed from the order DOM?** Yes — and it already was: all group
    management (create group, designate leader, up to 4 followers, sizing SAME/MULTIPLIER/FIXED, status,
    divergence) lives in `CopyPanel` + `copy-store` + `copy-api`. `OrderTicket` never held
    configuration. This phase reduced the DOM's remaining copy *display* from a per-follower preview to
    a single non-configurational **"Copy · N accounts"** status line — honoring the locked direction
    that the order DOM may keep only a tiny status indicator.
32. **Is the copy DOMAIN logic preserved (execution fan-out unchanged)?** Yes. Submission still fans out
    through `copyApi.submitIntent`; only the DOM's *display* changed. Proven by the 247-test trading
    regression staying green.
33. **Where does copy access temporarily live, and what's the final placement?** Configuration lives in
    the **Copy panel** (temporary, least-disruptive placement); the order DOM keeps only the status
    line. **Final placement is PENDING ATLAS V2 human review** — deliberately not decided here.

### Performance, regressions, and validation
34. **Performance & trading regressions?** No regression. Hot-path audit (STEP 31) found no rerender
    storm / store churn / unthrottled handler; the one new per-`applyHistory` function measures
    **0.0076 ms** on the normal path and is not on any per-frame path. Live in-browser frame timing
    stays `UNVERIFIED` (needs a real feed + browser profiling; Atlas V2). The **do-not-break-trading**
    regression is **green: 25 files / 247 tests** (market/limit/stop, positions, P&L, brackets/OCO,
    risk, account switching) against a fresh migrated+seeded DB after all Phase A edits.
35. **Validation status, P0/P1 count, and what needs Nathan's eyes?**
    - **Focused Phase A tests:** 4 files / 25 tests PASS (bar-order, pane-split, bounds, candle-truth).
    - **Typecheck:** clean (web + 5 server/pkg projects).
    - **Build:** clean (web + server; the 753 KB bundle warning is pre-existing documented debt).
    - **Trading regression:** 25 files / 247 tests PASS.
    - **Canonical validation (`validate-release.sh`):** run **once** — result recorded in the closing
      section / chat.
    - **P0 defects introduced or open:** **0.** No HARD-STOP condition was triggered (no wrong bars for
      order triggering, no wrong-account execution, no cross-customer access, no risk bypass, no P&L
      corruption, no wrong-instrument mapping, no drawing/chart change altering execution prices, no
      copy change causing wrong-account orders).
    - **P1 defects fixed:** 2 (applyHistory ordering; unselectable tools). **P1 open:** 0.
    - **Needs Nathan's eyes (human-only, all P3):** external candle parity on a matched contract;
      chart-tool physical feel/polish; final placement of the copy status line. See `KNOWN_ISSUES.md`
      PA-G1..G6.

---

## HARD-STOP audit (explicit)

None triggered. For each condition the phase was told to halt on, the reason it cannot occur from this
diff:

| HARD-STOP condition | Why it cannot occur |
|---|---|
| Wrong bars used for order triggering | Order triggering runs server-side on the execution/quote path, untouched. Chart bars are display-only. |
| Wrong-account execution | No execution routing changed; trading regression green. |
| Cross-customer data access | No auth/tenant code touched. |
| Risk bypass | No risk-gate code touched; regression green. |
| Position / P&L corruption | No position/P&L code touched; regression green. |
| Contract mapping executes wrong instrument | No mapping changed; documented as policy, verified faithful. |
| Drawing/chart changes altering execution prices | Drawings store market coords and never place orders; the position-planning tools are display-only. |
| Copy change causing wrong-account orders | Only the DOM *display* changed; `submitIntent` fan-out unchanged; regression green. |

---

## Definition of done for Phase A

- [x] P0 candle truth mapped, measured, root-caused; the one real client bug fixed at its layer.
- [x] P1 pane architecture verified (Volume resizable, split persists, multiple panes) + split math
      extracted and tested.
- [x] P1 all 27 tools audited; the objective selection bug fixed + regression-tested.
- [x] P2 copy configuration confirmed out of the DOM; DOM reduced to a status indicator; domain logic
      preserved.
- [x] Perf hot-path audit; trading regression green; docs written; validation run.
- [x] External reference parity stated honestly as UNVERIFIED (not faked).
- [x] No P0, no HARD-STOP, no scope creep into V2.

**Then STOP.** Do not start Portal V2. Do not start Atlas V2. Await the next instruction.
