# Market integrity and terminal correction

The brief opened with the sentence that set the order of work: *"The most
important finding is that I currently do not trust Atlas's representation of the
market. Until market data, candle construction, update speed, and P&L are
proven correct, do NOT prioritize additional cosmetic features."*

So P0.1 to P0.4 were done first, and each one is proven by an instrument that
can be re-run rather than by a claim:

```
pnpm audit:candles NQ 15:30 20     # the 1-minute timeline against the vendor
pnpm audit:latency 240             # the whole latency path at p50/p95/p99
pnpm audit:drawings                # 11 drawing tools x 19 lifecycle steps
```

Three words are used below and are not interchangeable:

* **IMPLEMENTED** — the code is there.
* **AUTOMATED TESTED** — a check drives it and passes; the suite is named.
* **MANUALLY BROWSER VERIFIED** — it was used by hand in a real browser at a
  normal desktop size, and what was seen is written down.

---

## P0.1 — are the 1-minute candles correct?

**Yes, and the pipeline is now proven rather than assumed.** Full write-up with
the measurements in [`p0.1-candle-audit.md`](p0.1-candle-audit.md).

`tools/candle-audit.mjs` fetches the vendor payload directly, asks Atlas for the
same window through its own API, and compares every minute. Across NQ, ES, GC
and CL: **0 closed bars differ by half a tick or more, 0 minutes missing, 0
extra, 0 duplicate or out-of-order or off-grid timestamps, 0 invariant
violations.** The vendor's own 1-minute rows fold exactly into its own 5-minute
series (265 buckets, no difference in open, high or low), so the 1-minute series
is not a thinned copy of something coarser. The contract is right: `NQ=F` and
`NQZ26` agree to the tick while `NQU26` is 303 points away.

Atlas is in one respect *more* accurate than its own input. Yahoo serves gold
and crude as 32-bit floats — 4388.30 arrives as `4388.2998046875` — and
tick-snapping recovers the real price on 1325 of 1329 GC bars.

### So why did the two charts disagree?

Not the bars. Two measurable things, both about presentation:

1. **The clock.** Atlas labels its axis in exchange-Chicago; the vendor itself
   declares the series' timezone as New York, and that is what retail platforms
   display. Atlas's "3:30" is a reference platform's "4:30" — which accounts for
   every symptom in the brief, and for "dramatically fewer candles" exactly:
   starting a 1-minute chart at **15:30 Chicago** puts the 15:15–15:30
   equity-index halt immediately behind the left edge and the 16:00–17:00
   maintenance break 30 minutes ahead. **Sixty absent minutes inside the first
   ninety.** All sixty of the vendor's null minutes are that maintenance break,
   and Atlas correctly draws a gap.
2. **The feed is 602 seconds behind the exchange**, measured. At the same
   wall-clock instant Atlas's newest candle is ten minutes older than a live
   platform's, so "the last hour" on each is two different windows.

### The one real defect found

The **forming** bar's open could be a price that never opened that minute: at
22:08 gold's real open was 4387.50 and Atlas showed 4388.30, eight ticks away.
A price print can reach Atlas before the feed's bar for that minute, and
`ingestPrice` has to open the bucket from it or the live candle would not move —
but `merge` then kept that open. It self-corrected when the minute closed, which
is why every closed bar reconciles, and "wrong until it is too late to matter"
is not a standard. Fixed: the feed's bar owns the open, and the print stream
keeps the high, the low and the close.

### Hard invariants

`checkBars()` in `@atlas/core` is the contract as a function: `low <= open/close
<= high`, every price on the instrument's tick grid, ordered timestamps, no
duplicate bucket, on the interval boundary, one symbol, non-negative volume,
finite prices, and only the last bar may be forming. **The bar service runs it
on every page it serves**, logs anything it finds and returns the count to the
client, where `integrity.violations` is part of the response. Twenty real NQ
minutes are committed as golden data and must satisfy every invariant and fold
correctly into 5m and 10m.

AUTOMATED TESTED: `invariants.test.ts` (18), `candles.test.ts` (49 including
three for the forming open), `price-integrity.test.ts`.
MANUALLY BROWSER VERIFIED: the audit table read minute by minute against the
vendor for NQ at 15:30 and 03:30, and for ES, MNQ, GC and CL.

---

## P0.2 — market update speed

**Before: the displayed price changed once in 150 seconds. After: sixteen times.**
Same probe, same instrument, same 150-second window.

### What was wrong

The chart was wired to the bar stream alone. A WebSocket capture showed the feed
delivering **nineteen prices on `md.quote.NQ` and one bar on `md.bar.NQ.1m`** in
ninety-five seconds, and the chart drew the one. The price was arriving; the
chart was not being told.

Four fixes:

* **The forming candle follows the price stream.** A quote is a genuine
  observation with its own exchange timestamp, exactly as real as a bar's close,
  and the server's aggregator already built the bucket from it. Only the close
  moves; the open, high, low and volume stay the feed's numbers, and the range
  widens only where a genuine price went outside it.
* **Polls fetch their symbols concurrently.** Four series fetched in sequence
  made a poll take the sum of four round trips instead of the longest, so polls
  overlapped and a feed that answers in 300ms was timing out at fifteen seconds
  and reporting nineteen failed reconnects.
* **The poll schedule follows the measured cadence.** The vendor publishes a new
  reading every **10.5 seconds** (p50 over 116 polls), so a fixed five-second
  interval asked twice and learned once. Detection delay is now about a second
  with *fewer* requests, and consecutive failures back off exponentially so a
  hiccup stops becoming a wedge.
* **Egress.** Node's `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY`
  is set, and the failure mode was `503` after fifteen seconds on every request
  while `curl` to the same URL returned in 0.3s. The server sets the variable
  and says so loudly at start-up if a proxy is configured that it will not use.

### The measurements

`pnpm audit:latency` reports both halves separately, so neither can hide inside
the other. Measured over 240 seconds on a live NQ 1-minute chart:

| stage | p50 | p95 | p99 |
| --- | --- | --- | --- |
| **vendor** (exchange timestamp → the poll response lands) | 604,201 ms | 611,759 ms | 612,279 ms |
| normalize (response parsed → normalized) | 6 ms | 96 ms | 273 ms |
| publish (normalized → accepted by the bus) | 0 ms | 0 ms | 0 ms |
| socket (accepted → written to the wire) | 1 ms | 1 ms | 1 ms |
| **ATLAS** (response lands → frame on the wire) | **22 ms** | **84 ms** | **147 ms** |
| wire (frame on the wire → parsed in the browser) | 24 ms | 75 ms | 84 ms |
| apply (parsed → written to the chart's series) | 13 ms | 17 ms | 17 ms |
| paint (written → composited) | 18 ms | 21 ms | 26 ms |
| **END TO END** (response lands → pixels) | **54 ms** | **103 ms** | **120 ms** |

Before the fix the browser half could not be measured at all: `apply` and
`paint` had **zero samples in 240 seconds**, because the chart never applied a
live bar.

**The vendor is the limiting factor, by four orders of magnitude.** 602 seconds
of delay and one reading every 10.5 seconds against 54 ms of Atlas. No amount of
work inside Atlas can make this feed feel fast, and none of it fabricates ticks
to pretend otherwise.

AUTOMATED TESTED: `perf-panes` (11), `stress` (62).
MANUALLY BROWSER VERIFIED: the displayed price sampled 20x/second for 150
seconds, before and after.

---

## P0.3 — the price motion setting

**IMPLEMENTED and MANUALLY BROWSER VERIFIED.** Chart Settings → **Price motion**,
its own section, two choices named the way a trader would ask for them:

* **Tick / Raw** — every genuine observation drawn the instant it arrives,
  nothing in between.
* **Fluid / Smooth** — the drawn price eases from the last genuine observation
  towards the next.

It was previously three sliders inside "Simulation", which is why the brief said
twice that it could not be found. The guarantee is stated in the panel rather
than assumed: smooth is presentation only, and never alters OHLC, market
history, fills, stop or target triggering, order matching, P&L, risk, journal
data or recorded market data. Choosing Raw hides the smoothing controls. The
choice persists across a reload.

AUTOMATED TESTED: `motion.test.ts` — every emitted value lies between two
genuine observations, converges on the newest within a bounded time, and a mode
switch cannot produce a value the raw feed did not justify.

---

## P0.4 — is the P&L correct?

**Yes, and it reconciles across every surface the brief named.**

`pnl-reconciliation.test.ts` takes a known entry, a known exit and a known
quantity for **NQ, MNQ, ES, MES, GC and CL**, with the expected figure worked
out longhand from each instrument's published specification — a test that
computes its expectation with the same helper as the code under test proves only
that the helper is self-consistent. It then demands that number from the
position, the account balance, equity, day P&L, the trade row, the journal's own
total, the calendar cell for the day the trade closed, the equity curve's last
point, and the account row the admin view reads.

The **ledger identity** is asserted as an equation, because `realizedPnlMicros`
is GROSS and fees are a separate column:

```
balance = starting balance + gross realized − fees
```

Anything that shows one as the other is out by exactly the commission, which is
how a P&L figure ends up almost right and therefore hardest to doubt. Checked
against the live database: all three traded accounts reconcile to the cent.

### Was the −$45,000 display-only or real account state?

**Real account state.** A high-water mark is written to the database and never
comes back down, so equity marked once against the wrong market leaves a
permanent mark. The cause was threefold and is fixed at the source: a position
records the market era it was opened against, a mark from another era does not
apply to it, a missing mark is reported as unknown rather than as zero, and the
drawdown anchor only advances on a validated mark.

**A correction worth recording.** The start-up audit carried a check for "a
high-water mark above anything realized P&L can explain", I read its output as
evidence of ongoing corruption, and I was wrong. A high-water mark is peak
*equity*, equity includes unrealized profit, and so a mark above realized P&L is
what happens the first time any position is in profit and gives some back. The
check flagged fifteen of thirty accounts, every one behaving correctly. It is
removed, along with a repair tool I had started building on it — a check that
cries wolf on half its inputs teaches people to ignore audits, and a repair
founded on a wrong rule is damage. What the audit still checks is the drawdown
**floor**, which is a pure function of the rule and provable.

AUTOMATED TESTED: `pnl-reconciliation.test.ts` (10), `rules.integration.test.ts`,
`determinism.test.ts`.

---

## P1 — the terminal

### The account bar

EQ, DAY, OPEN, DD LEFT, DLL LEFT and TARGET are out of the primary bar. What is
left is four filled rectangles with white type: **BAL, MLL, RP&L, UP&L**. The
result boxes fill green or red with their sign; zero stays neutral, because
"+$0.00 in green" reads as a win that has not happened. The removed figures are
all still in the Accounts blotter and under Risk and programme, which is where a
trader studies an account rather than glances at it.

**RP&L is net of fees**, because that is the figure for which BAL equals the
starting balance plus RP&L. A bar whose own four numbers do not add up is worse
than a bar with fewer of them.

**MLL shows a dash when the floor is at or below zero.** This database has
$100,000 practice accounts whose maximum loss is $150,000, so the floor computes
to −$50,000, and the bar was about to print "MLL −$50,000.00" as though that
were a limit.

### Protective labels

A stop or target at rest is a filled box — red or green, black numbers — showing
its **dollar P&L and nothing else**. It used to carry the leg, the ticks, the
dollars, the price, the quantity and a cancel button: six things on a label
whose whole job is to be read out of the corner of an eye. The colour already
says which leg it is.

Dragging one widens it to show the leg, the ticks and the destination price, and
it collapses back to the dollars the instant the pointer is released. The cancel
button is gone; the right-click menu already had Remove.

AUTOMATED TESTED: `drag-protect` (29), including four new checks that hold the
contract — only money at rest, no price or ticks or quantity or button, a filled
red box with black numbers, and the placing numbers appearing and collapsing.

### Volume

**A clean chart has no volume.** The built-in series is gone from the adapter
along with its appearance settings, and the Volume indicator that already
existed in the registry is now the only volume there is. It arrives from
Indicators → Volume and gets what every other study gets: its own pane and price
scale, a legend row with visibility, settings, duplicate and remove, its own
styling, persistence across a reload, and independence per chart. Removing it
gives the whole height back to price.

### Left-side navigation

A 44px rail on the far left, full height, outside the account bar so the bar and
the charts both begin to the right of it. Mark at the top, then Trade, Practice
and Journal, with Settings and Sign out at the foot; each an icon over a small
label, because a rail nobody can read without hovering every icon is a puzzle.
It costs 2.6% of the width at 1680px and replaces four icons that were competing
for space in the account bar.

**It is not the drawing toolbar**, and the brief was explicit that they are
different systems. Chart drawing tools stay in their own 40px rail beside the
plot — which is why that one collapses and this one does not.

---

## P2 — the drawing tools

The brief said: *"Stop using test counts as proof of usability."* So
`pnpm audit:drawings` walks **all eleven tools through nineteen steps** and
prints a table with one row per tool, because "68/68 passed" never says which
tool failed which step.

The definitive run, every tool against every step:

| Tool | select | place | reselect | drag body | drag anchors | edit | style | duplicate | copy/paste | undo | redo | lock | unlock | hide/show | zoom | pan | timeframe | reload | delete |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Trend line | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Horizontal line | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Vertical line | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Ray | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Extended line | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Rectangle | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Fib retracement | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Measure | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Text | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Long position | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Short position | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |

**Every cell passed.** 11 tools × 19 steps = 209 checks.

Several steps cannot be driven by a pointer: a lock refusing a drag is the
*absence* of movement, and "the anchors survived a reload" needs the anchors.
The matrix therefore drives a diagnostics seam whose every function is a thin
call onto the same store action a click or keystroke invokes, so a passing cell
is the product working rather than a parallel path that agrees.

**It found a real defect on its first run: `MOVED WHILE LOCKED`.** The lock was
enforced only by the pointer layer, so it held against a drag and against Delete
and against nothing else — a typed coordinate or an applied template could move
a locked object. `updateDrawing` now refuses to change a locked drawing's
anchors. Geometry only: locking prevents moving, not restyling.

Drawing mode does not hijack the chart: one click, one object, cursor back. That
was already the default; the pin beside the cursor now makes persistent mode an
explicit, visible choice.

---

## P3 — the wheel, and finding multi-chart

**The wheel anchors the right edge.** The newest bar and its margin stay put,
bar spacing changes, and history expands in from the left or contracts out to
the left — the translation the brief asked for twice. It replaces a
pointer-anchored zoom that grew the view equally in both directions, which with
the pointer mid-chart reads as magnifying about the centre. `chart-navigation`
asserts the new contract at 25%, 50% and 75% across.

**The layout control says "Layout"** and shows the chart count. It was an
unlabelled icon in a bar that also held six metrics and five pills, which is why
the brief reported not knowing how to make two charts about a feature that was
already built and working.

---

## P4 — the journal, responsiveness and the workspace

### The journal calendar

**It was built and correct, and it was not the first thing you saw.** The
monthly grid — Sunday to Saturday columns, every day of the month in its own
square whether or not it was traded, date and net P&L and trade count in each
traded cell, green or red by the day's result, a total on every week and on the
month, arrows that only walk to months the account actually traded in, a click
on a day opening that day's trades, a click on a trade opening its full detail
with MAE, MFE, R multiple, hold time and fees, and "Show on chart" putting the
instrument and the window back — all of that already worked. The journal simply
*opened* on the analytics page, so the calendar the brief called the primary
interface was the second chip in a row.

Calendar is now the default tab and the first chip. The suite asserts it the
only way that means anything: open the journal, look at what is on screen
before anything is clicked.

AUTOMATED TESTED: `journal-calendar` (21), including three new checks for
which tab the journal lands on.
MANUALLY BROWSER VERIFIED: September 2026 on the Practice 100K account —
2 traded days of 7 trades, +$3,435.22 for the month, five weekly totals, and a
short ES trade opening to `MAE −$200.00 / MFE $2,300.00 / 2.99R / held 5h 00m`.

### Responsiveness

`responsive` walks every visible control in the terminal and asks the browser
two questions — *is your content wider than your box*, and *do you overlap a
sibling* — then does it again at every size. It now covers the surfaces the
brief named rather than the ones that were already passing: the order ticket
from widest to narrowest and back, the bottom panel from tallest to shortest
and back, seven window widths from 1920 down to **900px** (past anything a
trader would choose), the left navigation rail, the indicator legend with two
studies on the chart, the chart toolbar and timeframe selector, two charts side
by side at three widths, the settings dialog at three sizes, and the journal
calendar at three widths — each with a restore afterwards. **38/38.**

**Two real defects, both found by widening the sweep:**

1. A settings row never shrank (`flex: 0 0 auto`), so the seven-way **Source**
   control asked for 373px of buttons inside a 268px indicator panel and pushed
   its own label off the edge. `OHLC/4` could not be reached. Rows and controls
   now wrap; the row is the constraint, not the control.
2. A colour field was 132px wide holding a 24-character value, clipping
   `rgba(77, 141, 255, 0.34)` at `rgba(77, 141, 25` — a colour input that would
   not show you its own colour.

Neither was reachable from the checks that existed, which is the argument for
sweeping every element rather than listing places to look.

### The workspace

The direction of travel this milestone: **six metrics and five pills became
four boxes**, a second order toolbar and a VOL/LOG/RESET/NOW/PNG strip were
removed, four icons left the account bar for a 44px rail, volume stopped being
permanent furniture, and a protective label went from six pieces of information
to one number. Every one of those is chart area or attention given back.

What has not been done is a typography and spacing pass across every panel. The
terminal is consistent within itself and the numbers are tabular, but the
bottom blotter and the settings dialog have more borders than they need.


## P5 — backtesting

Removed, and verified removed: **zero occurrences of "backtest"** in any source
file, test or document. Practice and simulated trading, the historical records
the charts need, and the journal and trade history are all intact.

---

## What is NOT finished

* **The feed.** Everything above is bounded by a development vendor that is 602
  seconds delayed, publishes one reading every 10.5 seconds, serves OHLCV only
  with no bid, ask, prints or book, offers 7 days of 1-minute history, and
  rate-limits. The pipeline is proven correct against it; it cannot support
  professional futures charting, and the next milestone for speed is a licensed
  feed rather than more work inside Atlas.
* **Sub-minute timeframes** cannot exist on this feed at all.
* **Indicator panes cannot be resized** by dragging their separator.
* **The Fibonacci family is one tool.** The retracement is complete including
  the arbitrary-level editor; fans, arcs and time zones are not built.
* **The five secondary tools have no per-tool detail pass** — they pass all
  nineteen lifecycle steps, and the measure's readout and text styling have not
  had the attention the rectangle and the position tools got.
* **Alerts, watchlist and a hotkey editor** are not in this milestone.
* **A typography and spacing pass** across the bottom blotter and the settings
  dialog. Both are consistent and neither spills, and both carry more borders
  than they need.
