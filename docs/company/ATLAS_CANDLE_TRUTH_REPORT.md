# ATLAS CANDLE TRUTH REPORT

**Engineering Phase A, Part I.** The objective answer to "are Atlas candles the correct market bars".
Measured mechanically with `scripts/bar-truth.ts` against the live dev provider (Yahoo), comparing the
raw vendor payload to Atlas's normalized bars minute-by-minute (no sampling). Companion:
`ATLAS_MARKET_DATA_PIPELINE.md`, `ATLAS_CONTRACT_POLICY.md`.

> **Headline:** At the provider boundary, Atlas is **faithful** — no wrong OHLC, no wrong volume, no
> timestamp shift, no duplicates, no wrong contract math. The visible "wrong candles / gaps / fewer
> bars" the owner reports are driven by **(a) the dev data source** (Yahoo free 1m has ~3–4% `null`
> minutes in RTH and far more overnight → real gaps + fewer bars than a professional feed) and
> **(b) continuous front-month `=F`** vs a reference showing a specific/back-adjusted contract. One
> genuine client robustness bug (`applyHistory` did not order/de-dup before rendering, which can freeze
> lightweight-charts) was found and **fixed** at root cause. **External reference-platform (e.g.
> TradingView) parity is NOT tested here and remains UNVERIFIED — it needs Nathan's eyes or a licensed
> feed.**

## Measured parity (72h window ending Fri 2026-09-25 17:00 ET; 1m)

| Symbol | Vendor | Raw grid minutes | Normalized bars | Value mismatches | Extra bars | Null minutes dropped |
|---|---|---|---|---|---|---|
| NQ | NQ=F | 1810 | 1741 | **0** | **0** | 69 |
| ES | ES=F | 1809 | 1740 | **0** | **0** | 69 (+1 trailing live) |
| GC | GC=F | 1809 | 1748 | **0** | **0** | 61 (+1 trailing live) |
| CL | CL=F | 1809 | 1748 | **0** | **0** | 61 (+1 trailing live) |

Every minute the vendor returned with real OHLC matched Atlas's normalized bar exactly (within
tick-snap). Every dropped minute was a vendor `null` (no data) or the trailing live-price row — never a
fabricated or corrupted candle.

## The 27 questions

1. **Exact provider for dev candles?** Yahoo Finance public chart endpoint `/v8/finance/chart` via `YahooDelayedProvider` (~601s delayed, OHLCV only, no book).
2. **Exact provider symbol per Atlas symbol?** `=F` continuous: NQ/MNQ→`NQ=F`, ES/MES→`ES=F`, GC/MGC→`GC=F`, CL/MCL→`CL=F`.
3. **Continuous or contract-specific?** **Continuous front-month** for all eight (Yahoo `=F`). Micros share the mini series. See ATLAS_CONTRACT_POLICY.md.
4. **Timezone of raw timestamps?** Epoch **seconds** (exchange-absolute). Yahoo `meta.exchangeTimezoneName` is `America/New_York` but is used only for display, not to shift bar time.
5. **Open-time or close-time timestamp?** **Open-time** (bucket start), end to end.
6. **Where is timezone conversion performed?** Only at **display** (axis tick labels + legend), client-side. The numeric bar time is never offset.
7. **Where is session filtering performed?** Nowhere on bars. `includePrePost=true`; no RTH/ETH keep-drop. Session windows only align coarse-TF buckets.
8. **Where is aggregation performed?** **Server-side** (`foldBars`) from a 1m base. The client never aggregates.
9. **Does the client alter bars?** Only: `applyHistory`/`prependHistory` order + de-dup (safety), the forming bar's close/high/low updated from live quotes, opt-in Heikin-Ashi, and SMOOTH easing of the forming bar's close. **Historical OHLC and timestamps are never altered.**
10. **NQ raw/server/client parity?** Raw 1810 grid → 1741 normalized, **0 value mismatch, 0 extra**; 69 vendor-null minutes dropped. Faithful.
11. **ES?** 1809 → 1740, 0/0; 69 null + 1 trailing. Faithful.
12. **GC?** 1809 → 1748, 0/0; 61 null + 1 trailing. Faithful.
13. **CL?** 1809 → 1748, 0/0; 61 null + 1 trailing. Faithful.
14. **Any missing bars?** Yes — ~60–69 per ~1810 (≈3.4–3.8%) in this RTH-heavy window; more overnight.
15. **Why missing?** The **vendor returned `null` OHLC** for those minutes (Yahoo free-feed sparsity / thin no-trade minutes). Atlas drops them rather than fabricate. Classification: `PROVIDER_DID_NOT_RETURN_BAR` / `NO-TRADE`. Legitimate gaps, not a code loss.
16. **Any duplicates?** None from the vendor in the measured windows (`raw-duplicates=0`); the client now collapses any that ever appear.
17. **Any timestamp shifts?** **None.** Bars are open-time epoch throughout; no double conversion, no tz offset on data.
18. **Any wrong OHLC?** **None** (0 value mismatches across NQ/ES/GC/CL, thousands of minutes).
19. **Any wrong volume?** **None** observed; volumes carried through unchanged (trailing volume-0 live row correctly excluded).
20. **Any wrong contract mapping?** No mis-map, but a **policy fact**: all symbols are continuous `=F` and micros share the mini series (documented, not a defect).
21. **Any session-boundary errors?** None found; no server session filter, coarse-TF bucket alignment uses the instrument's Globex/Chicago windows.
22. **Any aggregation errors?** None found; folding is server-side from 1m (existing `handoff`/`fold` tests + candle-integrity cover open=first/high=max/low=min/close=last/volume=sum).
23. **Why did previous visual comparison look wrong?** Most likely, in order: (a) **continuous `=F`** vs a reference on a specific/back-adjusted contract → different O/C and roll jumps; (b) **vendor null minutes** → gaps and fewer candles than a pro-fed reference ("~twice as many candles" on the reference is consistent with Yahoo's overnight sparsity); (c) **open- vs close-time labeling** → a one-interval apparent shift; (d) the `applyHistory` ordering bug could freeze/misplace candles when a page arrived unordered/duplicated.
24. **Root cause(s) found?** (1) Data-source fidelity (Yahoo free 1m nulls) — *source limitation*. (2) Continuous front-month contract policy — *documented policy*. (3) `applyHistory` lacked the sort/de-dup `prependHistory` has — *genuine client bug*. (4) Open- vs close-time labeling — *convention*.
25. **Root cause(s) repaired?** (3) **fixed** — `applyHistory` now runs `orderBarsAscendingUnique` (own module + regression test `chart/bar-order.test.ts`). (1)(2) are inherent to the dev source/policy and are documented, not "fixed" by altering data (that would be dishonest); they resolve when a licensed provider is configured. (4) intentionally unchanged (changing bar time would corrupt everything); documented.
26. **What remains unverified?** **External reference-platform parity** (Atlas vs TradingView/broker on the same contract/session) — no external reference is available headless. Overnight/ETH null-rate and roll-boundary appearance are characterized but not visually A/B'd.
27. **What will require Nathan's visual comparison later?** Side-by-side Atlas vs his reference platform, **matching the contract** (specific month or the reference's continuous rule) and the **timestamp-label convention**, to confirm the residual differences are exactly the data-source + contract-policy effects described here and nothing else.

## Status

- **EXTERNAL REFERENCE PARITY: UNVERIFIED** (honestly — needs Nathan or a licensed feed).
- **PROVIDER-BOUNDARY FIDELITY: VERIFIED** (0 value mismatches, 0 shifts, 0 fabrication across NQ/ES/GC/CL).
- **Client ordering robustness: FIXED + regression-tested.**
