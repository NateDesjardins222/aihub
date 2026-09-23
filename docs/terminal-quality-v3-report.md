# Atlas — Product Rescue / Terminal Quality V3 — status report

**This is an honest interim report, not a completion claim.** The V3 brief is a
26-section rescue. This session fixed the P0 that mattered most — the phantom
−$45,000 — and a set of the explicitly-demanded visible drawing-UI defects, each
verified in a real browser and committed. Sections not yet done are listed
plainly at the end; nothing here is described as done that is not.

## Hashes
- **Starting baseline:** `1b42ca0` (V2 close).
- **Current tip:** `4afbf7b` on `claude/futures-trading-simulator-v8qefu`.
- `1b42ca0` is preserved; all work is additive commits on the branch.

## What was fixed (with evidence)

### Q-01 — the phantom −$45,000 (P0, Money) — FIXED
The money arithmetic and units were audited and are correct; −$45,000 is the
correct formula applied to a *garbage mark* (2,250 NQ points off). The wrong
price entered through two data-layer bypasses of the existing corroboration gate:
1. **Re-anchor during an open market** — after >120 s of feed silence a far
   price was accepted uncorroborated. Correct across a real session gap, wrong
   for an intraday feed hiccup. Now a re-anchor also requires the gap to have
   spanned a market-closed period (`getMarketState`); an intraday far price must
   corroborate like any other.
2. **Mid-only / crossed-book bypass** — integrity ran only when `last` was set,
   and `markPrice` averaged any bid/ask. Now the mid is gated too, and a crossed
   or one-sided book yields UNKNOWN, never a manufactured price.

Files: `apps/server/src/marketdata/{price-integrity,bus,quote-store}.ts`.
Reproduced (failing pre-fix) and pinned by `marketdata/mark-integrity-holes.test.ts`.
Full trace: `terminal-quality-v3-money-audit.md`. Valuation and the risk rules
were correct and left untouched (the stale-but-plausible mark must still price a
position and still be seen by risk — the max-loss-evasion invariant).
Verification: marketdata **95/95**; mark-dependent trading files in isolation
(pnl-reconciliation 12/12, rules.integration 14/14, engine 58/58, adversarial
10/10, determinism 3/3); server + web typecheck clean.

### Q-05 / Q-06 — position tool badges and labels (P2) — FIXED
Removed the LONG/SHORT pill (direction is already in the geometry — green profit
zone above the entry for a long, below for a short). At rest the tool now shows a
single small R:R on the entry line. The inspect readout is reduced to its two
essential questions — points and R:R — with ticks, money and price opt-in
(`POSITION_OPTIONS` defaults). Verified in a real browser
(`tools/position-visual-v3.mjs`): long green-above, short green-below, no pill,
`1.98R` at entry, selected readout `+32.25 pts  1.98R` / `−16.25 pts`, 0 page
errors. `apps/web/src/chart/drawings/{paint,registry}.ts`.

### Q-08 — cramped drawing menu (P2) — FIXED
The tools popover was a fixed 230 px; widened to 272 px. Verified to fit without
horizontal overflow from 1680 down to 1024 (popover right edge 321 px at both).

### Q-11 — monospace "engineering" look in the drawing UI (P2) — FIXED
Five drawing-UI elements still used JetBrains Mono (object-tree detail, menu
shortcut key, style-bar text, rail badge, width picker). All now DM Sans
(`var(--font-ui)`), with `tabular-nums` kept on the numeric ones. Canvas labels
were already DM Sans from V2. Verified in a real browser.

## Q-02 — locked while the position stayed open (P0, Risk) — PARTIALLY ADDRESSED
Two situations wore the same "locked" message:
- **Phantom lock** — the rules breached on the same garbage mark behind Q-01.
  **Removed by the Q-01 fix**: a garbage/unmarkable price can no longer become a
  mark, so it can no longer fabricate a breach or a lock.
- **Genuine locked-but-open** — a real breach whose liquidation cannot fill on a
  stale/closed feed. This is *correct* engine behaviour (fixed by
  `rules.integration.test.ts`); a fresh breach that *can* fill liquidates to flat
  (`adversarial.test.ts`). The remaining work is UI communication only —
  surfacing `liquidation: PENDING | DONE | NOT_REQUIRED` so the trader is never
  shown a bare "locked" while exposure is still open. **Not yet implemented.**
  Design in `terminal-quality-v3-risk-lock-audit.md`.

## Verification (whole-suite)
- Web unit: **247/247** (18 files). Web typecheck clean. Web production build OK.
- Server: **430/437**; the 7 failures are the pre-existing full-directory
  nondeterministic family (determinism ×3, engine trailing-anchor / event-
  pressure, rules.integration trailing-floor / breach-cancel). Every one of
  those files passes 100% in isolation, both with and without this session's
  change; the same family failed on the untouched baseline (a different
  overlapping set), i.e. shared-DB/timing nondeterminism, not this work. This is
  reported, not dismissed — see the money-audit's verification note.
- Server typecheck clean.

## Not done this session (honest backlog)
These V3 sections remain open and are **not** claimed:
- Q-02 residual (liquidation-pending UI surfacing) — §2/§16/§17.
- Q-03 market-motion refresh, Q-04 candle-parity refresh — §3/§4 (largely covered
  by V2's `-market-motion.md` / `-candle-audit.md`; a V3 refresh is pending).
- Q-07 position price-travel visualization — §9.
- Q-09 drawing tool catalog expansion (channels, pitchfork, brushes, arrow marks,
  shapes, projection, volume, measurer) — §11.
- Q-10 text hitbox to rendered bounds — §12.
- Q-12 editing UI / floating toolbar rebuild — §13.
- Q-13 feedback/gamification spec + implementation — §15
  (`atlas-feedback-and-gamification-spec.md` not yet written).
- Q-14 custom "MY TOOLS" — §14.
- The professional execution + drawing torture passes and the full responsive/
  performance sweeps — §18–22.

## Scope guard (§23) — honoured
No changes to Whop/payments/payouts, Databento auth (no credentials requested),
live brokerage, OCC, new products, marketing, AI, or backtesting.
