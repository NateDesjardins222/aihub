# 01 — Affiliate / Partner Platform architecture

Happy Trader's affiliate program is a financially-correct, auditable business
system layered onto the existing customer identity, commerce, and Owner OS. This
document is the map; the numbered documents that follow go deep on each part.

## Design goals

1. **Financial correctness first.** All money is integer micros. Commission rates
   are basis points (integers). No floating-point money ever touches the ledger.
2. **Auditable and append-only.** The commission ledger and agreement acceptances
   are append-only at the database level (a `BEFORE UPDATE OR DELETE` trigger
   raises). Nothing is destructively reversed — reversals are new, signed entries.
3. **Exactly-once.** A commission is created at most once per commercial order,
   guaranteed by a unique conversion index plus a per-order advisory lock.
4. **Truthful.** Payout provider state is reported as `NOT_CONFIGURED` /
   `NOT_VERIFIED` until proven otherwise. Nothing fakes a payout or a rate.
5. **Locked activation.** Approval is not activation. No active code or link, and
   no commission accrual, exists until the required agreement is accepted.
6. **Privacy.** Affiliates never see a referred customer's email, phone, KYC,
   trading, or payout data — only a masked display name.

## Component map

| Concern | Module |
| --- | --- |
| Program config (rates, thresholds, windows) | `platform/affiliate-config.ts` |
| Application → activation lifecycle, codes, agreement | `platform/affiliates.ts` |
| Referral clicks + attribution | `platform/affiliate-attribution.ts` |
| Commission engine + append-only ledger + balances | `platform/affiliate-commissions.ts` |
| Tiers + qualification | `platform/affiliate-tiers.ts` |
| Provider-neutral payouts | `platform/affiliate-payouts.ts` |
| Analytics / read models (dashboard, overview, 360) | `platform/affiliate-analytics.ts` |
| Public HTTP (program, apply, agreement, click) | `http/routes/affiliate-public.ts` |
| Portal HTTP (self-service, scoped to the caller) | `http/routes/affiliate-portal.ts` |
| Owner HTTP (ops, permission + step-up gated) | `http/routes/owner-affiliates.ts` |
| Public web (landing, apply, agreement) | `web/src/affiliates/AffiliatesPublic.tsx` |
| Affiliate portal web | `web/src/affiliates/AffiliatePortal.tsx` |
| Owner console web | `web/src/admin/pages/AffiliatesPages.tsx` |

## Data model (14 tables, migration `0033_affiliates.sql`)

`affiliate_config` (versioned), `affiliates`, `affiliate_applications`,
`affiliate_agreement_acceptances` (append-only), `affiliate_codes`,
`affiliate_clicks`, `affiliate_touches`, `affiliate_conversions`
(unique on `commercial_order_id`), `affiliate_commissions`
(unique on `conversion_id`), `affiliate_ledger` (append-only),
`affiliate_payouts`, `affiliate_tier_history`, `affiliate_rate_history`,
`affiliate_risk_signals`.

## Integration with the existing platform

- **Commerce**: `commerce-refund.ts` calls `reverseCommissionForOrder` after a
  refund and after a chargeback opens (idempotent).
- **Owner OS**: global search, object explorer, financial ops, data integrity,
  and System Doctor all gained affiliate surfaces (see doc 10).
- **RBAC + reauth**: granular `affiliates.*` permissions; money actions require a
  `FINANCIAL` step-up (see doc 10).
- **Audit**: every staff action and lifecycle event is written via `recordAudit`
  (`AFFILIATE` subject), which is the authoritative event stream Owner OS reads.

## What this milestone does NOT do

- It performs **no real external financial action** (no live payout rail).
- The working agreement is a **draft pending legal counsel review**; it is clearly
  marked as such everywhere it appears.
