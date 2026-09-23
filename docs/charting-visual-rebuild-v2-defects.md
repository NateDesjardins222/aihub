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
| V-01 | Fib | Prices shown beside levels by default; dated/cramped typography; incoherent stretch; clunky selection; oversized toolbar | (in progress) |
| V-02 | Long/Short | Long and Short look the same; spawn crushed; random redundant numbers; ugly type | (in progress) |
| V-03 | Tool menu/icons | Menu doesn't match reference categories; icons generic; feels like a prototype | (in progress) |
| V-04 | Typography | Monospace/geeky fonts, inconsistent weights, oversized/cramped labels across drawings | (in progress) |
| V-05 | Number formatting | Numbers shown just because the engine has them; micro-dollar/floating-point leakage | (in progress) |
| V-06 | Market motion | Visible price movement feels stationary/slow | (in progress) |
| V-07 | Candles | Candles still don't look correct vs reference platform | (in progress) |
| V-08 | Missing tools | Many TradingView tool families absent from Atlas | (in progress) |

## Detail

Entries are filled in as each defect moves through the states.
