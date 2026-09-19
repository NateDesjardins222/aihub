# Atlas — Trading & Execution Experience V2: the plan

Written before the execution surface is changed, from the code as it stands at
`2b64acf` and from the baseline runs recorded at the end of this document.

The milestone's question is not "what is missing". It is:

> Can an experienced futures trader enter, manage and exit positions on Atlas
> for six hours without friction, confusion, incorrect state, visual irritation
> or the fear that Atlas is lying about their position?

Everything below is aimed at that sentence. Where this plan says a thing is
weak, it is weak in the code I have read or in a number I have measured, and it
says which.

---

## 1. The execution architecture as it is

Atlas is a pnpm workspace. Three parts matter here.

**`apps/server/src/trading/engine.ts` (2,581 lines) — the only thing that can
create money.** Every mutation runs through `KeyedMutex.run(accountId, …)`, so
one account's submissions, cancels, modifications and matcher passes are
serialised against each other while different accounts run concurrently. The
public surface is small:

| method | what it does |
| --- | --- |
| `submitOrder` | validate, persist, match immediately, schedule an eligibility wake |
| `modifyOrder` | patch qty/limit/stop/trail under an optimistic `version` |
| `cancelOrder` / `cancelAll` | cancel one, or every working order (optionally per symbol) |
| `flatten` | cancel protection, then a market order for the whole position |
| `reverse` | cancel protection, then a market order for **twice** the position |
| `setProtection` | attach, move or remove the SL/TP of an open position |
| `runMatch` | run the matcher for one account and symbol |

**`apps/server/src/trading/risk.ts` — why an order is refused.** `checkOrder`
returns a reason code and a human sentence; the engine records it and throws
`OrderRejectedError`. The codes already include `MARKET_CLOSED`,
`MARKET_DATA_STALE` and `POSITION_FROM_ANOTHER_MARKET`.

**`apps/web/src/trading/store.ts` — the client's copy, and only a copy.** It
subscribes to five account channels (`acct.<id>.orders`, `.positions`,
`.executions`, `.trades`, `.pnl`), treats any frame as "something changed", and
**re-reads authoritative state over REST** rather than trusting the frame's
payload. That is the right shape and this milestone keeps it.

### Authority boundary, stated plainly

| the browser may decide | the server alone decides |
| --- | --- |
| what the trader is *asking* for | whether the order is accepted |
| where a line is while a finger is on it | where the order actually is |
| when to show "sending…" | whether anything filled, and at what price |
| what to draw, and how fast | quantity, average entry, realised and unrealised P&L, fees, balance, equity |

The rule this milestone enforces everywhere: **the browser may express intent
instantly; it may never express an outcome it has not been told.**

---

## 2. Lifecycles

### Order

The contract (`packages/contracts/src/trading.ts`) already carries the full
set: `CREATED → VALIDATING → WORKING → PARTIALLY_FILLED → FILLED`, with
`CANCEL_PENDING → CANCELED`, `REJECTED` and `EXPIRED` as the other endings;
`TERMINAL_ORDER_STATUSES` names the four that end it.

What the **browser** models today is thinner than that: `OrderTicket` has one
boolean, `busy`, covering the whole round trip, and the blotter shows only what
the server has already written. There is no client-side notion of "this
submission is in flight", which is what §2 of the brief asks for.

### Fill

`submitLocked` inserts the order, marks the account/symbol as working, audits
`ORDER_SUBMITTED`, and calls `matchLocked` immediately so a market order does
not wait for the next poll. An order whose simulated latency (`env.latencyMs`)
has not elapsed is left working and a wake is scheduled for `eligibleAt`.
Fills are executions rows; the position, trades, balance and valuation all
derive from them server-side.

### Position

`positions` carries `qty`, `avgEntryTicks`, realised P&L, fees and
`marketEra`. The era guard refuses to price an order against a market the
position was not opened in — a backstop that exists because filling there would
realise a fabricated result into a balance.

### Bracket

Two routes reach the same place. A bracket **submitted with an entry**
(`bracketConfig` on the entry order) creates the legs when the entry fills; a
bracket **attached to an open position** (`setProtection`) creates ordinary
working orders in an OCO pair. Both are resized when the position changes and
cancelled when it closes (`syncProtection`, `syncBrackets`). Dragging a level
on the chart calls `setProtection`, so the chart drags the real order.

### Chart interaction

`apps/web/src/chart/PriceMarkers.tsx` (993 lines) draws position, order, stop
and target markers as DOM over the canvas, with the animation frame writing a
`--leader` custom property so a label can be nudged off its own rule without
re-rendering React. Dragging a protective level already goes to the server on
release. There is no right-click order entry from a price.

---

## 3. Current weaknesses

Each of these is something I have read in the code or measured. None is a
guess, and each names what will be done about it.

1. **Duplicate submission is guarded by a React state flag.** `OrderTicket.run`
   sets `busy` and the buttons are `disabled={!ready}` — but `setBusy(true)` is
   asynchronous, and every call to `submit()` mints a **fresh**
   `newClientOrderId('ticket')`. The server's idempotency is keyed on that id,
   so two clicks inside one React batch are two different keys and therefore two
   real orders. The server is not wrong; the client is throwing away the very
   thing that would protect it. → an in-flight guard that is synchronous, and
   one idempotency key per *intent* rather than per call.
2. **Intent, acknowledgement and fill are one boolean in the UI.** Nothing
   distinguishes "sent" from "the server has it" from "it filled". → a small
   client-side pending-order model, rendered in the ticket and the blotter,
   that is *always* superseded by server state.
3. **No one-click mode, and no way to say you want one.** Submission is already
   immediate (no confirmation dialogs), which is half of what the brief wants;
   what is missing is the explicit setting and the protection that goes with it.
4. **No break-even, no quick partials, no scale helper.** A trader reducing a
   position today edits the quantity by hand and presses the other side.
5. **Rejections are shouted enum plus sentence.** `OrderTicket` prints
   `err.code.replace(/_/g, ' ')` in front of the server's message — "MARKET
   CLOSED: …". The reason is honest; the presentation is not finished.
6. **No trading audio at all.**
7. **The position planning tool is always at full volume.** `drawPosition`
   paints both zones, the entry line and up to three labelled rows whatever the
   drawing's state — and `PaintState` already carries `HOVER`, unused by this
   tool. The brief wants geometry at rest and numbers on inspection.
8. **The account metric boxes are not optically centred**, per manual review.
9. **Execution latency has never been measured.** The performance baseline
   covers chart interaction; nothing measures click → ack → fill → painted.
10. **A late authoritative read can land on the wrong account.**
    `useTrading.readAll(accountId)` issues six REST reads and then `set(...)`s
    the result **unconditionally**. `refresh()` captured the account id when it
    started; `attach()` clears state when the trader switches. So the sequence
    *switch account → the previous account's read resolves* writes account A's
    orders, positions, trades, executions and P&L into a terminal that is now
    showing account B. `refreshPnl()` has the same shape. This is precisely the
    hazard §17 of the brief describes, it is in the code today, and it is the
    first thing this milestone fixes — with a guard on the way in, and a
    browser test that switches accounts with a read deliberately held in
    flight.

    The market-data path already solved this (`loadTokenRef` in `ChartPanel`
    discards the answer to a question nobody is asking any more). The trading
    store never got the same treatment.

---

## 4. Implementation order

The order is chosen so that measurement exists before the thing being measured
is changed, and so that correctness work lands before cosmetic work.

1. **Instrument the execution path.** Client stamps, server timings, and a
   measured baseline of submit → ack → fill → painted, with provider delay held
   separately. Nothing to fix until this exists.
2. **The lifecycle model in the client.** Pending submissions, acknowledgement,
   fill, reconciliation — and the synchronous duplicate guard, which is the one
   correctness bug already identified by reading.
3. **Position management:** break even, quick partials, scale-in correctness,
   flatten/reverse races, orphan-bracket hunting.
4. **The execution torture test**, asserting financial state rather than HTTP
   status, and the isolation work (account, symbol, multi-account, reconnect
   during every stage) that it will expose.
5. **P&L reconciliation** across all eight instruments, and rejection wording.
6. **Trading audio**, triggered from the authoritative event only.
7. **The Long/Short position tool**, including the hover behaviour.
8. **Typography, centring and the alignment audit.**
9. **Gates, endurance, the manual pass, the report.**

---

## 5. Stress strategy

The previous milestone's lesson holds: *asserting that a request returned 200
proves nothing about money.* Every stress check here asserts a financial or
lifecycle fact, read back from the server.

* **Combination sweep.** Submit, cancel, modify, scale, partial, flatten,
  reverse, SL move, TP move — in randomised but *seeded* sequences so a failure
  can be replayed exactly. After each sequence the terminal's view and the
  engine's view must agree on quantity, average entry, working orders, realised
  and unrealised P&L.
* **Race pairs.** Two actions issued deliberately close together: flatten while
  a stop is filling, cancel while a modification is in flight, reverse during a
  partial fill, account switch during submission, symbol switch during a
  protective drag.
* **Invariants checked after every operation**, not just at the end: no working
  order without a position to protect; no position without its brackets sized to
  it; no order in a terminal state still counted as working; `sum(fills) ≡
  position + trades`.
* **Resource watch during the sweep:** DOM nodes, canvases, listeners, timers,
  sockets, subscription count — a leak that only appears under execution load is
  exactly what a six-hour session would find.

---

## 6. Measurement strategy

* **Execution latency** is measured in segments, so a slow number names its own
  cause: `input → handler` (browser), `handler → server received`, `server
  validation`, `server → fill`, `fill → socket frame`, `frame → state`, `state →
  painted frame`. Reported as p50/p95/p99/worst over hundreds of orders.
* **Provider delay is never folded into that.** The feed's ~602s upstream delay
  is a property of the market data, not of Atlas, and mixing them would hide
  both.
* **The performance gate is extended, not replaced**, with order drag, SL drag,
  TP drag, position-tool hover and position-tool drag. The gate's over-50ms rule
  re-measures before it accuses — that correction was made at the end of the
  last milestone and stays.
* **The visual gate is extended** with execution states, and must be shown to
  fail on a deliberate change before it is trusted.

---

## 7. Manual acceptance strategy

At least 150 execution-focused checks, each of which performs a real
interaction and reads back a consequence that would differ if the interaction
had not worked. Not a repeat of the previous milestone's 159 — those covered
chart, drawings and chrome; these cover entry, management and exit.

The full trader walkthrough runs on NQ first and then, where practical, on MNQ,
ES, MES, GC, MGC, CL and MCL: buy, verify the authoritative fill, hear it, move
a stop, move a target, scale in, check the average entry, take a partial, check
the brackets resized, flatten, hear it, verify flat with no orphan orders, and
then find the same trade in the blotter and the journal with the same numbers.

---

## 8. Baseline, recorded before any change

_(filled in from the Phase 0 runs; see the completion report for the after.)_
