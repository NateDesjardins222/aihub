# Owner OS — RBAC & Granular Permissions

Authorization is by **permission string**, not by role rank. Roles are a
convenience that maps to a default set of permissions; the server always checks
the *effective* permission set (role defaults ± per-user overrides). Hiding a
button is presentation; `requirePermission` is the thing that decides.

## The catalog

Permissions are dotted `area.action` / `area.sub.action` strings so they group
naturally in the UI and so a coarse `area.read` can gate a whole section. The
catalog lives in `apps/server/src/platform/permissions.ts` (`PERMISSIONS`) and is
grouped for the UI in `PERMISSION_GROUPS`. A test invariant asserts the grouping
covers the catalog exactly — no missing entries, no extras.

Areas: Customers, Accounts, Trading, Payouts, Enforcement, Commerce, Rewards,
Finance/Exports, System, Configuration, Alerts/Tasks, Administration.

## Roles (legacy linear tiers, retained as coarse defaults)

`TRADER < SUPPORT < ADMIN < SUPER_ADMIN`

- **TRADER** — no owner-console permissions at all.
- **SUPPORT** — read-oriented: read customers/accounts/trading/payouts/
  enforcement/commerce/finance/system/audit/alerts, write customer notes & tags,
  request an account reset, manage tasks. No mutating account/payout operations,
  no staff/roles/security/kill-switch access.
- **ADMIN** — SUPPORT plus operational mutations (pause/flatten accounts, cancel
  orders, payout operations, enforcement manage, run doctor/integrity, manage
  incidents/flags/jobs/webhooks, exports, impersonate, staff **read**). ADMIN does
  **not** hold the owner-only tier or the four-eyes financial approvals.
- **SUPER_ADMIN (owner)** — every permission in the catalog.

## Owner-only tier (never held by ADMIN by default)

`staff.manage`, `roles.manage`, `security.manage`, `system.kill_switches.manage`,
`accounts.reset.approve`, `accounts.adjust`, `payouts.adjust`, `refunds.approve`.

The reset/approve and refund request/approve split enforces four-eyes: the
requester and the approver are distinct permissions.

## Per-user overrides

`staff_permissions` rows carry a `GRANT` or `DENY` for a specific permission on a
specific user. `effectivePermissions(role, overrides)`:

1. starts from the role defaults,
2. adds every `GRANT`,
3. removes every `DENY`.

**DENY wins over GRANT** for the same permission (least privilege). Overrides are
read fresh from the database on every request (`effectiveAccess`), so a token's
role can be stale but the decision is always current.

## The owner can never be locked out

`PROTECTED_OWNER_PERMISSIONS` (`staff.manage`, `roles.manage`, `security.manage`,
`system.kill_switches.manage`, `audit.read`) can never be stripped from a
`SUPER_ADMIN` by any DENY override. A DENY of these on an ADMIN (who was granted
them) still applies — the protection is owner-tier only.

## Enforcement points

- `requirePermission(perm)` — 403 if the effective set lacks `perm`.
- `requireAnyPermission(...perms)` — 403 unless the operator holds at least one.
- `requireReauth(class)` — 403 unless a fresh, class-scoped step-up token is
  present (see `02-safety-model.md`).

`GET /api/v1/admin/me/access` returns the caller's own effective role and
permissions so the web can render navigation truthfully — but the server gate is
always authoritative.

## Tested

`rbac.test.ts` and `rbac-permissions.test.ts` prove role boundaries, catalog
integrity, override precedence, and owner lock-out protection over the entire
catalog. `owner-authz-http.test.ts` proves the same end-to-end over HTTP.
