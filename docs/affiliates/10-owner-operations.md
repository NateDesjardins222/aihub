# 10 — Owner operations, RBAC, and Owner OS integration

## Owner console (`/admin/affiliates`)

- **Overview** — active affiliates, pending applications, approved-awaiting-agreement,
  suspended, MTD referred revenue, commission accrued/payable/paid/reversed, payout
  liability. Every figure from the server.
- **Applications** — approve / request-info / decline (with reason).
- **Affiliate directory** — search + status filter; click through to 360.
- **Program configuration** — read-only view of the versioned settings.
- **Maintenance jobs** — run commission maturity, recalculate tiers.
- **Affiliate 360** (`/admin/affiliates/:id`) — snapshot + balances, codes,
  conversions, commissions, payouts, rate/tier history, risk signals, and owner
  actions.

## RBAC (granular permissions)

| Permission | Grants |
| --- | --- |
| `affiliates.read` | overview, directory, 360, config (read) |
| `affiliates.applications.review` | see + review applications |
| `affiliates.manage` | status, codes, maintenance jobs |
| `affiliates.rates.manage` | rate + tier changes |
| `affiliates.commissions.read` / `.adjust` | read / post adjustments |
| `affiliates.payouts.read` / `.manage` | read / approve/cancel/fail/pay |
| `affiliates.risk.manage`, `affiliates.config.manage` | risk, config edits |

Defaults: SUPPORT reads (`read`, `commissions.read`, `payouts.read`); ADMIN adds
review/manage/payouts.manage/risk.manage. Owner-tier actions sit above ADMIN.

## FINANCIAL step-up

Money and economics actions require a `FINANCIAL` re-authentication (`requireReauth`),
sent as the `x-stepup-token` header minted at `POST /api/v1/admin/security/reauth`:

- rate change, tier override, commission adjustment, **mark payout paid**, config edit.

The console collects the password inline and mints the token per action. Verified in
`affiliate-http.test.ts` and `affiliate-security.test.ts` (ADMIN 403 on rate;
owner 403 without step-up; 200 with it; config/adjust refused without step-up).

## Owner OS surfaces

- **Global search** — `affiliate` and `affiliate_code` groups.
- **Object explorer** — an `affiliate` case (status, tier, rate, linked customer).
- **Financial ops** — `financialSummary` adds affiliate commission payable/paid and
  payout liability.
- **Data integrity** — `INV_AFFILIATE_COMMISSION_HAS_CONVERSION`,
  `INV_ACTIVE_AFFILIATE_HAS_AGREEMENT`, `INV_ONE_COMMISSION_PER_ORDER`.
- **System Doctor** — `affiliate_payouts` probe, truthful NOT_CONFIGURED at INFO.
- **Audit** — every action is a `recordAudit` entry with the `AFFILIATE` subject.
