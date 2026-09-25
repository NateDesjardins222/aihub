# 05 — Tiers, rates, and qualification

## Default tiers

| Tier | Rate | Qualifies at (monthly qualified referred revenue) |
| --- | --- | --- |
| AFFILIATE | 15% (1500 bps) | $0 |
| PARTNER | 17.5% (1750 bps) | $10,000 |
| GOLD | 20% (2000 bps) | $30,000 |
| PLATINUM | 25% (2500 bps) | $75,000 |
| STRATEGIC | custom | by invitation (manual) |

**Rates and thresholds are configuration, not frontend constants.** They live in
the versioned `affiliate_config` and can be changed by an owner with a `FINANCIAL`
step-up. `tierForRevenue` / `tierRateBps` read the current settings.

## Qualification

Tier is assessed on **qualified referred revenue for the current calendar month**
(`monthlyQualifiedRevenue`, UTC month bounds via `periodBounds`). Revenue from a
reversed or canceled commission is excluded from qualification.

`recalculateTier` applies the correct tier and rate, records
`affiliate_tier_history`, and audits the change. It is idempotent (no change → no
write) and **never auto-tiers a custom-rate (STRATEGIC) affiliate.**
`recalcAllTiers` runs it across the org (a maintenance job in the console).

## Custom rate overrides

`changeAffiliateRate(db, id, customRateBps, actor, { reason, expiresAt? })` sets a
custom rate, moves the affiliate to `STRATEGIC`, and records `affiliate_rate_history`.

`computeEffectiveRateBps` decides the live rate: an **in-effect** custom override
(effective now, not expired) wins over the tier rate; an expired override falls
back to the tier. The custom override is the applied `rateBps` on new commissions.

## Rate snapshot history

Because each commission snapshots its `rateBps` and `rateSource`, the rate history
is fully reconstructable and past commissions are immutable — changing the rate
tomorrow does not alter yesterday's earnings (doc 04).

## Progress

`tierProgress` returns the current tier and rate, this month's qualified revenue,
the next tier, its threshold, and the remaining amount — the numbers the portal's
"This tier" panel renders.

## Where it is verified

`affiliate-tiers.test.ts` (exhaustive boundary math, configurable thresholds,
$10k/$30k/$75k crossings against real conversions, idempotency, reversed-revenue
exclusion, custom-rate protection, manual tiering, progress).
