# ATLAS MULTI-CHART READINESS

**Engineering Phase B, Part XI (STEP 42-44).** Architectural audit of running more than one independent
chart at once. **Finding: multi-chart is already built and shipping** — this is a readiness *audit*, not
a request to build the feature while the owner is away.

## What already exists

`ChartGrid.tsx` lays out **1 / 2 / 3 / 4** panes (`SINGLE`, `TWO_V`, `TWO_H`, `THREE`, `FOUR`) with real
draggable dividers whose split persists with the workspace. Every pane is the **same `ChartPanel`** —
the header comment states it outright: *"Every pane is the same ChartPanel; there is no separate
multi-chart code path."* So the two-instance harness the step asks for is the product's own `TWO_V`
layout; no throwaway harness was built.

## Per-pane isolation (already correct)

Each pane carries its own `PaneState` in `useLayout` (`layout-store.ts`):

| State | Scope | Isolated? |
|---|---|---|
| symbol | `PaneState.symbol` | ✅ per pane |
| timeframe | `PaneState.timeframe` | ✅ per pane |
| chart type | `PaneState.chartType` | ✅ per pane |
| indicators | `PaneState.indicators` | ✅ per pane |
| pane (price/indicator) split | `PaneState.paneSplit` | ✅ per pane |
| chart adapter instance + bars | one `LightweightChartsAdapter` per `ChartPanel` | ✅ per pane |
| market subscription | `marketStream.subscribeBars(symbol, timeframe, …)` | ✅ topic-multiplexed on one WS; no cross-pane contamination |

`marketStream` is a single WebSocket that **multiplexes by topic** (`subscribeBars`/`subscribeRaw`), so N
panes on different symbols/timeframes each get exactly their own stream from one connection. Two panes on
the *same* symbol+timeframe share the same normalized bars by design (correct — the same market is the
same market).

## Deliberately shared (global) state — and why

| State | Scope | Rationale / consequence |
|---|---|---|
| **Active trading account** | terminal-global (`useSession.selectedAccount`) | The order ticket, DOM and risk act on one account at a time. |
| **Active pane ↔ terminal symbol** | coupled | The **active** pane's instrument *is* the terminal's instrument (`ChartGrid` syncs them). This is a safety coupling: the BUY/SELL button and the chart under it must never disagree, which is a way to lose money. |
| **Drawings store** | global, keyed by `symbol` | The same symbol shown in two panes shows the same drawings — *"which is what a trader means"* (layout-store comment). Not a leak: a pane only paints drawings whose `symbol` matches its own. |
| **Active tool / selection** | global (`useChartStore.tool`, `selectedDrawingId`) | One armed tool and one selected drawing across panes. Acceptable today (one pointer, one intent); a per-pane tool state would be a refinement, not a correctness fix. |

## Architectural blockers to *fully independent* charts — NONE that break correctness

- **No hard singleton prevents a second chart instance** — the product already runs four. Each
  `ChartPanel` owns its adapter, subscriptions and per-pane state.
- The only genuinely global pieces are **active account**, the **active-pane↔symbol coupling**, and the
  **global tool/selection**. The first two are *intentional trading-safety decisions*, not blockers. The
  third is a UX refinement (per-pane armed tool), not a correctness blocker.

## Account-context policy (STEP 44) — technical statement, decision deferred

Today: **one active account for the whole terminal**, and the active pane's symbol becomes the terminal
symbol, so an order always applies to the instrument the trader is looking at. A future "trade a
different account per chart" model is technically possible (account would move from `useSession` into
`PaneState`, and the order ticket/DOM/risk would read the *active pane's* account), but it materially
changes the safety story — a glance at the wrong pane could route an order to the wrong account. **This
is a product decision for Nathan**, not one to make objectively while he is away. Consequences are
recorded here so the decision can be made with them in view.

## Verdict

Multi-chart is **architecturally ready and already in production use** (`ChartGrid`, `useLayout` panes).
Per-pane market data, indicators, drawings-by-symbol, and pane splits are isolated. The remaining
shared state (account, active-pane symbol coupling, global tool) is deliberate and safe. The only open
item is the *per-chart account* product decision, which is Nathan's to make. No blocker requires
code work this phase.
