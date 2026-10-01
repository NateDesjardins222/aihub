# Portal Convergence Map

The complete map of the two customer portals at baseline `1a532e3`, and the
convergence classification of every relevant component. Goal: one canonical
customer product at `/portal` = the approved **V2 experience** backed by the
**hardened customer core**.

## The two portals at baseline

| | `/portal` (V1) | `/portal-v2` (dev review) |
|---|---|---|
| Router entry | `App.tsx` → lazy `PortalApp` | `App.tsx` → lazy `PortalV2Review`, gated by `designLabEnabled()` (404 in prod) |
| Root component | `portal/PortalApp.tsx` | `portal/v2/Review.tsx` |
| Shell | horizontal top-nav (`Portal.css`) — the REJECTED shell | `v2/Shell.tsx` `V2AppShell` (sidebar) — the APPROVED shell |
| Nav | Dashboard/Accounts/Payouts/Certificates/Achievements/Billing/Support | Dashboard/Accounts/Payouts/Certificates/Progress/Billing/Support |
| Data | each `pages/*Page.tsx` fetches authoritative `/api/v1/*` itself | presentational `v2/*` components fed **fixtures** (`v2/fixtures.ts`) |
| Auth | `useSession` + `canAccessOwnerConsole` | dev `?role=owner` override, no session |
| Business truth | authoritative (hardened) | none (fixtures) — except `V2SupportCenter` (live) + `V2AccountDetail` tabs (live) |

The split: V1 has the **hardened production data wiring** but the rejected
presentation; V2 has the **approved presentation** but runs on dev fixtures.
Convergence keeps V1's business truth and V2's presentation.

## Component classification

Legend: KEEP · MIGRATE (V2 presentation → canonical `/portal`) · REWIRE (feed V2
component authoritative data) · REUSE (V1 hardened surface mounted in V2 shell) ·
DEV-ONLY (stays in the review harness) · RETIRE (unrouted after convergence).

### V2 presentation — MIGRATE into canonical `/portal` (the approved experience)
| Component | File | Action |
|---|---|---|
| `V2AppShell`, `V2Sidebar`, `V2TopBar`, `V2AccountMenu` | `v2/Shell.tsx` | KEEP — canonical shell |
| `V2AccountsView` + `toAccountView` | `v2/AccountsView.tsx`, `account-view.ts` | REWIRE via authoritative accounts |
| `V2AccountDetail` (+ self-fetching tabs) | `v2/AccountDetail.tsx` | REWIRE via `V2AccountDetailContainer` (already authoritative) |
| `V2PayoutsPage` | `v2/pages.tsx` | REWIRE (standing/history/totals from authoritative sources) |
| `V2CertificatesPage` | `v2/pages.tsx` | REWIRE (`certs` + `resolveArtifact` blob + `onVerify`) |
| `V2BillingPage` | `v2/pages.tsx` | REWIRE (orders derived from authoritative accounts, as V1 did) |
| `V2ProgressPage` | `v2/progress-page.tsx` | REWIRE (`/progress` + goal CRUD) |
| `Dashboard`/`PortfolioPerformance`/`NextUp` | **inline in `Review.tsx`** | EXTRACT → `v2/dashboard.tsx`, REWIRE with authoritative data |
| primitives, perf-chart, format, tokens/type/motion css, tilt | `v2/*` | KEEP (shared presentation) |

### Already-authoritative — REUSE directly
| Component | File | Note |
|---|---|---|
| `V2SupportCenter` | `v2/support.tsx` | self-fetches `/api/v1/support/*`; mount as-is |
| `V2AccountDetailContainer` | `v2/AccountDetailContainer.tsx` | fetches `/api/v1/portal/accounts/:id`; route-agnostic (`onBack` prop) |

### Hardened V1 account UTILITIES — REUSE inside the V2 shell (account menu, not nav)
The rich V2 `ProfileView` (verification/security/sessions/notifications) has **no
backend endpoint** at baseline (server `/profile` returns only `preferredDisplayName`).
To avoid fabricating those fields, the canonical shell mounts the proven V1 surfaces
for the account-menu utilities:
| V1 surface | File | Why reused |
|---|---|---|
| `ProfilePage` (profile/verification/security/notifications) | `pages/ProfilePage.tsx` | real `/profile` + MfaPanel; no fabricated ProfileView |
| `MfaPanel` | `pages/MfaPanel.tsx` | hardened MFA wiring |
| `PayoutMethodsPage` | `pages/PayoutMethodsPage.tsx` | hardened payout-method surface |
| `PayoutModule` | `pages/PayoutModule.tsx` | hardened per-account payout REQUEST flow (`/api/v1/payouts/requests`) — reused for the request action |

### DEV-ONLY — stays in the review harness
| Component | File | Note |
|---|---|---|
| `PortalV2Review` | `v2/Review.tsx` | remains `/portal-v2`, `designLabEnabled()`-gated, 404 in prod |
| `fixtures.ts`, `cert-samples.ts` | `v2/*` | dev fixtures; firewalled from production (guard test) |

### RETIRE (unrouted after convergence; deleted only when proven safe)
| Component | File | Note |
|---|---|---|
| `PortalApp` (V1 shell) | `portal/PortalApp.tsx` | `/portal` no longer renders it |
| V1 presentation pages | `pages/{Dashboard,Accounts,AccountDetail,Payouts,Certificates,Achievements,Billing,Support,Review}Page.tsx`, `AccountCard`, `Performance`, `ControlsView`, `PayoutModule` (except reuse above) | superseded by V2 presentation; retained in-tree, unrouted, pending a careful follow-up delete |

## Authoritative endpoints the canonical containers consume
- Accounts: `GET /api/v1/portal/accounts` → `AccountsView`
- Account detail: `GET /api/v1/portal/accounts/:id` → `AccountDetailFull`; analytics `…/:id/analytics`
- Certificates: `GET /api/v1/portal/certificates`; artifact blobs `…/:id/{image,pdf}` (Bearer)
- Progress: `GET /api/v1/portal/progress`; goals `GET/POST /goals`, `PATCH/DELETE /goals/:id`, `POST /goals/:id/complete`
- Achievements: `GET /api/v1/portal/achievements`
- Payouts: `GET /api/v1/payouts/eligibility/:accountId`; `POST /api/v1/payouts/requests`
- Support: `GET/POST /api/v1/support/*` (via `V2SupportCenter`)
- Profile: `GET/PATCH /api/v1/portal/profile` (via reused V1 ProfilePage)

## Fate of `/portal-v2`
Remains a **DEV-only** review harness (fixtures), `designLabEnabled()`-gated, 404 in
production — never a second customer product. Retained because it is useful isolated
visual-review tooling (§53/§54).
