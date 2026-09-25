# TREASURY_MODEL

The point of the treasury view is to separate **cash collected** from **cash that must
stay in the company**. Revenue > expenses does NOT mean cash is distributable.

## Components (all micro-dollars)

- **Cash collected** — cumulative net cash at the horizon (from the cash timeline:
  purchases net of processing, less refunds/chargebacks, less trader payouts paid, less
  affiliate paid, less operating, less acquisition).
- **Payout liability** — approved-but-unpaid trader share.
- **Affiliate liability** — matured-but-unpaid commissions.
- **Refund / chargeback reserve** — `refundReservePct × gross sales`.
- **Operating reserve** — `operatingReserveMonths × (operating ÷ months)`.
- **Tax placeholder** — `taxPlaceholderPct × max(0, contribution)`.
- **Safety reserve** — `safetyReserveMultiplier × (Monte-Carlo p90 payout − mean
  payout)`; folded in by `run.ts` after the Monte-Carlo pass.

## Required reserve & distributable

```
requiredReserve = payoutLiabilityCoverage × payoutLiability
                + affiliateLiabilityCoverage × affiliateLiability
                + refundReserve + operatingReserve + taxPlaceholder + safetyReserve
distributableCash = cashCollected − requiredReserve
```

The cash timeline computes a running reserve requirement per month and a running
distributable figure, so **liquidity stress** (distributable < 0 in a month) is visible
even when the end-state looks healthy. The BASE coverage multiples are 1.0; the reserve
percentages/months are assumptions.

These figures are **illustrative planning aids**, not accounting, and never a claim
about a real bank balance. No real balances are ever read or fabricated.
