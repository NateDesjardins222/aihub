# ACCOUNT_ECONOMICS — product segmentation & unit economics

Every figure is attributable to a **product** (family + size), and the ten products
roll up to the company total (an invariant the tests enforce).

## Per-product outputs (`byProduct[]`)

- customers, purchases, resets, passes, funded accounts, payout events
- initial / reset / repurchase revenue, gross sales, net revenue
- trader payout cost, firm split retained, affiliate expense
- processing, refund loss, chargeback loss
- operating allocation (fixed operating allocated by gross-sales share; variable by
  direct drivers — per-customer and per-payout)
- acquisition cost
- contribution and contribution per customer

## Unit economics (derivable)

Per customer, for any product or cohort:

- average gross sales / customer = grossSales ÷ customers
- reset revenue / customer, repurchase revenue / customer
- payout cost / customer = traderPayout ÷ customers
- affiliate cost / customer, processing / customer
- refund + chargeback loss / customer
- operating allocation / customer, acquisition / customer
- **contribution / customer** (shown directly in the product table)

## Cohort-level

A "run" is a cohort of `customers` arriving over `horizonDays`. The summary carries the
cohort's purchase revenue, reset revenue, total revenue, payout liability, payouts paid,
affiliate liability, processing, refund/chargeback loss, operating, acquisition and
contribution. The cash timeline breaks these across the cohort's months.

Modeled contribution is **not** labelled accounting net income; taxes and formal
accounting treatments are out of scope (a tax *placeholder* appears only in the reserve
model).
