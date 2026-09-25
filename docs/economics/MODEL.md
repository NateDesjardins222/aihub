# MODEL — engine mechanics

All money is integer **micro-dollars** ($1 = 1,000,000). The PRNG is `mulberry32`
(reused from the existing simulator), seeded and reproducible. `simulate(input)` is a
pure function of `{ products, assumptions, seed, customers, horizonDays }`.

## Customer economic lifecycle

For each of `customers`, in a deterministic order:

1. **Arrival** — an arrival day is assigned over the horizon by the arrival pattern
   (`LINEAR`, `FRONT_LOADED`, `RAMP`, `SPIKE`). This gives the run a **time axis**.
2. **Product** — chosen from the purchase mix (assumption; default equal weight).
3. **Acquisition cost** — booked at arrival for paid/mixed channels.
4. **Purchase → evaluation**:
   - The customer buys an **initial evaluation** (revenue stream: *initial*).
   - Evaluation passes with `passRate`. On failure the customer may buy up to
     `maxResetsPerAccount` **resets** (revenue stream: *reset*), each re-running the
     evaluation.
   - Still failing → with `repurchaseRateOnFail` the customer buys a fresh evaluation
     (**repurchase**, revenue stream: *repurchase*), up to `maxRepurchases`; otherwise
     they churn.
5. **Funded** — a pass funds the account. It survives to payout-eligibility with
   `fundedSurvivalToPayout`, takes a first payout with `firstPayoutProb`, and each
   subsequent payout with `repeatPayoutProb` (geometric), capped by the authoritative
   `MAX_PAYOUT_CYCLES` (5).
6. **Payout** — each payout draws a gross amount in `[minRequest, cap]` skewed toward
   `avgPayoutFractionOfCap`, split 90/10 via the real `splitAccounting`. SELECT’s
   consistency rule can delay (skip) an attempt.
7. **Refund / chargeback** — each purchase may be refunded (`refundRate`) or charged
   back (`chargebackRate`) — mutually exclusive, with their own lag days.

The evaluation pass/fail is an **assumption** (the drawdown mechanic is not modelled;
that decides pass probability, which we take as an input).

## Payout lifecycle states

Each payout has an approval day and a paid day (`approval + PAYOUT_SETTLE_DAYS`). At
the horizon:

- **paid** — cash left the firm (counted in the cash timeline and `paidTraderShare`).
- **approved, unpaid** — liability incurred, cash not yet out (`approvedUnpaid`).
- beyond horizon — a future/expected payout; not a current liability.

`traderShare + firmShare = grossPayout` exactly (firm absorbs rounding). Trader share
is the firm’s **payout expense**; the firm’s 10% is retained within revenue.

## Time & cash flow

Days bucket into 30-day months. The **cash timeline** records, per month: cash in
(purchases net of processing, less refund/chargeback cash out), trader payouts paid,
affiliate paid, operating, acquisition; net and cumulative cash; the running reserve
requirement; and distributable cash (cumulative − reserve). This is where **liquidity
stress** (distributable < 0 in a month) shows up even when long-run economics are fine.

## Revenue vs contribution

- **Gross sales** = initial + reset + repurchase.
- **Net revenue** = gross sales − refund loss − chargeback loss.
- **Modeled contribution** = net revenue − trader payout expense − net affiliate
  expense − processing − chargeback fees − operating − acquisition.

Contribution is a **modeled** figure, deliberately not called accounting net income.
