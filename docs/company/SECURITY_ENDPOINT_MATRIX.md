# Security Endpoint Matrix

**Security Phase 1** — classification of every server HTTP route by trust class and
guard. Derived from a full inventory of `apps/server/src/http/` (all `routes/*.ts`
plus root-app registrations) at commit `ae9a4a3`.

## Auth mechanism (read first)

Opt-in, not default-deny. `registerAuth` (`auth-plugin.ts:46`) is a global
`onRequest` hook that only attaches `request.user` when a valid Bearer JWT is
present; it never rejects. Guards are added per plugin/route:

- `requireUser` (`auth-plugin.ts:63`) — 401 if no valid session.
- `requireRole(min)` (`auth-plugin.ts:77`) — re-reads `role`+`status` from DB; rank `TRADER<SUPPORT<ADMIN<SUPER_ADMIN`.
- `requirePermission` / `requireAnyPermission` (`owner-plugin.ts:39`) — re-reads effective access from DB.
- `requireReauth(class)` (`owner-plugin.ts:58`) — requires a fresh `x-stepup-token`.

Guards attach via a plugin-level `app.addHook('preHandler', …)` (Fastify
encapsulation scopes it to that plugin) or per-route options. Ownership is enforced
inside handlers (`accounts.userId == caller`, `assertOwnership`, `requireOwnAccount`,
IDOR `!== userId` guards), returning **404 with no existence oracle** for foreign
resources.

## Totals (407 route rows inventoried)

| Class | Count | Guard |
|---|---:|---|
| OWNER (ADMIN/SUPER_ADMIN/permission) | 193 | `requireRole`/`requirePermission` (+`requireReauth` on money/staff/kill-switch) |
| AUTHENTICATED CUSTOMER | 151 | `requireUser` + per-handler ownership |
| STAFF (SUPPORT / granular permission) | 47 | `requirePermission` |
| PUBLIC (intentional) | 18 | none (by design) |
| WEBHOOK | 2 | signature / provider-evidence (no session) |
| DEVELOPMENT ONLY | 3 | `NODE_ENV !== 'production'` guard (not registered in prod) |
| INTERNAL | 1 | `x-api-key` (provisioning) |
| **Unclassified** | **0** | — every route classified |

## By plugin (prefix → guard → class)

| Plugin (file) | Prefix | Plugin guard | Class |
|---|---|---|---|
| `auth.ts` | `/api/v1/auth` | none at plugin (per-route: public login/register/refresh/logout are IP-rate-limited; `/me`, MFA mgmt `requireUser`) | PUBLIC + AUTH CUSTOMER |
| `accounts.ts` | `/api/v1/accounts` | `requireUser` + ownership | AUTH CUSTOMER |
| `trading.ts` | `/api/v1/trading` | `requireUser` + ownership + self-serve gate | AUTH CUSTOMER |
| `portal.ts` | `/api/v1/portal` | `requireUser` + ownership | AUTH CUSTOMER |
| `payouts.ts` | `/api/v1/payouts` | `requireUser` + ownership | AUTH CUSTOMER |
| `copy.ts` | `/api/v1/copy` | `requireUser` + own-account fanout guard | AUTH CUSTOMER |
| `journal.ts` | `/api/v1/journal` | `requireUser` + ownership | AUTH CUSTOMER |
| `onboarding.ts` | `/api/v1/onboarding` | `requireUser` (+ dev-sim routes prod-gated) | AUTH CUSTOMER / DEV |
| `support-portal.ts` | `/api/v1/support` | `requireUser` + ownership | AUTH CUSTOMER |
| `marketdata.ts` | `/api/v1/marketdata` | `requireUser` (⚠ SEC-2: replay/recordings/provider mutate global state) | AUTH CUSTOMER |
| `verify.ts` | `/api/v1/verify` | none — public certificate verification (intentional, limited fields) | PUBLIC |
| `instruments.ts` | `/api/v1/instruments` | none — reference data (intentional) | PUBLIC |
| `affiliate-public.ts` | `/api/v1/affiliates` | none — public landing/apply | PUBLIC |
| `affiliate-portal.ts` | `/api/v1/affiliates` | `requireUser` + affiliate ownership | AUTH CUSTOMER |
| `provisioning.ts` | `/api/v1/internal` | `x-api-key` | INTERNAL |
| `commerce.ts` (webhook) | `/api/v1/webhooks/whop` (+`/mock` dev) | HMAC signature | WEBHOOK |
| `payout-ops.ts` (webhook) | `/api/v1/webhooks/payout/:provider` | provider seam (⚠ SEC-3) | WEBHOOK |
| `admin.ts` | `/api/v1/admin` | `requireRole(SUPPORT)` + per-route | STAFF/OWNER |
| `owner-*.ts` | `/api/v1/admin[/ops|/enforcement|/payout-ops]` | `requirePermission` (+`requireReauth`) | OWNER |
| `staff-onboarding` | `/api/v1/staff-onboarding` | invitation token (accept + set password) | PUBLIC (token-authed) |
| health/version/ready | `/` | none (intentional) | PUBLIC |
| WebSocket gateway | (upgrade) | token handshake + `mayFollowAccount` ownership | AUTH CUSTOMER |

## Sensitive-action guards (spot map)

| Action | Route | Guard |
|---|---|---|
| Submit/flatten order | `POST /trading/orders`, `/flatten` | `requireUser` + account ownership + risk gate |
| Request payout | `POST /portal|payouts …/payout` | `requireUser` + account ownership + eligibility (server) |
| Approve/reject payout | owner payout-ops | `requirePermission(payouts.approve)` + `requireReauth(FINANCIAL)` |
| Adjust/disable account | owner-accounts | `requirePermission` + `requireReauth(FINANCIAL)` |
| Invite/role/disable staff | owner-staff | `requirePermission(staff.manage)` + `requireReauth(STAFF)` |
| Kill switch engage/release | owner-config | `requirePermission` + `requireReauth(KILL_SWITCH)` |
| Step-up mint | `POST /admin/security/reauth` | `requireUser` + password re-verify + **rate-limit 10/min (SEC-1)** |
| Rules/reset/environment (commercial acct) | trading | `assertSelfServeMutable` → 403 unless PRACTICE |

## Findings

- **0 unclassified routes.** Every route maps to a class with a guard (or an
  intentional public surface).
- Global market-data controls (`marketdata.ts` replay/recordings/provider) are the
  only mutating routes reachable by bare customer auth with a cross-tenant effect —
  **SEC-2** (documented; Atlas replay redesign out of scope).
- `POST /admin/users/:id/notes` at SUPPORT vs ADMIN redaction — **SEC-4** (P3,
  confirm intent).

The complete row-by-row inventory (407 rows with file:line) was produced during the
audit; this matrix is the authoritative classification summary.
