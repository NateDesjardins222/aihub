# AFFILIATE_ECONOMICS

Mirrors the authoritative affiliate domain (`affiliate-config.ts`,
`affiliate-commissions.ts`, `commerce-refund.ts`).

## Authoritative rules used

- Default commission rate **15%** (bps math floored, never over-pays).
- Commission basis: NET_AFTER_DISCOUNT ≈ price (no discount modelled).
- Maturity hold **14 days** before a commission is payable.
- Resets do **not** generate commission by default.
- Refund or chargeback **reverses** a commission.

## What is an assumption

- **Affiliate penetration** — the fraction of customers attributed to an affiliate.
  Real attribution is unknown pre-launch, so it is an explicit input (BASE 0.35).
- The commission rate is editable per run (defaults to the authoritative 0.15); tier
  progression is not modelled at the cohort level in v1 (a calibration seam).

## Commission lifecycle in the model

Per commissionable purchase (initial or repurchase; resets only if opted in):

1. **created** on the purchase day; amount = `floor(price × rate)`.
2. **matured** at `purchase + maturityDays` (becomes payable).
3. **paid** at `matured + affiliatePayoutLagDays` (cash out on the timeline).
4. **reversed** if the purchase is refunded/charged back *after* it was available
   (clawback, net 0), or **canceled** if the dispute lands before maturity (net 0,
   never paid).

## Outputs

- gross commissions, matured, paid, **unpaid liability** (matured − paid), reversed,
  canceled, **net commission expense** = gross − canceled − reversed, and cost as a % of
  attributable revenue.
- Invariant: net expense = gross − canceled − reversed, and `0 ≤ net ≤ gross` (never
  double-counted).

No affiliate payout **provider** is configured in production (`NOT_CONFIGURED`); the
model treats affiliate payouts purely as a cash-timing/liability concept.
