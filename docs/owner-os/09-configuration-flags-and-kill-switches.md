# Owner OS — Configuration: Feature Flags & Kill Switches

Modules: `feature-flags.ts`, `kill-switches.ts`
Routes: `/api/v1/admin/ops/config/flags`, `/config/kill-switches/:key/engage |
/release`

## Feature flags

`feature_flags` are environment-scoped and audited. `setFlag(...)`:

- toggles or creates a flag for a `{ key, environment }` pair (`environment`
  defaults to `ALL`),
- performs **optimistic-concurrency conflict detection** via `expectedUpdatedAt`:
  if the flag was changed by someone else since the editor loaded it, the write is
  refused with `FLAG_CONFLICT` and the current `updatedAt` — two admins can never
  silently clobber each other,
- never carries a secret.

`isEnabled(db, key, env)` is the read used by feature code. Reading flags requires
`system.read`; writing requires `system.feature_flags.manage`. The known-flag
catalog (`KNOWN_FLAGS`) is advisory, not a hard allowlist.

## Kill switches

`kill_switches` let the owner halt a class of activity immediately and fail-safe:

| Key | Halts |
|-----|-------|
| `DISABLE_NEW_PURCHASES` | new commercial purchases |
| `DISABLE_PROVISIONING` | account provisioning |
| `DISABLE_NEW_ORDERS` | new order placement (risk reduction still allowed) |
| `DISABLE_NEW_PAYOUT_REQUESTS` | new payout requests |
| `DISABLE_PAYOUT_SUBMISSION` | payout submission to provider |
| `DISABLE_EXTERNAL_EXECUTION` | external execution routing |
| `MAINTENANCE_MODE` | broad maintenance halt |

`assertNotEngaged(key)` throws `423 Locked` at the entry of the guarded operation
— for `POST /orders`, before body parsing — while risk-reducing endpoints
(cancel, cancel-all, flatten) stay reachable. `isEngaged(key)` is the read.

Engaging or releasing requires `system.kill_switches.manage` (owner-only) **and** a
`KILL_SWITCH` step-up token, and both engage and release require a reason and write
an audit event. Reads require `system.read`.

## Change history

Every flag toggle and kill-switch transition is an `audit_log` entry, so the
configuration change history is the audit stream filtered to config actions.
