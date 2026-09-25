# SCENARIOS

A scenario is an explicit override set over BASE — nothing hidden. These are
**simulations, not forecasts**. Assumptions of any scenario are just an `Assumptions`
object and are shown in the owner view and every export.

| Scenario | What it changes vs BASE |
|----------|--------------------------|
| BASE | the default assumption set |
| HIGH_PASS_RATE | pass rate ×2.5 |
| HIGH_PAYOUT_RATE | first/repeat payout probs ↑, avg payout fraction ↑ |
| LOW_RESET_RATE | reset & repurchase rates ×0.3 (less repeat revenue) |
| HIGH_REFUND_RATE | refund rate ×4 |
| HIGH_CHARGEBACK_RATE | chargeback rate ×5, fee $25 |
| HIGH_AFFILIATE_PENETRATION | penetration ×2, rate 20% |
| HIGH_CAC | paid acquisition, CAC ×4 |
| VIRAL_GROWTH | SPIKE arrival (rapid inflow), penetration ↑ |
| PAYOUT_STRESS | pass, funded survival, payout probs and payout size all pushed up |
| COMBINED_DOWNSIDE | payouts up + refunds/chargebacks up + resets down + high CAC |

`PAYOUT_STRESS` and `COMBINED_DOWNSIDE` are the two most important: they model traders
performing far better than assumed. In validation runs both drive modeled contribution
sharply **negative** (payout expense exceeding revenue), which the engine surfaces
plainly rather than hiding — exactly the point of a stress engine.

The owner view offers a **scenario comparison** (BASE vs PAYOUT_STRESS vs
COMBINED_DOWNSIDE) that tabulates the facts and recommends nothing.

## Growth timing

Arrival patterns model the difference between customers arriving gradually (`LINEAR`,
`RAMP`) and a rapid burst (`SPIKE`, used by VIRAL_GROWTH). Because payouts, affiliate
maturity and refunds all lag the purchase, a fast inflow can create a **liquidity
trough** on the cash timeline before the economics recover — visible in the monthly
distributable-cash column even when the annual total is positive.
