# Atlas — Terminal Quality V3 (Product Rescue) — defect ledger

Append-only. Starting baseline `1b42ca0`. Branch
`claude/futures-trading-simulator-v8qefu`.

The user manually used Atlas after the V2 milestone and found severe defects that
automated tests had passed over. **Manual product experience outranks prior
acceptance claims.** P0 correctness (money, risk) is fixed before any visual
work. Nothing here is marked done until reproduced and, for visual/interactive
items, inspected in a real browser.

**Severity:** P0 money/account/risk/execution corruption · P1 major trading/
product failure · P2 major UX/visual defect · P3 polish.

**Status:** REPRODUCED · ROOT_CAUSED · FIXED · VERIFIED · DEFERRED · NOT_REPRODUCED.

| ID | Sev | Area | Symptom (user) | Status |
| --- | --- | --- | --- | --- |
| Q-01 | P0 | Money | Account displayed ≈ −$45,000, never earned | FIXED |
| Q-02 | P0 | Risk | "Trading locked for the day" while the position stayed OPEN | ROOT_CAUSED |
| Q-03 | P1 | Market motion | Price updates feel dead/slow | (measuring) |
| Q-04 | P1 | Candles | Candles disagree with the reference platform | (parity audit) |
| Q-05 | P2 | Position tool | LONG/SHORT badges look bad — remove them | (open) |
| Q-06 | P2 | Position tool | Planning labels look like debug output | (open) |
| Q-07 | P2 | Position tool | No price-travel visualization after creation | (open) |
| Q-08 | P2 | Drawing menu | Tool panel too cramped | (open) |
| Q-09 | P2 | Drawing tools | Most requested TradingView tools still missing | (open) |
| Q-10 | P2 | Text tool | Hitbox still undersized | (open) |
| Q-11 | P2 | Typography | Monospace/engineering fonts remain in drawing UI | (open) |
| Q-12 | P2 | Editing UI | Floating toolbar / settings look low quality | (open) |
| Q-13 | P3 | Feedback | Terminal feels dead; needs restrained alive feedback | (spec) |
| Q-14 | P3 | Custom tools | No trader-created tool presets ("MY TOOLS") | (design) |

## Detail

### Q-01 — phantom −$45,000 (P0, Money) — FIXED

Full trace in `terminal-quality-v3-money-audit.md`. The money arithmetic and
units are correct; −$45,000 is the correct formula applied to a *garbage mark*
(2,250 NQ points off). Root cause was two data-layer bypasses of the existing
corroboration gate: (1) an uncorroborated **re-anchor during an open market**
after an intraday feed silence, and (2) a **mid-only / crossed-book** quote
skipping integrity and marking off `(bid+ask)/2`. Both fixed in the marketdata
layer (`price-integrity.ts`, `bus.ts`, `quote-store.ts`); valuation and rules
were correct and untouched. Reproduced (failing pre-fix) and pinned by
`apps/server/src/marketdata/mark-integrity-holes.test.ts`.

### Q-02 — locked while the position stayed open (P0, Risk) — ROOT_CAUSED

Full trace in `terminal-quality-v3-risk-lock-audit.md`. Two distinct situations
wore the same "locked" message:

1. **Phantom lock** — the rules breached on the same garbage mark behind Q-01, so
   the account was locked on a loss that never happened. **Removed by the Q-01
   fix**: an unmarkable/garbage price no longer becomes a mark, so it can no
   longer fabricate a breach.
2. **Genuine locked-but-open** — a real breach fires, but the liquidation cannot
   fill because the feed is stale/closed. This is *correct* engine behaviour
   (fixed by `rules.integration.test.ts`); the defect is UI communication — the
   trader sees a bare "locked" with no signal that exposure is still open and a
   liquidation is pending. The engine-side surfacing of
   `liquidation: PENDING | DONE | NOT_REQUIRED` and the non-liquidating
   (`flattenOnBreach:false`) wording remain to implement (this is the remaining
   Q-02 work; a fresh breach that *can* fill already liquidates to flat, proven
   by `adversarial.test.ts`).
