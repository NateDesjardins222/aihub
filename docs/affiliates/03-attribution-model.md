# 03 — Attribution model

Attribution decides *which affiliate earns* on a given purchase. It is
deterministic, config-driven, and privacy-conscious.

## Referral links and clicks

A referral link carries a code: `https://…/affiliates?ref=<CODE>`. When a visitor
lands, the web records a click against a **first-party session id** (a random
`s_…` stored in `localStorage`, no PII). `recordClick`:

- resolves the code to an ACTIVE affiliate (ignores unknown/inactive codes),
- writes an `affiliate_clicks` row (IP is hashed, never stored raw),
- upserts an `affiliate_touches` row for the session: it sets the **first touch**
  once and updates the **last touch** and the **expiry** on every click.

The IP is stored only as a salted hash (`hashIp`) for abuse analysis.

## The attribution window

Configurable (`attributionWindowDays`, default **30**). A touch's `expiresAt` is
`lastTouchAt + window`. A touch past its expiry no longer attributes.

## Deterministic precedence

`resolveAttribution` applies a fixed order:

1. **Explicit checkout code** wins. If the buyer entered a code at checkout and it
   resolves to an active affiliate, that affiliate earns. The reason is recorded
   as `CHECKOUT_CODE`, or `CHECKOUT_CODE_OVERRIDE` when it differs from the last
   link touch.
2. **Valid link touch** (last touch, unexpired) → `REFERRAL_LINK`.
3. **None** → no commission (`NO_ATTRIBUTION`).

For analytics the conversion always records **first touch**, **last touch**, and
the **final** attribution reason, even when an explicit code overrides the link.

## Self-referral

A conversion where the buyer is the affiliate — matched by user id **or** by
verified customer identity — is denied (`SELF_REFERRAL_DENIED`) and raises a
`SELF_REFERRAL_ATTEMPT` risk signal.

## Commission basis

Configurable (`commissionBasis`, default `NET_AFTER_DISCOUNT`). Net subtracts any
order discount from the gross before the rate is applied; `GROSS` uses the
pre-discount amount. Tax and refunds are never part of qualified revenue.

## Where it is verified

`affiliate-attribution.test.ts` (window, precedence, first/last touch, invalid
code fallback, click stats, config-driven window) and
`affiliate-commission.test.ts` (precedence + self-referral against real orders).
