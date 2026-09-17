# The drawing tool catalogue

The brief (§13) asks for comprehensive drawing tool families and says plainly:

> Do NOT create fake implementations just so an icon exists. A tool isn't
> "implemented" until its geometry, editing, persistence and expected
> interactions work.

The "comprehensive drawing tool specification" the brief refers to was not
supplied, so this file **is** that specification, written from the standard
vocabulary of technical analysis rather than from any one product. It is the
list the work is measured against; where a judgement had to be made it is
stated here rather than buried in code.

Nothing in this catalogue reproduces proprietary source, iconography or
branding: the geometry of a trend line or a Fibonacci retracement is ordinary
technical analysis, and every icon and paint routine in the repository is
original (see `IP-COMPLIANCE.md`).

## Definition of done, per tool

A tool ships only when all seven hold:

1. **Geometry** — it paints correctly at any zoom, in both price directions,
   and its anchors are stored in market coordinates (time, price), never
   pixels.
2. **Placement** — it takes its anchors with a live preview, and Escape
   abandons a half-placed object.
3. **Hit-testing** — clicking it selects it; clicking near-but-not-on it does
   not, and does not steal the gesture from the chart.
4. **Editing** — every anchor has a handle, the body drags as a whole, and the
   magnet snaps to a price the bar actually printed.
5. **Properties** — its registry entry declares every setting it honours, and
   the generated settings dialog edits them. No setting is offered that the
   paint routine ignores.
6. **Persistence** — it survives a reload, a timeframe change and an instrument
   switch, and a stored object with junk in it is dropped rather than trusted.
7. **Tests** — geometry and hit-testing in `model.test.ts`, the registry
   contract in `registry.test.ts`, and the interaction in a browser suite.

## Families

### Lines — shipped (checkpoint C)

| Tool | Anchors | Notes |
|------|---------|-------|
| Trend line | 2 | Segment between two points. |
| Ray | 2 | Extends past the second point. |
| Extended line | 2 | Extends both ways. |
| Horizontal line | 1 | Spans the plot; optional price label. |
| Vertical line | 1 | Spans the pane. |

### Lines — checkpoint D

| Tool | Anchors | Notes |
|------|---------|-------|
| Horizontal ray | 1 + direction | A level that starts where it was drawn and runs right. |
| Arrow | 2 | Trend line with a head, for marking a move. |
| Info line | 2 | Trend line labelled with its price and bar delta. |
| Polyline (path) | n | Click to add, double-click or Escape to finish. |

### Channels — checkpoint D

| Tool | Anchors | Notes |
|------|---------|-------|
| Parallel channel | 3 | Two anchors set the base line, the third the width. |
| Flat channel | 2 | Two horizontal bounds; a range rather than a trend. |

### Fibonacci — retracement shipped (C), the rest checkpoint D

| Tool | Anchors | Notes |
|------|---------|-------|
| Fib retracement | 2 | Editable levels, colours, visibility, reverse, presets (Classic, OTE, Extensions, Minimal). |
| Fib extension | 3 | Move, retracement, projection origin. Same level editor. |
| Fib time zones | 2 | Vertical lines at Fibonacci bar counts from the anchor. |
| Fib channel | 3 | Levels parallel to a trend rather than horizontal. |

### Shapes — rectangle shipped (C)

| Tool | Anchors | Notes |
|------|---------|-------|
| Rectangle | 2 | Optional fill. |
| Ellipse | 2 | Bounding box; fill optional. |
| Triangle | 3 | Three free anchors. |

### Annotation

| Tool | Anchors | Notes |
|------|---------|-------|
| Text | 1 | Shipped (C). |
| Callout | 2 | Text with a leader line to a bar. |
| Note marker | 1 | A pin that opens its text on hover. |

### Measurement

| Tool | Anchors | Notes |
|------|---------|-------|
| Measure | 2 | Shipped (C): price delta and bar count. |
| Price range | 2 | Vertical span only. |
| Date range | 2 | Horizontal span only, in bars and in clock time. |
| Long position / Short position | 2 + levels | Entry, stop and target bands with R multiple — **presentation only**, see below. |

## What will NOT be built, and why

* **Drawing alerts.** An alert that fires on a line crossing is an execution
  concern, and the brief forbids inventing execution behaviour in the chart
  (§24). It waits for an authoritative server-side alert API.
* **Volume profile, volume-by-price and anything else derived from tick
  volume**, until the feed supplies genuine volume for the instrument. A
  profile drawn from one-minute bar volume where the feed gives none would be
  fabricated data, which the standing rules forbid outright.
* **A position tool that places orders.** The long/short position tool draws a
  risk/reward picture. It does not submit, modify or imply an order: orders
  come from the order ticket or the drag-to-protect gesture, both of which go
  through the authoritative engine. Anything else would be a second execution
  path in the browser.
* **Any tool whose geometry cannot be expressed in (time, price)** — a
  pixel-anchored object would break on the first zoom, and a tool that breaks
  is a fake implementation with a working icon.

## Order of work

Checkpoint D takes the tools a futures trader reaches for daily: horizontal
ray, arrow, parallel channel, flat channel, ellipse, triangle, fib extension,
price range, date range, long/short position. Checkpoint G takes the rest:
polyline, info line, fib time zones, fib channel, callout, note marker.
