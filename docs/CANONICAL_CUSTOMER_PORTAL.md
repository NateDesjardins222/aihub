# Canonical Customer Portal

One customer product. The contract for the converged Happy Trader customer portal.

## The one product

- **Canonical route:** `/portal` (and `/portal/*` sub-paths).
- **Canonical experience:** the approved **V2** sidebar experience (`V2AppShell`,
  `v2/*` presentational components, V2 design tokens/motion).
- **Canonical business authority:** the existing **hardened** server/domain/API
  (`/api/v1/portal/*`, `/api/v1/payouts/*`, `/api/v1/support/*`). The browser
  computes no balance, status, payout, eligibility, or ownership.
- **Root component:** `portal/PortalV2App.tsx` (`PortalV2App`), rendered by
  `App.tsx` at `/portal`.

There is exactly **one** production-capable customer portal. `/portal-v2` is a
DEV-only review harness (fixtures, 404 in production) — never a second product.

## Canonical navigation (primary)
`Dashboard · Accounts · Payouts · Certificates · Progress · Billing · Support`

Account-menu utilities (not primary nav): Profile & security, Payout methods,
(Owner Console — owners only, role-gated), Sign out. Trade hands off to Atlas from
an account context.

## Canonical data authority per page
| Page | Presentation (V2) | Authority (hardened) |
|---|---|---|
| Dashboard | `v2/dashboard.tsx` | `/api/v1/portal/accounts` + `/progress` + certificates (payout count) + per-funded eligibility (readiness) |
| Accounts | `V2AccountsView` | `/api/v1/portal/accounts` (+ funded eligibility extras) |
| Account detail | `V2AccountDetail` (+ live tabs) | `/api/v1/portal/accounts/:id` (+ analytics, eligibility) |
| Payouts | `V2PayoutsPage` + reused `PayoutModule` | eligibility per funded account; `/progress` lifetime paid; PAYOUT certs (history); `POST /payouts/requests` |
| Certificates | `V2CertificatesPage` | `/api/v1/portal/certificates` + artifact blobs |
| Progress | `V2ProgressPage` | `/api/v1/portal/progress` + goal CRUD |
| Billing | `V2BillingPage` | orders derived from `/api/v1/portal/accounts` (as V1), provider-hosted payment method |
| Support | `V2SupportCenter` | `/api/v1/support/*` (self-fetching) |
| Profile/security/etc. | reused V1 `ProfilePage`/`MfaPanel`/`PayoutMethodsPage` in V2 shell | `/api/v1/portal/profile` + MFA endpoints |

## Hardened invariants preserved (must not regress)
- **§4A Portal→Atlas handoff:** Trade → `/?account=<publicId>`; the server re-checks
  ownership + status; an explicit account never silently becomes another.
- **§4B error ≠ zero:** a failed fetch renders error/unknown, never an authoritative
  zero/empty (`countBadge`, discriminated load states on every container).
- **Active cap:** reported from the server `AccountsView.maxActiveSlots`
  (`MAX_ACTIVE_ACCOUNTS`), never a client literal.
- **Payout cycles = 5:** server-authoritative; no client `3 of 12` or invented cycle
  count — Payouts presentation renders server values only.
- **Ownership / identity / money / lifecycle / certificates / progress / support:**
  server-authoritative; containers map authoritative values for presentation only.
- **Add Account:** every entry routes to the canonical purchase flow (`/onboarding`),
  never a client-side account creation.
- **Owner Console:** role-gated (`canAccessOwnerConsole`), in the account menu only —
  never in customer navigation.

## Fixture firewall
Production `/portal` (`PortalV2App` + its containers) must never import `v2/fixtures.ts`
or `v2/cert-samples.ts`. Enforced by an automated guard test.

## One-product invariant
There is exactly one production-capable customer portal (`/portal`). Any other
portal-like route is DEV-only review tooling or retired — never a competing product.
