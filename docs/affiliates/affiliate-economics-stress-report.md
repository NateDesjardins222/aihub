# Affiliate economics stress run

Deterministic model — seed 42, 500 affiliates × 12 months. No DB, no external calls; integer micros throughout.

| Metric | Value |
| --- | --- |
| Gross referred revenue | $143,793,400 |
| Refunded revenue (6% assumed) | $8,627,604 |
| Qualified (net) revenue | $135,165,796 |
| Commission accrued (gross) | $28,339,925 |
| Commission reversed | $1,700,395 |
| Commission net liability | $26,639,529 |
| Held in maturity window | $3,995,929 |
| Matured / payable | $22,643,600 |
| Blended effective rate | 19.71% |
| Worst single-month affiliate liability | $23,016 |

## Final-month tier distribution

| Tier | Affiliates |
| --- | --- |
| AFFILIATE | 183 |
| PARTNER | 146 |
| GOLD | 154 |
| PLATINUM | 17 |
| STRATEGIC | 0 |

## Interpretation

- The **net liability** is what the program owes affiliates after refunds/chargebacks reverse commissions; it is the number treasury must be able to cover.
- The **maturity window** always holds back a slice of the newest accruals, absorbing refund risk before money becomes withdrawable.
- The **blended effective rate** stays within the configured tier band (15%–25%); it never exceeds the top tier because commission is floored per order and tiers are revenue-gated.
- Raising a tier rate or lowering a threshold moves this liability; because rates/thresholds are configuration (not code) the same model can be re-run against a proposed change before it ships.
