# Owner OS — Safety Model

> Owner power is not the same thing as unsafe mutability. The Owner Operating
> System gives the owner and authorized staff complete visibility and strong,
> deliberate control — but every state-changing action passes through the same
> safety pipeline. There are no casual raw-database mutation buttons anywhere in
> this system.

## The seven properties of a safe action

Any action that affects money, payouts, balances, account lifecycle, trading,
access, enforcement, economics, staff, providers, or production must be:

1. **Authenticated** — a valid session (`requireUser`). No anonymous mutation.
2. **Authorized (granular)** — gated by a specific permission string via
   `requirePermission(...)` / `requireAnyPermission(...)`, not by role rank.
   See `03-rbac-and-permissions.md`.
3. **Reason-coded** — the caller supplies a reason (and, for adjustments, an
   explicit reason code from a closed vocabulary). The reason is persisted.
4. **Validated** — inputs are parsed with zod and business rules are enforced
   **server-side**, consuming server-authoritative reason codes rather than
   re-deriving product rules in the UI.
5. **Audited** — every action writes to the hash-chained, append-only
   `audit_log` via `recordAudit`. The chain is tamper-evident and is itself an
   integrity invariant (`INV_AUDIT_CHAIN_INTACT`).
6. **Previewable / reversible where practical** — high-impact account actions
   expose a `previewAction(...)` that reports what *would* happen without
   mutating. Financial corrections are made with **append-only adjustments**,
   never by editing a balance in place, so history is never rewritten.
7. **Re-authenticated (step-up) for high-risk classes** — a fresh, single-purpose
   step-up token (`x-stepup-token`, class-scoped, 5-minute TTL) is required for
   the riskiest actions. See below.

## What is explicitly forbidden

- **No raw balance edit.** There is no "edit balance" field. Balance only moves
  through authoritative flows (trading fills, payout ledger) or an append-only
  `admin_adjustments` row with a reason code. The `admin_adjustments` table has a
  DB trigger that refuses `UPDATE` and `DELETE`.
- **No silent record deletion.** Historical records are never made to disappear.
  Corrections add records; they do not remove them.
- **No client-authored business decisions.** The UI never decides eligibility,
  drawdown, or payout caps. It renders server reason codes.

## Step-up reauthentication (`requireReauth`)

High-risk endpoints declare a `ReauthClass`:

| Class         | Guards                                                        |
|---------------|--------------------------------------------------------------|
| `FINANCIAL`   | balance adjustments, account disable                         |
| `STAFF`       | staff invite / role change / disable                         |
| `KILL_SWITCH` | engaging or releasing a kill switch                          |
| `PROVIDER`    | provider configuration changes                               |
| `CONFIG`      | sensitive configuration changes                              |
| `BREAK_GLASS` | emergency owner overrides                                    |

`mintStepUp` re-verifies the operator's password and issues an HS256 JWT with a
distinct `typ: 'stepup'`, scoped to `{ user, class }`, valid for 5 minutes.
`requireReauth(class)` verifies the header token for exactly that user and class;
a token for another class or another user does not satisfy it. A missing or
invalid token yields `403`, not a client-only password prompt.

## Impersonation ("view as customer")

Support impersonation never requires or exposes a customer password. It mints a
short-lived, recorded impersonation token (`typ: 'impersonation'`), defaults to
`READ_ONLY`, and the safe-support gate refuses the forbidden action set
(`order.place`, `password.change`, `destination.change`, `purchase`,
`payout.request`, `identity.change`, `account.destructive`). Every start and stop
is audited with the operator and the target as distinct actors, and the owner can
terminate any active impersonation.

## Kill switches are fail-safe

Kill switches (`kill_switches`) let the owner halt classes of activity
immediately. `assertNotEngaged(key)` throws `423 Locked` at the *entry* of the
protected operation — e.g. `POST /orders` checks `MAINTENANCE_MODE` and
`DISABLE_NEW_ORDERS` before body parsing — while risk-reducing operations (cancel,
flatten) remain reachable. Engaging or releasing requires the permission **and** a
`KILL_SWITCH` step-up.

## External live stays off

`EXTERNAL_LIVE_ENABLED` remains `false`. Nothing in the Owner OS can place a real
external order, move real money, or charge a real card. The environment badge in
the console header reads the server-authoritative gate and shows `SIMULATION`
until that gate is genuinely enabled.
