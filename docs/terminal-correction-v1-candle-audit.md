# Terminal Correction V1 — candle / data / render audit (D-17, D-19, D-20)

Reopened from scratch per the milestone. The question: are the candles wrong
because of a **data** error (A), an **aggregation** error (B), a **contract /
session** error (C), a **chart-render / time-scale** error (D), or a
combination (E)? Each layer was separated and checked.

## Method

The pipeline was traced end to end: provider → normalize → aggregate/fold →
REST history + forming bar → client series → lightweight-charts time scale. An
integrity auditor (`apps/server/src/marketdata/candle-integrity.ts`, tested in
`candle-integrity.test.ts`) checks a bar series for the invariants a candle can
never break — high ≥ max(open,close), low ≤ min(open,close), high ≥ low, finite
OHLC, non-negative volume, strictly increasing timestamps, no duplicates, bucket
alignment to the timeframe — and separates those hard DATA errors from
informational session GAPS.

## Findings by layer

### A — market data (provider)
Current feed: **`yahoo-delayed`** (Databento professional feed is PAUSED). Not a
data-integrity fault: the provider guard `price-integrity.ts` already rejects
spike prints, keeps genuine session gaps, and treats a late bucket as a revision
rather than a duplicate. Yahoo delivers already-aggregated bars for the base
intervals.

### B — aggregation / forming bar
Sound. The forming-bar fold (`marketdata/service.ts`) preserves the **true
bucket open** (`open: last.open`), takes `high = max`, `low = min`, `volume =
max` of the vendor bar and the fine-bar aggregate, and carries the latest close
— exactly the D-21 forming-candle rules (open never replaced, high/low
monotonic, close latest). The live bucket is chosen against the **exchange
clock** (`quote.exchangeTs`), not `Date.now()`, so a delayed feed does not point
at a bucket the market has not reached. The auditor confirms a forming last bar
is valid and a well-formed series has zero hard violations.

### C — contract / session identity  ← the source of a visible mismatch
The mapping is explicit in `@atlas/instruments`:

| Atlas root(s) | Yahoo provider symbol |
| --- | --- |
| NQ, MNQ | `NQ=F` |
| ES, MES | `ES=F` |
| GC, MGC | `GC=F` |
| CL, MCL | `CL=F` |

`=F` is Yahoo's **continuous front-month futures** series — the correct futures
underlying (NOT the cash index). Micros track the full-size series (MNQ→NQ=F);
price is identical, only contract size differs. This is the right identity for
the current feed. **But** a reference platform (e.g. one wired to CME direct)
typically shows a *specific* contract (e.g. NQZ5) or a *differently-rolled*
continuous, on realtime CME data, with its own session/timezone presentation.
Against `NQ=F` delayed that produces genuine, expected differences in price
level, exact OHLC, roll dates, and which bars exist — this is provider/contract
origin, not an Atlas aggregation or render defect.

### D — render / time scale
Config reviewed (`LightweightChartsAdapter`): `barSpacing: 7`, `rightOffset: 8`,
`lockVisibleTimeRangeOnResize: true`, device-pixel-ratio handled by the library.
These are reasonable, professional defaults; visible bar density is a function of
`barSpacing × plot width` and matches a standard terminal. No render defect
found. (A trader who expects a different default density can zoom; the divider
work in D-01 keeps each pane's plot width honest.)

## Verdict

**Classification: primarily C (contract/session origin) with the data (A),
aggregation (B) and render (D) layers proven sound.** Atlas's candles are
internally correct — the auditor finds zero hard violations on well-formed
series and the forming-bar rules hold. The residual visual difference versus a
realtime CME-direct reference is attributable to the **paused** professional
feed: `yahoo-delayed` serves a ~10-minute-delayed, Yahoo-aggregated continuous
`=F` series, which is a different data source and roll convention from the
reference. Enabling the Databento professional feed (a separate, paused
milestone) is what closes that gap; no Atlas-side aggregation or render change
would, because the difference is in the source data, not its handling.

## Addendum — the render *layer* had a separate bug (D-16)

This audit examined render *configuration* (barSpacing, rightOffset, DPR,
container sizing intent) and found it sound. Real-browser acceptance then found a
render *layout* defect the config inspection could not: the chart container was
collapsing to zero height (D-16, a self-inflicted regression from the D-03
time-cursor work) so no candles painted in any layout. That is a DOM-layout bug,
not an aggregation, time-scale, or config bug, and it is fixed and verified
in-browser (see `terminal-correction-v1-report.md` §1). The classification above
— data/aggregation/config sound, residual is provider origin — stands; D-16 was
orthogonal to it and is why "verify in a real browser" is not optional.

## Evidence to capture when the market is open (not runnable in this sandbox)
For a same-instant A/B, record from Atlas and the reference, for one instrument
and timeframe: display symbol, provider symbol, contract/expiry, session
calendar, timezone, and the OHLC+volume+timestamp of the same bucket. Run the
Atlas series through `auditCandles(...)` — hard violations = an Atlas bug to fix;
zero hard violations with a price/level delta = provider origin (expected while
Databento is paused). The harness makes that determination mechanical.
