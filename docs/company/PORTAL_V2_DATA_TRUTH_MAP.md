# Portal V2 — Data Truth Map

The contract for **what is real**. For every customer-facing Portal V2 surface this records
the authoritative production record it reads, and confirms that the development review's
fixtures are isolated from production and never shown to a customer as truth.

## The two worlds

| | Production | Dev review (`/portal-v2`) |
|---|---|---|
| Entry | Mounted by the real Portal container, behind auth | `PortalV2Review` lazy route |
| Gate | normal app routing | `designLabEnabled()` = `import.meta.env.MODE !== 'production'`; a production build **404s** |
| Data | authoritative APIs for the signed-in customer | `fixtures.ts` only |
| Session | real session/JWT | none |

`fixtures.ts` is imported **only** by `Review.tsx` (the dev harness). No production code path
imports it. Its values are unmistakably development data (`DEV-####` ids, `example.com`
emails). This separation is the core guarantee: review fixtures cannot leak into production.

## Surface → authoritative source (production)

| Surface | Presentational component | Authoritative production source |
|---|---|---|
| Dashboard stats (balance, net P&L, counts) | `Review` Dashboard | derived from the accounts projection (`GET /api/v1/portal/accounts`) |
| Portfolio performance chart | `PortfolioPerformance` + `V2AreaChart` | authoritative cumulative-P&L series (see PORTAL_V2_PERFORMANCE_METRICS.md) |
| Accounts (master/detail) | `V2AccountsView` | `GET /api/v1/portal/accounts` → `AccountsView` |
| Account detail (overview/perf/controls/rules/activity) | `V2AccountDetail` | `GET /api/v1/portal/accounts/:id` + analytics (see PORTAL_V2_ACCOUNT_DETAIL.md) |
| Payouts (standing, history, available) | `V2PayoutsPage` | payout engine read model (`GET /api/v1/portal/payouts`) |
| Certificates (vault + artifact) | `V2CertificatesPage` | `GET /api/v1/portal/certificates` + `/:id/{image,pdf}` + `/verify/:token` |
| Billing (orders, entitlements, payment method) | `V2BillingPage` | commerce read model (orders/entitlements) + payment provider |
| Support (tickets) | `V2SupportPage` | support read model (`GET /api/v1/portal/support`) |
| Profile / Security / Notifications / Verification | `V2ProfilePage` | `GET/PATCH /api/v1/portal/profile`, MFA, onboarding/KYC (see PORTAL_V2_PROFILE_IDENTITY.md) |

## Never-invent list (enforced by construction)

We do **not** fabricate — in either world — accounts, certificates, payouts, balances,
performance, customer names, payment methods, invoices, KYC decisions, or stats. Where a
real artifact/record cannot be produced without a backend, the surface shows a **truthful
empty/seam state** rather than a fake:

- **Certificate artifact:** the vault previews the server-rendered PNG/PDF via an injected
  `resolveArtifact`. In the review (no session) it returns `null` → the card shows
  "Preview available in your account". It never draws a certificate in CSS or fakes a PDF.
- **Payment method:** only the provider-returned brand / last-4 / expiry are ever shown.
  Raw card data never touches our origin; management is a provider-hosted flow.
- **Performance:** the chart renders only a supplied authoritative series; `< 2` points →
  "No trading history yet", never an invented line.
- **Zero-customer (`?state=empty`):** a brand-new customer sees zeros and empty states on
  every surface — never demo records (deterministic `FIXTURE_*_EMPTY` fixtures).
- **Add account / purchase:** routes to the legitimate existing purchase flow at the app
  root; the review never fabricates a purchase.
- **Owner Console:** never rendered inside the portal; a truthful notice points to the
  separate server-authorized `/admin` app.

## Isolation invariants
1. Production build 404s `/portal-v2`; fixtures are tree-shaken out of production entry paths.
2. Presentational components accept **projected view models** only — they never fetch and
   never decide business truth. Production containers supply authoritative data; the review
   supplies fixtures. The same components render both, so what Nathan reviews is what ships.
3. No second source of truth is introduced. New read needs are additive projections over the
   existing authoritative records, not new writable stores.

---
## Review #3 — real product surfaces
- **Support** is now a REAL container (`support.tsx`) wired to `/api/v1/support/*` (create/list/
  thread/reply), identical mechanism to the tested Portal V1. Submit creates an AUTHORITATIVE ticket;
  no local-state fake. Unauthenticated preview → empty list + real errors, never a fabricated ticket.
- **Certificates** show the real rendered artifact (auth endpoint in prod; real renderer samples in
  the dev review). **Accounts** re-composed to a brokerage ledger + flat statement. **Performance**
  is a real interactive chart over an authoritative series.
- Isolation unchanged: production 404s `/portal-v2`; `fixtures.ts` + `cert-samples.ts` are imported
  only by the dev review; a regression test asserts production containers import no fixture module.
