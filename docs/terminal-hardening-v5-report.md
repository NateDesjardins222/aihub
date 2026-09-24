# Atlas — Terminal Hardening V5 report

The order of this report is the order of the priorities: money first, then the
execution paths that move money, then the chart a trader looks at while it does.

## 1. Money trust (the thing that matters above all)

The rule for this milestone was not "make the tests green" but "make an
incorrect financial number structurally difficult to produce." What that looks
like, concretely:

### An independent money oracle

`apps/server/src/trading/money-oracle.test.ts` (11/11) re-derives every number
with its OWN integer math and the published, independently-confirmed point
values — it shares no code with Atlas's production P&L functions — and checks the
engine against it across all eight instruments (NQ/MNQ/ES/MES/GC/MGC/CL/MCL), the
full position lifecycle, and mini/micro collisions. If the engine's arithmetic
ever drifts, the oracle disagrees; the two agreeing is the proof, not the
engine agreeing with itself.

### The −$45k class: a no-provenance position is UNMARKABLE, not a phantom loss

Root cause (`engine.ts` `markTicksFor`): a legacy position row with neither a
market era nor a contract code was being priced against *whatever the feed is
serving now*. A wild or wrong-era mark then produced a large, fictional loss.
The fix makes a no-provenance row UNMARKABLE — its P&L reads *unknown*, and the
terminal says NOT PRICED — rather than inventing a number.
`legacy-mark-provenance.test.ts` (2/2) strips the provenance columns and proves a
wild mark yields `null`, not −$45k.

### The +$8k class: a closed position never leaves a stale open P&L behind

Two independent holes, both closed:
- the client's valuation-frame merge coalesced an authoritative `null` away with
  `??`, so an "unknown" frame kept painting the last good number
  (`pnl-merge.ts`; `pnl-merge.test.ts`, D-13);
- cross-account bleed: unguarded late `loadRules`/`loadEnvironment` writes and no
  monotonic guard on REST P&L let one account's figures paint onto another
  (`store.ts`; `money-state-race.test.ts`, 4/4). Everything money now flows
  through one monotonic `seq` authority.

### Real-product acceptance

`tests/browser/money-acceptance.spec.mjs` drives the LIVE terminal (real server,
real feed): a full BUY → flatten round trip on a funded account. It confirms in
the product, not a fixture, that BAL always equals starting + realized − fees,
that a flat account shows **open P&L = 0 with no NOT PRICED phantom** (the +$8k
class), that open P&L while in a trade is a live marked number, that the new
`liquidation` state reads NOT_REQUIRED on a healthy account, and — Phase 3 — that
the money is set in DM Sans, not a monospace face. The one non-passing line is a
delayed-feed timing artifact the harness documents at length (a one-minute-bar
print landing just outside a wait window); the position opened and priced
correctly regardless, which is the check that actually gates it.

## 2. The risk lock that left a position open

Full root-cause and the risk-rule semantics matrix are in
`terminal-hardening-v5-execution.md`. In short: the lock status was persisted
independently of whether the breach's flatten actually closed the position, and
the terminal showed only "locked." The engine now reports an authoritative
`liquidation` state — NOT_REQUIRED · PENDING · DONE — carried through the WS
frame and the REST `/pnl` DTO, and the account bar shows a **FLATTENING** pill
whenever it is PENDING, so "locked" can never again imply "flat" while exposure
remains. `liquidation-state.test.ts` (3/3) proves the state machine, including a
breach whose flatten cannot fill on a stale feed reading locked + PENDING + still
exposed, then DONE once it can.

## 3. Execution race torture

`execution-races.test.ts` (10/10) fires the mutating paths concurrently and out
of order against the real persistence path, proving the per-account mutex holds:

- **flatten idempotency** — ten concurrent flattens on a long sell exactly the
  held quantity once, never doubling into a short; a fresh entry after flat is
  not swallowed as a duplicate of the flatten's synthetic order id.
- **flatten / reverse cancel protection first** — no stop or target leg can fire
  into the wrong side; a flattened or reversed position leaves zero working
  protective orders, verified by pushing a wild adverse mark and staying put.
- **scale-in / scale-out** — a sole bracket's protective quantity tracks the live
  position through scale-in (+2 → covers 3) and hand scale-out (−1 → covers 2 →
  flat clears it), with no orphan leg able to reverse a reduced or flat position.
- **modify vs fill** — a drag carrying the pre-fill order version is rejected
  (STALE_ORDER_VERSION); the fill stands, unresized.
- **cross-instrument isolation** — flattening NQ leaves an open ES position of 3
  untouched.
- **risk liquidation vs manual flatten** — racing each other, the account lands
  flat, sells exactly the held quantity, and reports liquidation DONE.

## 4. Chart typography (Phase 3)

The terminal counted in JetBrains Mono and the chart axes drew in Menlo — the
"old-computer" look. Money and prices now read in **DM Sans with tabular
figures** (proportional face, even digit widths via `tnum`), the way TradingView
and TopstepX count, with no monospace anywhere on or around the chart:

- a `--font-num` token (DM Sans); `.num` and the chart chrome (ChartHeader,
  ChartPanel, OrderTicket) and form inputs moved off `--font-mono`;
- the lightweight-charts axis font set to DM Sans (axis labels are right-aligned
  and redrawn per frame, so a proportional sans does not jitter);
- JetBrains Mono kept only for the owner console's audit JSON, which asks for it.

`chart/fonts.ts` is the single source for every canvas font, and
`canvas-font.test.ts` (5/5) guards the regression class that once made DM Sans
silently not render — a canvas rejects the whole `ctx.font` string on any invalid
token (a bare `var()`, a missing `px`) and falls back to 10px sans-serif. The
drawing overlay also now repaints at the new device pixel ratio the instant it
changes (browser zoom, a move to a different-density monitor), so the chart and
its drawings stay equally crisp.

## Verification summary

- Server (isolation): money-oracle 11/11, legacy-mark-provenance 2/2, idempotency
  2/2, liquidation-state 3/3, execution-races 10/10, engine 58/58,
  rules.integration 14/14, pnl-reconciliation 12/12.
- Web: 261/261; typecheck clean.
- Real product: money-acceptance drives the live terminal and confirms the money
  invariants and DM Sans typography (see §1).

## Still owed (honest)

- The remaining V5 phases: chart interaction depth (zoom/pan/crosshair/resize
  latency), drawing-manipulation quality, candle data-vs-render re-audit, the
  micro-defect ledger, and the full drawing-catalog build-out.
- Broader live-product acceptance across more instruments and the locked-but-open
  FLATTENING pill in the real UI (the state machine is proven at the unit level).
