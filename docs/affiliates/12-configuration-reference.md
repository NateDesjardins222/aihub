# 12 — Configuration reference

All program economics are **configuration, not code**. They live in the versioned
`affiliate_config` table and are read through `getAffiliateConfig`. Editing goes
through `updateAffiliateConfig`, which writes a **new version** (append-only history)
and merges only the keys you pass — untouched keys are preserved.

## Settings (defaults)

| Key | Default | Meaning |
| --- | --- | --- |
| `applicationsEnabled` | `true` | public application intake open |
| `tierRatesBps` | `{AFFILIATE:1500, PARTNER:1750, GOLD:2000, PLATINUM:2500}` | tier rates (bps) |
| `tierThresholdsMicros` | `{AFFILIATE:0, PARTNER:$10k, GOLD:$30k, PLATINUM:$75k}` | monthly qualified revenue to reach a tier |
| `attributionWindowDays` | `30` | how long a referral touch attributes |
| `commissionMaturityDays` | `14` | holdback before a commission becomes available |
| `commissionBasis` | `NET_AFTER_DISCOUNT` | `NET_AFTER_DISCOUNT` or `GROSS` |
| `minPayoutMicros` | `$50` | minimum payout request |
| `resetCommissionPolicy` | `NONE` | `NONE` / `REDUCED` (with `resetCommissionRateBps`) |
| `qualifyingRevenue` | `{courtesy:false, reset:false}` | whether non-purchase / reset orders qualify |
| `selfReferralPolicy` | `DENY` | self-referral handling |
| `payoutApprovalMode` | `ON_REQUEST` | payout workflow |
| `timezone` | `America/New_York` | program timezone |

## Versioning

- `getAffiliateConfig` seeds version 1 with these documented defaults on first read.
- `updateAffiliateConfig` bumps the version and preserves history; a commission
  snapshots the `configVersion` in force when it was created, so historical
  commissions are unaffected by later changes (doc 04).

## Editing

Owner console → **Affiliates → Program configuration** (read), or
`POST /api/v1/admin/ops/affiliates/config` with `affiliates.config.manage` **and** a
`FINANCIAL` step-up. Changes are audited.

## Rationale for the defaults (§104)

The build set reasonable, documented defaults rather than interrupting with routine
questions: 15% base with the four-tier ladder mirrors the milestone brief; 30-day
attribution and 14-day maturity are industry-typical and both configurable; $50 min
payout is a sensible floor; reset/courtesy revenue does not qualify by default to
keep commission tied to genuine new revenue. Any of these can be changed in config
without a code change.
