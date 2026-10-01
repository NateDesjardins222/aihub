# Customer Surface Truth Matrix

How each business value is sourced on each customer/operator surface. Legend:
**SRC** = authoritative source of record · **DER** = derived from authoritative
source · **N/S** = not shown · **N/A** = not applicable. Production customer portal
is **V1** (`apps/web/src/portal`, `/portal`); V2 (`/portal-v2`) is a dev-review
harness, 404 in production.

| Value | Portal Dashboard | Accounts/Detail | Payouts | Certificates | Progress(V2) | Billing | Support | Atlas | Owner OS |
|---|---|---|---|---|---|---|---|---|---|
| identity | DER | N/S | N/S | DER(name) | DER | DER(contact) | DER | DER(auth) | SRC |
| profile | N/S | N/S | N/S | N/S | DER(member-since) | DER | DER | N/S | SRC |
| purchase/order | N/S | N/S | N/S | N/S | N/S | DER (from accounts) | N/S | N/S | SRC |
| account | DER | SRC | DER | N/S | DER(counts) | DER | link | DER | SRC |
| balance | DER | SRC | DER | N/S | N/S | N/S | N/S | DER | SRC |
| P&L | DER | DER(engine) | N/S | N/S | N/S | N/S | N/S | DER | SRC |
| risk/lifecycle | DER | SRC | DER(gate) | N/S | DER(milestones) | N/S | N/S | DER(gate) | SRC |
| payout | N/S | DER | SRC | N/S | DER(clubs) | N/S | link | N/S | SRC |
| certificate | N/S | N/S | N/S | SRC | DER(link) | N/S | link | N/S | SRC |
| support | N/S | N/S | N/S | N/S | N/S | N/S | SRC | N/S | SRC |
| affiliate | N/S | N/S | N/S | N/S | N/S | N/S | N/S | N/S | SRC |
| goal | N/S | N/S | N/S | N/S | SRC | N/S | N/S | N/S | N/S* |
| achievement | N/S | N/S | N/S | DER | SRC | N/S | N/S | N/S | DER* |

\* Owner-side goal/achievement visibility is a documented deferred dependency
(§72 of the phase spec); it is not launch-critical.

## Notes from the trace

- Production Dashboard metrics (Active accounts, Funded, Payouts count, Total) all
  derive from `/api/v1/portal/accounts` + `/certificates` — no fixtures, no React
  business counters. (`DashboardPage.tsx`, `PortalApp.tsx`.)
- Atlas accounts derive from `/api/v1/accounts` owner-scoped by `accounts.user_id`;
  Atlas never creates ownership. Portal↔Atlas share one `accounts` row (same id).
- Payout eligibility/amounts are server-authoritative (`payout-core.ts`); the
  Portal renders the server's decision and never computes money.
- Certificate recipient name derives from `customer_identities` via
  `safePublicDisplayName` — never fixture text; `NATETRADEZ` exists nowhere.
- Error ≠ zero: fixed on the top-level accounts fetch (`PortalApp.tsx`) — an API
  failure now shows an error+retry banner, not an authoritative-looking empty
  account. (Secondary dashboard payout-count still degrades to 0 on error — see
  KNOWN_ISSUES.)
