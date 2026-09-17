# Terminal redesign — audit and checklist

Screenshots supplied: (1) the VOL/LOG/RESET/NOW/PNG strip, (2) the chart header,
(3) the current right panel in full height, (4) the TopstepX order ticket,
(5) the full TopstepX/TradingView terminal.

Each row below names the file that owns the thing today, so nothing is "moved"
into a place that does not exist.

## REMOVE

| # | Thing | Where it lives now | Disposition |
|---|---|---|---|
| R1 | `VOL` `LOG` `RESET` `NOW` `PNG` chips | `ChartPanel.tsx` chart-toolbar | VOL/LOG → chart Settings (Scales and lines / Canvas); RESET/NOW → small icon controls on the chart's bottom-right, TradingView style; PNG → the `⋯` overflow menu |
| R2 | Chart-type `<select>` reading "Candles" | `ChartPanel.tsx` | Removed. Candles is the default; style selection moves to a compact icon menu |
| R3 | Large `.tf-btn` timeframe buttons | `ChartPanel.tsx` + `ChartPanel.css` | Replaced with compact text controls, active one subtly highlighted, user-configurable favourites |
| R4 | Full-width instrument `<select>` with the long description | `ChartPanel.tsx` | Replaced with a compact symbol control + search popover |
| R5 | Second order toolbar: `1 − +` `BUY MKT` `SELL MKT` `FLATTEN` `REVERSE` `CANCEL ALL` `right-click hint` | `ChartTrading.tsx` `ct-toolbar` | Removed outright. Order entry belongs to the right ticket |
| R6 | Tab strip `Order / DOM / Risk / Practice / Replay / Sim` | `RightPanel.tsx` | Removed. The right column is the ticket only |
| R7 | Bottom `CONTRACT / MAX CONTRACTS / ROUND TURN` footer block | `RightPanel.tsx` right-footer | Folded into one dense line in the ticket |
| R8 | `op-facts` definition list (Round turn / Tick value / Contracts / Equity) | `OrderPanel.tsx` | Folded into the same dense line |
| R9 | The 1,100 px of empty vertical space below the ticket | consequence of `RightPanel` layout | Ticket is content-height; the column no longer stretches its children |
| R10 | Flat wall of 27 always-visible disabled drawing buttons | `DrawingRail.tsx` | Replaced with expandable categories, common tools first, actually working |

## MOVE (out of the terminal, into Settings / secondary navigation)

| # | Thing | From | To |
|---|-------|------|-----|
| M1 | Risk dashboard (`RiskPanel`) | right tab | Settings → Risk & programme, plus the header's existing live figures |
| M2 | Practice modes + session catalogue (`PracticePanel`) | right tab | Practice drawer (left nav button), with the transport docked under the chart only while a replay is loaded |
| M3 | Raw replay controls (`ReplayPanel`) | right tab | same drawer, "Recording" section |
| M4 | Simulation environment incl. RAW/SMOOTH (`EnvironmentPanel`) | right tab | Settings → Simulation |
| M5 | Training visibility toggles | right tab (Sim) | Settings → Practice visibility |
| M6 | Journal / analytics (`JournalPanel`) | bottom tab | Journal drawer (left nav button) |
| M7 | DOM / price ladder (`DomPanel`) | right tab | Left nav button; still states plainly that this feed carries no depth |
| M8 | Bar count, history note, "updated" clock, feed badge | chart legend / toolbar | Status line, configurable in Settings → Status line |

## REBUILD

| # | Item | Requirement |
|---|------|-------------|
| B1 | Chart header | One compact row: symbol control · contract pill · favourite timeframes as text · chart-style icon menu · Indicators · `⚙` chart settings · `⋯` overflow. Control height 24 px, 11–12 px type |
| B2 | Time format | 12-hour with AM/PM by default on the axis, the status line and the clock; format + timezone configurable |
| B3 | Right order ticket | TopstepX order: Contract → Order Type → Contracts → quote block (only when the provider genuinely supplies bid/ask) → position → quick-qty row → Position Bracket → BUY/SELL → position/order actions. Target width 210–240 px, dense |
| B4 | Quote block honesty | No fabricated bid/ask. When `providesTopOfBook` is false, the block says the feed provides last only |
| B5 | Order/position markers | Horizontal rule + one compact label per level, aligned to the real price, de-overlapped vertically so labels can never stack. Distinct states for entry, working order, stop, target. Quantity always; P&L on the position line. Per-line cancel, and drag to modify |
| B6 | Bracket workflow | Nothing protective is drawn because a checkbox is ticked. Position Bracket has Off / Manual / Auto; Manual is the default. On a fill the position marker appears with `+SL` / `+TP` affordances that create REAL server-side OCO orders, which are then draggable |
| B7 | Chart settings | Sections: Symbol, Status line, Scales and lines, Canvas. Candle body/border/wick/up/down colours, background, grid, session breaks, pane separators, crosshair, scale text and lines, price scale, time scale. Persisted through the existing `/api/v1/trading/preferences` blob |
| B8 | Chart styles | Compact icon menu. Candles, hollow candles, bars, line, line+markers, area, baseline, Heikin Ashi — all derivable from genuine OHLCV. Types that need tick data we do not have stay listed as unavailable rather than faked |
| B9 | Drawing tools | Expandable categories; cursor, trend line, ray, horizontal, vertical, rectangle, fib retracement, text first. Hover, selection handles, drag, magnet-to-OHLC, lock, hide, delete, duplicate, style editing, favourites, persistence |
| B10 | Indicators | One searchable menu. Overlays (MA, EMA, VWAP, Bollinger) and panes (volume, RSI, MACD, ATR), computed from genuine bars, unit-tested against known values |
| B11 | Practice account | A $150,000 PRACTICE account seeded automatically and selected on first load, from a generic template — no proprietary programme logic |
| B12 | Density pass | 24 px controls, 11/12/13 px type scale, 1 px borders, 3 px radii, chart ≥ 72% of the viewport width at 1440 px and ≥ 78% at 1920 px |

## FUNCTIONALITY (not restyling)

| # | Item | Status |
|---|------|--------|
| F1 | SL/TP actually trigger on a genuine market event | **FIXED** — `611ce9f`. Bracket legs were stamped for eligibility on the wall clock while the matcher uses the market clock, so in a replay they could never become eligible. 12 new end-to-end tests, long/short × stop/target × dragged × partial × live/replay |
| F2 | Replay determinism with live brackets | **FIXED** — same commit. Observations are no longer coalesced in replay, and the observation plus price window are captured synchronously per event |
| F3 | Excursions must not include prices from after the trade closed | **FIXED** — same commit |
| F4 | Dragging a level modifies the authoritative order | Already true (`tradingApi.modify` + `expectedVersion`); to be preserved through the marker rebuild |
| F5 | Server-side protective orders for an existing position | New engine operation, OCO-linked and position-sized |
| F6 | Settings persist | Through `/api/v1/trading/preferences` |
| F7 | Indicators calculate correctly | Unit tests with hand-checked expectations |
| F8 | Drawings behave correctly | Unit tests on hit-testing and geometry; browser tests on interaction |
| F9 | Existing deterministic execution / replay / risk tests stay green | 404 tests green at `611ce9f` |
