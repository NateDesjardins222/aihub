# Atlas — Charting Tools Visual Rebuild + Market Motion/Candle Correction V2 — defect ledger

Append-only working ledger. Starting baseline `26d176c` (tip of
`claude/futures-trading-simulator-v8qefu` at milestone start; the prompt cited
`69efc6d`, the Terminal Correction V1 close — the branch has since advanced one
commit, the zoom-out fix `26d176c`, which is the true starting point).

**States:** `REPRODUCED` · `ROOT_CAUSED` · `FIXED` · `VERIFIED` · `BLOCKED` ·
`DEFERRED`. No vague "improved". A visual/interactive defect is `VERIFIED` only
with a real-browser check and, where the reference screenshots apply, a
side-by-side visual comparison.

The reference screenshots supplied by the user (TradingView drawing-tool menu,
three panels) are product requirements for this milestone, not decoration.

| ID | Area | Symptom (user) | State |
| --- | --- | --- | --- |
| V-01 | Fib | Prices shown beside levels by default; dated typography | FIXED + VERIFIED (browser) — percent-only default, DM Sans |
| V-02 | Long/Short | Long and Short look the same; spawn crushed; redundant numbers | FIXED + VERIFIED (browser) — badge + scale-aware + minimal labels |
| V-03 | Tool menu/icons | Menu doesn't match reference; feels like a prototype | FIXED + VERIFIED (browser) — reference categories, native icons, shortcuts |
| V-04 | Typography | Monospace/geeky fonts; canvas labels not even DM Sans | FIXED + VERIFIED — one labelFont() helper; fixed broken `var()` fonts |
| V-05 | Number formatting | Numbers shown just because the engine has them | FIXED — Fib percent-only, Long/Short money off by default; no µ$ in UI |
| V-06 | Market motion | Visible price feels stationary/slow | ROOT_CAUSED (measured) — provider cadence ~6 s; see market-motion doc |
| V-07 | Candles | Candles still don't look correct vs reference | AUDITED (live, fresh) — data/agg/render sound; residual is provider origin (class C) |
| V-08 | Missing tools | Many TradingView tool families absent | PARTIAL — added Cross Line, Horizontal Ray, Arrow; rest DEFERRED (see report §4) |

## Detail

### V-01 Fibonacci — FIXED, VERIFIED
Reproduce: a fresh Fib showed "23.6% 30824.90" — percent AND price. Root cause:
`registry` default `showPrices: true`; label built `parts=[percent, price]`
(`paint.ts`). Fix: default `showPrices: false` (opt-in), so the default label is
the percentage alone (0.0%…100.0%), in DM Sans (see V-04). Verified in browser
(`cvr-fib-selected.png`): percentage-only, clean, level lines span the object.

### V-02 Long/Short — FIXED, VERIFIED
Reproduce: both spawned a fixed 20/40 ticks tall (looked crushed) and were hard
to tell apart. Fix: `positionAnchors` sizes the box to the visible price range
(stop ≈ 8 % of height, target 2×, floored at 20 ticks); a LONG/SHORT colour
badge on the entry line; money label off by default. Verified in browser
(`cvr-long-selected.png` / `cvr-short-selected.png`): long = green target above /
red stop below + LONG badge; short = mirror + SHORT badge; labels show pts, R,
ticks — no dollars.

### V-03 tool menu + icons — FIXED, VERIFIED
Reproduce: six ad-hoc categories, no shortcuts. Fix: categories renamed/ordered
to the reference (Lines/Arrows/Shapes/Fibonacci/Projection/Annotation/Measurer),
row = native SVG icon + name + right-aligned shortcut + favourite; unbuilt
families deferred (report §4), not shown as dead rows. Verified in browser
(`cvr-tool-menu.png`).

### V-04 typography — FIXED, VERIFIED
Reproduce/root cause: canvas `ctx.font` cannot resolve CSS `var()`, so
TEXT/MEASURE/RECTANGLE labels set with `…px var(--font-ui)…` silently fell back
to the 10px default; Fib/priceTag/position used `ui-monospace`. Fix: one
`labelFont()` helper returning a literal DM Sans stack, used by every label.

### V-05 number formatting — FIXED
Fib percentage-only; Long/Short money off by default; measure keeps money in its
own chip; no internal micro-dollar values reach the UI (position money formats
from `tickValue` dollars, not micros). Precision is per pricePrecision / ticks.

### V-06 market motion — ROOT_CAUSED (see charting-visual-rebuild-v2-market-motion.md)
Measured: provider `observedCadenceMs` ≈ 5.3–6.9 s (a new price every ~6 s);
vendor delay ~601 s; Atlas dedupe/quarantine drop only ~1.3 % combined; no hidden
throttle; aggregator emits per price. Answer: the chart feels slow because the
free Yahoo feed only publishes ~every 6 s and the SMOOTH easing spreads each over
≤1.2 s. Provider-bound; the pro feed (paused) is the fix.

### V-07 candles — AUDITED (see charting-visual-rebuild-v2-candle-audit.md)
Fresh live pull of 31 consecutive NQ 1m bars: 0 OHLC violations, 0 integrity
violations, exact 60 s spacing, no gaps/dupes, valid forming bar. Renderer is
lightweight-charts native (sharp). Residual vs a realtime reference is class C
(delayed continuous `=F`), not an Atlas defect.

### V-08 missing tools — PARTIAL
Added and fully wired (model/paint/hit-test/registry/icon/persist): Cross Line,
Horizontal Ray, Arrow. Deferred with reason in report §4: channels, pitchforks,
brushes, arrow-marks, rotated rectangle, path, circle, forecast, bars pattern,
ghost feed, projection, anchored VWAP, fixed-range volume profile, price/date
range measurers, info line, trend angle.
