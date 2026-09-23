# Atlas — V5 money audit: what could display −$45,000 (and why it can't now)

The trader saw ≈ −$45,000 on an account after trading, and ≈ +$8,000 on another
account. This is the written answer to **"what exactly could have displayed
−$45,000?"** — every money-math class audited to a verdict, an independent
oracle proving the arithmetic, and the one structural hole that remained, now
closed.

All money is integer micro-dollars (`MICROS = 1_000_000`). Every displayed
figure flows through ONE valuation: open P&L =
`markTicks·qty·tickValueMicros − costBasisMicros`
(`packages/core/src/position/position.ts`), equity = `balance + openPnl`
(`engine.ts` valuation). The instrument spec is always resolved from the
**position's own stored symbol** (`requireInstrument(row.symbol)`), never from
anything ambient.

## Per-class verdict

| # | Class | Verdict | Why |
| --- | --- | --- | --- |
| 1 | Wrong multiplier / unit (micros vs dollars vs cents) | **CLOSED** | One `ticksToMicros = ticks·qty·tickValueMicros`; integer micros end-to-end; no cents/dollars path coexists, so no 100×/1000× origin site. |
| 2 | Mini/micro confusion (NQ vs MNQ, …) | **CLOSED** | Spec is always the position's own symbol; a micro resolves the micro's `tickValueMicros`. Shared upstream feed is a *price* (index points), multiplier applied per position. Proven by the oracle's MNQ = NQ/10 case. |
| 3 | Quantity double-multiply / stale qty | **CLOSED** | `qty` enters each product exactly once; `position.qty` read under the account mutex. |
| 4 | Cost basis on scale-in / partial / reverse | **CLOSED** | Cost basis is a signed integer sum, not a float average; partial close retires a proportional slice, full close retires exactly, reverse gives the new side a **fresh** basis (old average can't leak). Proven by the oracle lifecycle. |
| 5 | Garbage / stale / wrong-era / crossed mark | **CLOSED (this milestone)** — see below | V3 closed the re-anchor + crossed-book/mid-only holes; the residual was legacy no-provenance rows, now fixed. |
| 6 | Duplicate fill / duplicate realized | **CLOSED** | `clientOrderId` idempotency; per-account mutex + single transaction; duplicate/out-of-order market events dropped at the bus. |
| 7 | Reverse / partial realized double-count | **CLOSED** | One realized figure per fill, applied once per tx. |
| 8 | null/unknown mark coerced to $0 | **CLOSED** | valuation propagates `null` (UNKNOWN); rules refuse to evaluate on a null mark. (Cosmetic residual: an incremental change-event view can momentarily show $0 open P&L, never a large figure, and never moves balance/equity/drawdown.) |
| 9 | Integer overflow / Number precision | **CLOSED by magnitude** | bigint(mode:number); worst-case notional within order limits ~1e14 micros, ≥3 orders of magnitude below `MAX_SAFE_INTEGER` (~9e15). |
| 10 | HWM / drawdown contamination from a bad mark | **CLOSED** for unmarkable (rules skip null marks); inherited class-5 residual now closed. |

## The one structural hole (now fixed) — the −$45,000 shape

`markTicksFor` (engine.ts) is the mark that applies to ONE position. It has an
era lock (a position opened in market era X is never marked at era Y's price)
and a contract lock (never marked by a rolled front month). **But both locks
were bypassed when the stored value was null** — a position with BOTH
`marketEra` null AND `contractCode` null ("mark as before") was priced against
whatever the current root feed serves, regardless of which market/contract it
was really opened in. A legacy pre-provenance row, or one marked while the
platform served a different era (e.g. a practice replay), then showed a
genuine-looking but wrong-basis price — the exact −$45,000 signature. The locks
were added *after* such rows could exist and did not retro-apply.

**Fix:** a position with no provenance at all is now **UNMARKABLE** — it reads
UNKNOWN (a dash) rather than being priced against the current feed. Every
position this engine opens records its era on open, so this only ever catches
genuinely pre-provenance rows, never a live trade; and it is not stuck —
flattening (an order, not a mark) clears it. `unmarkable()` now reports these
rows so the UI can say *why* the figure is a dash.

## Proof

- **Independent money oracle** (`money-oracle.test.ts`, 11/11): re-derives
  expected account money from first principles (published CME point values —
  NQ $20, MNQ $2, ES $50, MES $5, GC $100, MGC $10, CL $1000, MCL $100 — its own
  integer arithmetic, **no** Atlas P&L functions) and compares Atlas after every
  operation: all 8 instruments long/short at 1/2/5 contracts; the full
  scale-in → partial → reverse → flatten lifecycle for NQ and CL; and mini/micro
  isolation (MNQ P&L is exactly 1/10 of NQ). Zero divergence.
- **Legacy no-provenance regression** (`legacy-mark-provenance.test.ts`, 2/2):
  a wild feed price (would fabricate ≈ −$45,000) on a stripped-provenance row
  yields `openPnl = null` / `equity = null` / `unmarkable ≥ 1`, not a number;
  a row that still has its era is unaffected (guard is specific).
- Mark-dependent trading files pass in isolation with the fix: contract-lock
  3/3, pnl-reconciliation 12/12, rules.integration 14/14, engine 58/58,
  adversarial 10/10 (on retry — pre-existing timing flake). Server typecheck clean.

## Honest residuals (not −$45k class, tracked)

- **Two corroborating bad prints**: the integrity gate accepts a far move once a
  second observation agrees within tolerance, so a vendor streaming a *sustained*
  wrong-but-consistent series could be accepted. Mitigated by the contract lock
  for provenance-carrying positions; a proper second-source cross-check is future
  work (documented, not faked).
- **Live-product reproduction** of −$45k / +$8k is still owed once the browser
  harness is available in-container (Playwright is being killed this session).
  The P0 is not marked closed until that real-product pass runs; the deterministic
  proof above is necessary, not sufficient.
