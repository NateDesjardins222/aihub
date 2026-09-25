# LIMITATIONS

## This is not a forecast

The engine does **not** predict Happy Trader's future profitability. It is a
scenario/stress-testing tool. Real trader behaviour, costs, refund/chargeback rates,
affiliate attribution and CAC are unknown until there is production data at scale. Every
Category B number is an editable assumption, never a measured fact, and no historical
operating data is fabricated.

## Simplifications (deliberate)

- **Evaluation pass/fail is an input**, not derived from the drawdown mechanic. The
  drawdown model (target, drawdown type, consistency) affects the *probability* of
  passing, which the engine takes as `passRate` per product rather than simulating
  trades. Consequently the exact drawdown type does not change modeled cash flows.
- **Payout draws** are a bounded, right-skewed sample toward `avgPayoutFractionOfCap`,
  not a trade-by-trade P&L simulation. The 90/10 split, caps and cycle limit are exact.
- **DAILY progressive-balance and SELECT consistency** are represented through the
  assumption inputs and a per-attempt SELECT delay, not the full per-day gating (which
  lives authoritatively in `payout-core.ts`).
- **Reserve model is illustrative** — coverage multiples, reserve percentages and the
  tax placeholder are planning assumptions, not accounting or legal advice, and never a
  claim about a real bank balance.
- **Time is bucketed into 30-day months.** Intra-month timing is approximated; the
  approved-unpaid payout liability is surfaced at the horizon and shown flat across the
  timeline reserve line.
- **Affiliate tiers** are not modelled at the cohort level in v1 (a single editable rate
  is used); tier progression is a calibration seam.

## Known existing-system finding (reported, not changed)

The public marketing catalog models drawdowns as **EOD trailing** (SELECT at 5% of
size), while the current DB seed (`seed-htf-products.ts` `evalRules`) computes a
**STATIC** drawdown at 4% of size for every family. These disagree on drawdown *type*
and on SELECT's drawdown amount. Per the milestone's rule not to change product rules,
this is **reported, not reconciled**. It does not affect the economics model (pass rate
is an input). The owner should reconcile product rules in a later milestone. Prices,
90/10 split, activation, payout caps, buffers and winning-days are consistent across
sources and are now sourced once from `@atlas/contracts/product-catalog.ts`.

## Calibration seams (for when production data exists)

Replace assumptions with observed distributions for: purchase conversion, product mix,
pass rate, resets, funded survival, payout behaviour (frequency & size), refunds,
chargebacks, affiliate attribution & tier mix, CAC and operating costs. The
`Assumptions` object is the single seam — swap the defaults for measured values and the
engine, exports and owner view are unchanged. The authoritative-catalog loader can also
be repointed at a DB `/catalog` once the CORE/SELECT/DAILY families are seeded into the
versioned product-config tables.

## Do not auto-change product rules

If the model shows dangerous economics under reasonable assumptions (e.g. PAYOUT_STRESS
drives contribution sharply negative), that is a **finding to report**, not a trigger to
silently change prices, drawdowns, caps, splits, winning days or limits. Product-rule
changes are an owner/business decision for a later milestone.
