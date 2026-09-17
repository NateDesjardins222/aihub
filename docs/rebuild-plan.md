# Atlas terminal rebuild — plan and architecture

Scope: sections 1–27 of the rebuild brief. This document is the plan asked for
in the brief's final paragraph, and the checkpoint order is the brief's §25.

**Missing input.** The brief refers to "a comprehensive drawing-tool
specification supplied separately". It is not in this conversation. §13's list
of families is treated as the working specification, and the engine is built so
a fuller specification adds *tool definitions* rather than engine changes. Every
tool listed in §13 but not yet implemented is named in the status table at the
end rather than shipped as a dead icon (§13: "Do NOT create fake
implementations just so an icon exists").

---

## 1. What is wrong today, in architectural terms

| # | Symptom | Cause |
|---|---------|-------|
| §10 | The chart freezes after a drawing is made | `DrawingLayer` sets `pointer-events: auto` on its canvas whenever any drawing exists, so the canvas swallows every pan and zoom |
| §1 | The position marker is a row of text | One label renders side, quantity, entry, P&L and two buttons |
| §2 | `+SL` / `+TP` buttons | Protection is created by a click, not by a gesture |
| §7 | Reads as an engineering tool | 10–13px type on a 4px scale, 20–24px controls, no font of our own |
| §16 | One chart only | `ChartPanel` is a singleton that reads `session.activeSymbol` directly |
| §18 | Journal is a drawer | It is a panel, not a page; there is no page concept |
| §9 | Drawings are a fixed list | `DrawingKind` is a union and `paint()` is a switch — every new tool edits both |

## 2. Drawing Engine architecture

The current drawing code is a canvas plus a `switch`. Replaced by a registry
and a document model, so a tool is *data* and the engine never grows a branch
per tool.

```
apps/web/src/chart/drawings/
  model.ts        geometry, hit-testing, anchors        (pure, tested)
  registry.ts     ToolDef: anchors, draw, hit, props    (pure, tested)
  document.ts     the drawing document + undo/redo      (pure, tested)
  store.ts        zustand: documents per symbol, selection, tool, templates
  DrawingCanvas.tsx   renders a document through the registry
  DrawingInput.ts     ONE pointer state machine
  tools/*.ts      one file per tool family
```

### 2.1 The pointer state machine (fixes §10)

The bug is a pointer-events bug, so the fix is an explicit ownership rule:

> The drawing canvas is `pointer-events: none`, always. It is a painting
> surface and never an input surface.

Input is a state machine attached to the chart container in the **capture**
phase. On every `pointerdown` it decides who owns the gesture and only then
calls `stopPropagation`:

| State | Condition | Owner |
|-------|-----------|-------|
| `IDLE` | no tool armed, hit-test misses | **chart** — pan/zoom untouched |
| `IDLE` | no tool armed, hit-test hits a drawing | drawings — select, then drag |
| `ARMED` | a tool is armed | drawings — place anchors |
| `PLACING` | mid-placement | drawings; Escape returns to `IDLE` |
| `DRAGGING` | a drag began on a hit | drawings until pointerup |

After a placement completes the machine returns to `IDLE` unless "stay in
drawing mode" is on, so the next click pans. This is the whole of §10.

### 2.2 Tool definitions

```ts
interface ToolDef<P = Record<string, unknown>> {
  kind: string;
  name: string;
  family: 'LINES' | 'CHANNELS' | 'FIBONACCI' | 'SHAPES' | 'ANNOTATION'
        | 'POSITION' | 'MEASURE' | 'VOLUME' | 'PATTERNS';
  anchors: number | 'OPEN';           // OPEN = brush / polyline
  defaults: P & DrawingStyle;
  props: PropDef[];                   // drives the property editor (§11)
  draw(ctx, drawing, projection, state): void;
  hit(drawing, projection, cursor, selected): HitTarget | null;
  handles?(drawing, projection): Point[];
}
```

The property editor (§11) and the Fibonacci level editor (§12) are generated
from `props`, so a new tool gets an editor for free and the editor cannot drift
from the tool.

### 2.3 The document, persistence and undo/redo

```ts
interface DrawingDoc {
  version: 2;
  bySymbol: Record<string, Drawing[]>;   // §27 symbol swap/restore
  templates: Record<string, Template>;   // §12 "ICT OTE", saved once
}
```

* Undo/redo is a bounded stack of *documents* (structural sharing, 100 deep).
  Cheap, and impossible to get wrong per-tool.
* Persistence is debounced 800ms into the existing preferences blob (§21,
  §23). Interaction never awaits a write.
* `timeframeVisibility` on each drawing decides whether it draws on the
  current interval (§13).

## 3. Multi-chart architecture (§16)

`ChartPanel` stops being a singleton. Introduce:

```ts
interface PaneState {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  indicators: IndicatorInstance[];
  appearance: Partial<ChartAppearance> | null;  // null = workspace default
}

interface LayoutState {
  layout: '1' | '2V' | '2H' | '3' | '4';
  panes: PaneState[];
  activePaneId: string;
  sync: { symbol: boolean; interval: boolean; crosshair: boolean; time: boolean; drawings: boolean };
}
```

* `<ChartPane paneId>` owns one adapter, one legend, one motion layer, one
  drawing canvas. It subscribes to its OWN symbol on the shared market stream.
* The toolbar and the order ticket act on `activePaneId` (§16).
* **Account state stays global** (§24). A pane selects what is *displayed*; it
  never holds a position, a balance or an order. The ticket reads the active
  pane's symbol and submits through the same single authoritative path.
* Crosshair sync is a broadcast of `{time, paneId}`; the receiving pane moves
  its crosshair without touching data.

Performance (§21): one `requestAnimationFrame` loop per pane, ticks never enter
React, and a hidden pane's loop is not scheduled.

## 4. Visual system (§7, §8, §22)

* **Type**: Inter Variable (SIL OFL) for UI, JetBrains Mono Variable (SIL OFL)
  for numerics, both self-hosted — no runtime font CDN, no proprietary font.
* **Scale**: 11 / 12 / 13 / 15 / 18 / 22 px replacing today's 10 / 11 / 12 / 13.
* **Controls**: 28px standard, 32px primary, 24px dense; 8px radius on
  controls, 10px on surfaces.
* **P&L** gets its own display treatment: tabular, weighted, animated (§20).

## 5. Checkpoints

Each checkpoint ends green — unit suite, browser suite, typecheck — and is a
commit, so a partial rebuild cannot destabilise the execution engine (§25).

| # | Checkpoint | Brief sections |
|---|-----------|----------------|
| A | Pointer ownership, position marker, drag-to-protect, SL/TP visuals | §1 §2 §3 §10 |
| B | Typography and visual system, order ticket, timeframe bar, navigation, bottom panel, ladder removal | §4 §5 §6 §7 §8 §17 §19 §22 |
| C | Drawing Engine foundation: registry, document, undo/redo, property editor, context menu, templates, object tree | §9 §11 §23 |
| D | High-priority tools + serious Fibonacci | §12 §13 (subset D) |
| E | Multi-chart | §16 |
| F | Journal page | §18 |
| G | Remaining drawing families | §13 |
| H | Gamification, performance, acceptance screenshots | §20 §21 §26 |

## 6. What will not be faked

* No lower-resolution interval is offered that the feed cannot supply (§8). The
  development feed is one-minute bars, so 30s and 45s are listed as
  unavailable, with the reason, until a feed provides them.
* No DOM/ladder (§6 — removed this pass).
* No drawing alert until an authoritative alert API exists (§13, §24).
* Volume-based tools only where genuine volume exists (§13).
* **No "Auto scale" checkbox.** Turning it off should hold the range on screen.
  The renderer drops to a default range instead, which flattens the candles
  into a band at the top of the pane, and holding a range through the series'
  range provider fights its own scaling and does the same. Auto-scaling is
  always on and Reset scale remains. Revisit when the chart engine is replaced.
