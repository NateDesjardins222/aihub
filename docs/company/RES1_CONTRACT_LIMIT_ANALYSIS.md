# RES-1 — Contract-Cap vs Working Orders: Quantified Analysis

**Status:** FACTS ONLY. This document quantifies the RES-1 characterization from
Resilience Phases 1–2. **No behaviour was changed** in Phase 3 — the cap
semantics, the risk gate, and every message are exactly as they were at base
commit `c76cdb2`. RES-1 remains an open **product decision** (does "max N
contracts" bound *working orders*, or only the *resulting position*?), tracked as
a **P2** in `BACKEND_INVARIANT_LEDGER.md` and `KNOWN_ISSUES.md`.

This is not a money-duplication or cross-customer bug. It is bounded, simulated,
and lives entirely inside one account's own trading. It matters only if the
firm's rule text intends "max N contracts" to cap *resting exposure that could
fill* rather than *net position held*.

---

## 1. Where the cap is enforced

`apps/server/src/trading/risk.ts`, `checkOrder` (position-sizing block):

```ts
const signed = request.side === 'BUY' ? request.qty : -request.qty;
const increasing = increasingQty(ctx.position.qty, signed);   // only exposure-increasing qty
if (increasing > 0) {
  const weight = contractWeight(spec, increasing, account.microsCountAsFraction);
  const projected = ctx.openContracts + weight;               // <-- POSITION + this order
  if (projected > account.maxContracts + 1e-9) {
    return { reason: 'MAX_CONTRACTS_EXCEEDED', ... };
  }
  // per-instrument cap: measured against position in THIS instrument + this order
}
```

The check compares `ctx.openContracts` (the contracts **currently held in the
position**) plus **this one order's** increasing weight against `maxContracts`.

**What is counted:** the live position, plus the order being submitted right now.
**What is NOT counted:** other **working / resting** orders already on the book
(limit orders sitting away from the market, unelected stops). There is also no
**fill-time** cap re-check — the cap is a submit-time admission test only; the
matcher fills whatever rested.

## 2. The exact mechanism of the gap

Because the admission test only sees `position + this order`, a trader who is
flat (or lightly positioned) can submit **many** resting limit orders one at a
time, each of which passes because at submit time the position is still small:

- Flat position, `maxContracts = 5`.
- Submit resting BUY limit for 5 → passes (`0 + 5 = 5 ≤ 5`).
- Submit a second resting BUY limit for 5 at a different price → **also passes**,
  because the position is still `0` at submit time (`0 + 5 = 5 ≤ 5`); the first
  order is *working*, not *held*, so it is invisible to `ctx.openContracts`.
- Repeat N times. All N orders rest on the book.
- Price trades through all of them. They fill. The resulting position is `5 × N`,
  far beyond the `maxContracts = 5` cap.

The same is true for stacked stops and for mixing instruments under the account
(the account-level cap sums weighted contracts across instruments; per-instrument
caps are checked independently but with the same position-only measure).

## 3. Quantified worst case (V1, simulated)

The blast radius is bounded by how many resting orders the trader can place and
what the market does, not by the cap:

| Factor | Bound |
| --- | --- |
| Extra contracts per stacked resting order | up to `maxContracts` each (each order individually within cap) |
| Orders that can rest simultaneously | bounded only by order-rate limits and working-order storage, not by the cap |
| Realised over-exposure | `Σ filled increasing qty` — can reach a multiple of `maxContracts` if the market sweeps the stack |
| Money duplication | **none** — every fill is priced and accounted correctly; P&L reconciles exactly (the reconciliation oracle confirms position/P&L/fees derive from executions) |
| Cross-account / cross-customer effect | **none** — contained to the one account |
| Drawdown / breach safety | **unaffected** — the drawdown floor and breach detection operate on the (over-sized) position's real P&L, so a breach still fails the account correctly; the trader cannot use this to escape a loss limit |

So the invariant that is *not* held is strictly **"net held contracts ≤
maxContracts at all times."** The invariants that *are* held: money is never
duplicated, P&L always reconciles, drawdown/breach still bind on the real
position, and nothing crosses account boundaries. The Phase-3 position soak
(`soak-trading.test.ts`, Part XXIV) and reconciliation oracle continue to pass on
the over-sized positions this would create — the accounting stays exact.

## 4. Why it is not fixed here (and what a fix would require)

Phase 3's charter explicitly forbids changing contract-limit semantics or
resolving RES-1 — it is a **product rule decision**, not a correctness bug. The
firm must first decide what "max N contracts" *means*:

- **Interpretation A — position cap (today's behaviour).** "You may never *hold*
  more than N." Working orders are allowed to over-subscribe; the cap binds the
  resulting position. Under this reading RES-1 is **not a defect at all** — it is
  the intended contract. (This is a legitimate reading: many platforms cap held
  size, not resting size.)
- **Interpretation B — working-order cap.** "Your resting + held exposure may
  never *sum* to more than N." This is stricter and requires a design change.

A fix for Interpretation B would need, at minimum:
1. Count **working exposure-increasing orders** in the admission test:
   `projected = openContracts + workingIncreasingContracts + thisOrder`, computed
   under the per-account advisory lock so concurrent submissions can't race past it.
2. A **fill-time** re-check (or reservation model) so that even if orders rested,
   a fill that would breach the cap is rejected or reduces — because a purely
   submit-time test can still be defeated by orders that rested before the cap
   tightened.
3. A decision on **partial fills and OCO/bracket legs** (a bracket's protective
   legs must never be blocked by the cap, or a trader could be trapped in a
   position they can't protect).
4. New tests: a stacked-resting-order torture proving held contracts can never
   exceed N under any fill order, plus a bracket-safety test proving protective
   legs are exempt.

None of this was done in Phase 3. This document exists so the product decision
can be made against a precise, measured description rather than a vague note.

## 5. Reproduction (for whoever takes the product decision)

The mechanism is deterministic and can be reproduced with the engine harness
(`apps/server/src/trading/harness.ts`): create an account with `maxContracts: 5`,
rest several BUY limit orders below the market (each qty 5) while flat, then quote
price down through all of them, and observe the resulting position exceeds 5 while
the reconciliation oracle still shows position/P&L/fees exactly consistent with
the executions. This confirms both halves of the characterization: the cap is
over-subscribable **and** the accounting remains exact.

---

**Bottom line.** RES-1 is a **bounded, single-account, no-money-duplication**
over-subscription of the contract cap by *resting* orders, caused by a
position-only, submit-time admission test with no fill-time cap. Whether it is a
defect depends entirely on the firm's intended meaning of "max N contracts."
Characterized and quantified; **unchanged**; awaiting a product decision.
