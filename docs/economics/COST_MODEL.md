# COST_MODEL

All cost inputs are **assumptions**. None are vendor-quoted facts.

## Payment processing (ASSUMPTION — not in production config)

There is no processing-fee schedule anywhere in the real config (Whop holds card data;
the app moves no money). Modelled as:

- `processingPct` (fraction of the charged amount) + `processingFixedMicros` (per
  transaction), taken at purchase. BASE: 4.5% + $0.30.

Refund cash returns the gross at the refund day; a chargeback returns the gross **and**
adds `chargebackFeeMicros`. Refunds and chargebacks are separate concepts (see
`MODEL.md`).

## Operating costs

A list of named lines, each with a fixed monthly component and/or a per-customer and/or
per-payout variable component. BASE lines: market data & execution, hosting/db/storage,
email & SMS, identity/KYC, support, payout-provider processing, software/services,
legal/compliance placeholder.

- Fixed monthly is charged every modelled month.
- Per-customer variable scales with customer volume.
- Per-payout variable scales with paid payout events.

Owner-editable (add/remove/retune lines) via the run's assumptions.

## Customer acquisition

`acquisitionModel` ∈ {ORGANIC, PAID, AFFILIATE, MIXED}:

- ORGANIC → $0 CAC.
- PAID → `cacPerCustomerMicros` per customer.
- MIXED → half of `cacPerCustomerMicros`.
- AFFILIATE → $0 CAC (the affiliate commission is the acquisition cost, counted
  separately, to avoid double-counting).

Tracked: acquisition expense and (derivable) revenue and contribution per acquired
customer. Deliberately **no ROI terminology** — contribution per customer is reported
instead.
