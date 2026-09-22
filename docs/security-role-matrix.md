# Atlas — security role & authorization matrix

The authoritative map of **who may do what**, as enforced **server-side**. Hiding
a button is presentation; the rows below are the code that actually decides
(`requireUser`, `requireRole`, `assertOwnership`, `organizationOf`,
`mayFollowAccount`). Every privileged capability has a test that calls the route
with a token lacking the role.

## Roles

Rank-ordered; `requireRole(minimum)` compares rank and **re-reads the current
role and status from the database** (a revoked role or a disabled account is
denied even while an old token is still cryptographically valid).

| Role | Rank | Meaning |
| --- | --- | --- |
| `TRADER` | 0 | An end user. Owns accounts; may act only on their own. |
| `SUPPORT` | 1 | Read the owner console (surveillance, CRM, audit). No mutations beyond staff notes. |
| `ADMIN` | 2 | Operate the firm: funding decisions, holds, note redaction, user status. |
| `SUPER_ADMIN` | 3 | Change what products/rules/people are allowed to be. |

Non-`ACTIVE` status (`DISABLED`, etc.) is denied at `requireRole` regardless of
rank; refresh is blocked immediately for a disabled user.

## Capability matrix

`self` = only the caller's own resources (`accounts.userId == caller`, fail-closed
404). `org` = scoped to `organizationOf(caller)`; a foreign resource is a 404 with
no existence oracle.

| Capability | TRADER | SUPPORT | ADMIN | SUPER_ADMIN | Enforcement |
| --- | --- | --- | --- | --- | --- |
| Register / login / refresh / logout | ✔ (public) | ✔ | ✔ | ✔ | public; rate-limited (F-01) |
| Read own user (`/auth/me`) | ✔ self | ✔ | ✔ | ✔ | `requireUser` |
| Read own accounts | ✔ self | ✔ | ✔ | ✔ | `accounts.userId == caller` |
| Place / modify / flatten orders | ✔ self | ✔ self | ✔ self | ✔ self | `requireUser` + `assertOwnership` |
| Journal / preferences / drawings | ✔ self | ✔ self | ✔ self | ✔ self | `requireUser` + `userId` scope |
| Create checkout (PENDING order) | ✔ self | ✔ self | ✔ self | ✔ self | `requireUser`, rate-limited |
| WS subscribe to own account streams | ✔ self | ✔ self | ✔ self | ✔ self | `mayFollowAccount` (ownership) |
| Owner reads (overview/trading/risk/exposure/users/accounts/audit/system) | ✗ | ✔ org | ✔ org | ✔ org | `requireRole(SUPPORT)` + org scope |
| Staff notes: read / create | ✗ | ✔ org | ✔ org | ✔ org | `requireRole(SUPPORT)` |
| Staff notes: redact | ✗ | ✗ | ✔ org | ✔ org | `requireRole(ADMIN)` |
| Funding approve / decline | ✗ | ✗ | ✔ org | ✔ org | `requireRole(ADMIN)` |
| Account holds / user status | ✗ | ✗ | ✔ org | ✔ org | `requireRole(ADMIN)` |
| Product config (create/version/deactivate) | ✗ | ✗ | ✗ | ✔ org | `requireRole(SUPER_ADMIN)` |
| Whop webhook (fulfilment) | n/a | n/a | n/a | n/a | HMAC signature only (no session) |

(The single `✗`/`✔` cell for owner reads: a `TRADER` token calling any
`/api/v1/admin/*` route is rejected by `requireRole(SUPPORT)` with 403.)

## Boundaries that must never weaken

- **Ownership** — a trader route touching an account always passes through
  `assertOwnership` (self) or `mayFollowAccount` (WS); both fail closed.
- **Tenant** — every owner read is scoped to the caller's organization; a
  foreign id is a 404, never a leak or an existence oracle.
- **Role source of truth** — the database, re-read per privileged request; the
  JWT claim is never trusted on its own for authorization.
- **Status** — a disabled account cannot pass `requireRole` and cannot refresh.

## Known authorization limitations

- **F-06** — `requireUser`-only routes trust the access-token claims, so a user
  disabled mid-session retains trader-level access for at most
  `ACCESS_TOKEN_TTL_SECONDS` (15 min). Privileged routes are unaffected
  (`requireRole` re-reads the DB) and refresh is blocked immediately. Documented,
  bounded, not fixed this milestone (a per-request DB read on every trader call
  would tax the reliability spine).
