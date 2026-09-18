# Screenshots for the terminal correction milestone

Every image here was taken by a script driving a real Chromium at 1680x1050
against the real server, the real database and the real delayed market data.
None of them is a mock-up and none has been edited.

## What the brief asked to see

| File | What it shows |
| --- | --- |
| `multi-chart-four-charts.png` | Four charts in one layout, each with its own instrument, interval and indicators |
| `multi-chart-two-charts.png` | The two-chart layout |
| `multi-chart-kept-in-step.png` | Two charts with crosshair and time range synchronised |
| `manual-four-charts.png` | The four-chart layout in the whole terminal, from the manual pass |
| `fibonacci-level-editor.png` | The Fibonacci level editor: per-level visibility, percentage, colour, opacity, thickness and dash, plus add, remove, four presets and reverse |
| `fibonacci-custom-levels.png` | A retracement drawn with custom levels and styling |
| `indicators-three-instances.png` | Three EMA instances at different lengths and colours, a Bollinger band and an RSI, each named for its own parameters |
| `indicators-own-panes.png` | Oscillators in panes of their own, with the price pane keeping its share of the height |
| `position-tools-long-and-short.png` | The Long and Short position tools, with ticks, money and risk/reward on each zone |
| `position-tool-settings.png` | A position tool's settings, including editable entry, target and stop |
| `manual-position-settings.png` | The same dialog in the whole terminal, after the coordinate fields were widened |
| `journal-calendar.png` | The journal calendar: a month of days with per-day and per-week totals |
| `journal-calendar-day-drilldown.png` | A day's trades, reached by clicking that day |
| `manual-journal-calendar.png` | The calendar beside two charts, from the manual pass |
| `performance-four-panes.png` | Four charts open, as measured by `perf-panes` |
| `manual-object-tree.png` | The object tree listing eleven objects, opening upwards |
| `manual-settings-scales.png` | The settings dialog's longest section, in full |

## Before, for the faults the manual pass found

These are the SAME steps of the same walkthrough, taken before the fixes.
Reading each against its counterpart above is the before/after evidence.

| File | The fault |
| --- | --- |
| `before-object-tree-clipped.png` | The object tree in a 169px slot: five of eleven objects, "remove all" below the fold |
| `before-legend-collision.png` | "MA 20 close" printed through the OHLC, because the status line wrapped |
| `before-coordinates-clipped.png` | "29700.50" clipped to "2970(", and the dialog ending mid-checkbox |
| `before-settings-cut-and-pale-wells.png` | The crosshair section cut off, and every colour well the same pale grey whatever value it held |
| `before-fictional-profit-target.png` | A practice account 0.01% of the way to a $1,000,000 "target" it does not have |

## Typeface

`font-geist-crop.png`, `font-inter-crop.png`, `font-plex-crop.png` are the
crops the typeface was chosen from, at the size the terminal renders numbers.

## Not here, and why

No photograph of the chart showing one market while the account traded another
survived. Both were written to a scratch directory that the next run cleans,
and both were gone before they were copied in. The state is described in
`../../terminal-correction.md`, quoted from the readings taken at the time and
corroborated by the run logs. Pointing at a different screenshot would be
worse than saying this.
