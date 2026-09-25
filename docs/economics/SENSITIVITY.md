# SENSITIVITY, BREAK-EVEN & MONTE CARLO

## Sensitivity sweeps

`sensitivity(input, lever)` sweeps a single lever across a fixed grid and reports the
contribution curve. Levers: `passRate`, `firstPayoutProb`, `repeatPayoutProb`,
`avgPayoutFractionOfCap`, `refundRate`, `chargebackRate`, `affiliatePenetration`,
`cacPerCustomerMicros`, `resetRateOnFail`. `sensitivityAll(input)` runs them all.

Each point is a full deterministic re-run, so the curves reconcile with the headline run.
Rising payout size / refund / chargeback / CAC lower contribution; the tests assert the
monotonic direction on the key levers.

## Break-even

`breakEven(input, lever)` finds the lever value where modeled contribution crosses zero,
by scanning a fine grid and linearly interpolating the crossing. It returns the crossing
(or null if none in range) and the direction. `breakEvenKey(input)` covers the levers
most likely to threaten the business (payout probs & size, refunds, chargebacks, CAC,
affiliate penetration). This answers "at what payout behaviour / refund rate / CAC does a
product's economics reach zero?".

## Monte Carlo

`monteCarlo(input, trials, safetyMultiplier)` redraws the whole run per trial (seed +
t·2654435761) and reports distributions for net revenue, payout expense, contribution,
reserve requirement, distributable cash and funded accounts, plus:

- `probContributionNegative` — fraction of trials with negative contribution
- `probLiquidityStress` — fraction of trials with negative distributable cash
- `suggestedSafetyReserveMicros` — `multiplier × (p90 payout − mean payout)`

### Percentile convention (important)

Percentiles are of the raw metric, and each distribution is labelled with its
`worseTail`:

- **Contribution, distributable cash, net revenue, funded accounts** → `worseTail: LOW`.
  The **downside** is the **low** percentile (p10).
- **Payout expense, reserve requirement** → `worseTail: HIGH`. The **downside** is the
  **high** percentile (p90).

So "the bad case" is p10 for the things you want large and p90 for the things you want
small. No fake precision: percentiles come from the trial sample, not a fitted curve.
