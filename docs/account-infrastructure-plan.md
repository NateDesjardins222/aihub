# Account infrastructure and admin platform — architecture plan

This is the plan asked for before implementation: first what the codebase
already has (so nothing working gets replaced for its own sake), then the
target architecture, then the checkpoints.

Scope boundaries are taken from the brief and are not negotiable in this
milestone: no live brokerage routing, no payments, no payouts, no KYC, no
firm-specific rules, no branding editor. Execution stays where it is.

---

## 1. Audit of what exists today

### Worth keeping, unchanged

| Area | Where | Verdict |
|------|-------|---------|
| Identity | `users`, `refresh_tokens` | Sound. Argon2 hashes, JWT access tokens, rotating refresh tokens stored only as hashes, replay of a rotated token detectable. Keep. |
| Ownership enforcement | `assertOwnership` in `routes/trading.ts`, `authorize` in `ws/gateway.ts` | Already server-side on every trading route and every WebSocket stream. Keep and extend the same pattern to the new routes. |
| Execution authority | `trading/engine.ts` | The engine holds **no** balances in memory. Every match reads the account row inside a per-account `KeyedMutex` and writes back in a transaction. Multi-account isolation and restart recovery therefore already hold by construction. **Do not touch.** |
| Rule engine | `packages/core/src/rules/rules.ts` + `trading/account-rules.ts` | Already configuration-driven: drawdown type, consistency formula, daily-loss policy, trading-day counting and contract cap are all data. No firm is named anywhere in it. This is the white-label core and it stays. |
| Per-account event stream | `account_events` (accountId, seq, type, prevState, newState) | A sequenced state stream used for WebSocket snapshot/delta recovery. Keep as is — it is not the platform audit log and should not be conflated with one. |
| Risk rejections | `trading/risk.ts` | Already gates on account status, contract cap, session state and data freshness. Extend, don't rewrite. |
| Money representation | integer micro-dollars, integer ticks | No float in any financial column. Keep. |

### Gaps against this brief

1. **Users** have `is_admin: boolean` — not roles. No user status, no organization, no last-login.
2. **Accounts** have no public account number, no organization, no activation date, no permitted-instrument list, no per-instrument sizing, no external metadata, and no lifecycle identity for resets.
3. **Statuses** are the rule engine's five (`ACTIVE`, `GOAL_REACHED`, `PASSED`, `FAILED`, `LOCKED`). The brief needs `PENDING`, `DISABLED` and `ARCHIVED` as well — administrative states the rule engine has no opinion about.
4. **Products** are `rule_templates`, which are **mutable**: editing one silently rewrites the rules of every account already trading it. The brief explicitly forbids this.
5. **Provisioning** is `POST /api/v1/accounts`, which lets *any signed-in user* create themselves an account of any product. That is a hole, not a feature.
6. **No audit log** spanning users, accounts and admin actions; `account_events` is per-account and ordinary code can update rows in it.
7. **No admin surface at all**, and no server-side authorization beyond `isAdmin` (which nothing currently reads).
8. **No reset workflow**, so there is nothing to preserve history across.
9. **No event/outbox layer**, so any future integration would have to reach into the engine.
10. **Practice accounts** come from the seed script — a development shortcut, not provisioning.

---

## 2. Target architecture

### 2.1 Tenancy

```
organization ──┬── users ──── accounts ──── lifecycles ──── trading records
               ├── account_profiles ── account_profile_versions
               └── audit_log / domain_events
```

* `organizations(id, slug, name, status, branding jsonb, created_at)`.
* Every existing row is backfilled into one organization, `atlas`, so nothing
  in the codebase assumes Atlas is the only tenant while nothing changes
  behaviourally today.
* `users.organization_id` and `accounts.organization_id`, both `NOT NULL`
  after backfill. Cross-organization reads are refused at the service layer,
  with tests.

No white-label customisation UI is built. This is data architecture only, as
the brief requires.

### 2.2 Roles

`users.role` in `TRADER | SUPPORT | ADMIN | SUPER_ADMIN`, backfilled from
`is_admin`. `is_admin` stays for one release as a derived mirror so no running
token breaks, then is dropped.

Authorization is a server-side `requireRole(...)` pre-handler plus a
capability table in one module, so what an admin may do is stated once:

| Capability | SUPPORT | ADMIN | SUPER_ADMIN |
|---|---|---|---|
| read users / accounts / live view | yes | yes | yes |
| provision, lock, enable, disable | no | yes | yes |
| reset, archive | no | yes | yes |
| change roles, edit profiles | no | no | yes |

Frontend hiding is presentation. Every capability is tested against the HTTP
layer with a token that lacks it.

### 2.3 Account profiles, versioned

```
account_profiles(id, organization_id, key, name, account_type, status, created_at)
account_profile_versions(id, profile_id, version, config jsonb, created_by,
                         created_at, published_at)   -- append-only
accounts.profile_version_id  -- the version this account is PINNED to
```

`config` is one JSON document:

```jsonc
{
  "rules":    { /* exactly @atlas/core RuleConfig */ },
  "execution":{ /* the existing simulationEnvironment shape */ },
  "instruments": { "allowed": ["NQ","ES"], "maxContracts": 15,
                   "perInstrument": { "NQ": 15, "ES": 10 } },
  "display":  { "startingBalanceMicros": 150000000000 }
}
```

An account is pinned to a **version**, never to a profile, so an administrator
editing a product creates version N+1 and accounts already trading version N
keep their terms. That is the requirement in §12 stated as a foreign key.

`rule_templates` is not deleted: existing accounts keep pointing at it, and
`ruleConfigFor()` prefers the pinned version's `rules` when present and falls
back to the template otherwise. The backfill creates one profile version per
existing template so both paths converge, and `accounts.rule_template_id`
becomes nullable for profile-provisioned accounts.

### 2.4 Account model additions

`accounts` gains: `organization_id`, `public_id` (`SIM-000284`, from a
Postgres sequence, unique), `profile_version_id`, `status` widened,
`activated_at`, `instrument_limits jsonb` (per-account override),
`external_metadata jsonb` (opaque, supplied by the provisioning caller and
never interpreted), `current_lifecycle_id`.

Status becomes the union of the lifecycle states and the rule states:

```
PENDING → ACTIVE ⇄ LOCKED → PASSED | FAILED
            ↓
        DISABLED → ARCHIVED
```

The rule engine continues to own `ACTIVE / GOAL_REACHED / LOCKED / PASSED /
FAILED`. `PENDING`, `DISABLED` and `ARCHIVED` are administrative and the rule
engine never writes them; `risk.ts` refuses orders on anything that is not
`ACTIVE` or `GOAL_REACHED`, which it already does — the new states simply fall
through the same gate with their own reason codes.

### 2.5 Reset and lifecycles

```
account_lifecycles(id, account_id, seq, profile_version_id,
                   starting_balance_micros, started_at, ended_at,
                   end_reason, final_balance_micros, final_status)
```

Reset: cancel working orders, flatten through the engine's own liquidation
path, close the current lifecycle row (`ended_at`, `end_reason`,
`final_balance`), open a new one, and reset only the columns the rules own
(balance, high-water mark, drawdown floor, day counters, lockout, failed
reason). **Nothing is deleted.** Orders, executions, trades, daily stats and
account events are untouched.

History is attributed to a lifecycle by time window
(`started_at <= t < ended_at`) rather than by stamping a `lifecycle_id` on
every order and fill. That keeps the reset entirely out of the execution hot
path, which §24 requires; the cost is that an admin query joins on a time
range, which is indexed and cheap.

### 2.6 Immutable audit log

```
audit_log(id, organization_id, actor_type, actor_user_id, actor_label,
          subject_type, subject_id, account_id, user_id, action,
          prev_state jsonb, new_state jsonb, reason, context jsonb,
          request_id, ip, created_at, prev_hash, hash)
```

* **Append-only, enforced by the database**: a migration installs a trigger
  that raises on `UPDATE` and `DELETE`. Application code cannot silently
  rewrite history even by mistake.
* **Hash chained** per organization: `hash = sha256(prev_hash || canonical
  row)`. A deletion or an out-of-band edit breaks the chain and a verifier
  endpoint reports where.
* Written for: account created / activated / reset / locked / unlocked /
  failed / passed / disabled / archived, user created / disabled / enabled /
  role changed, profile version published, configuration change, every admin
  action, and — mirrored from the engine's own stream — order submitted,
  modified, cancelled, filled, liquidation, rule violation.
* The mirror is a subscriber, not a call inside the matcher: the engine
  already emits change and valuation events, and the audit writer listens.
  The engine gains no knowledge of the audit log.

### 2.7 Events and the outbox

```
domain_events(id, organization_id, type, account_id, user_id, payload jsonb,
              occurred_at, available_at, delivered_at, attempts, last_error)
```

`EventBus.publish(type, payload)` writes a row and notifies in-process
subscribers. Types: `account.created`, `account.activated`, `account.passed`,
`account.failed`, `account.reset`, `account.locked`, `account.disabled`,
`order.filled`, `rule.violated`, `user.created`.

Nothing consumes the outbox in this milestone beyond the audit writer. The
point is that payments, e-mail, Discord, CRM and payout systems can later
subscribe **without touching the execution engine** — which is exactly what
§16 asks for and what keeps §24 safe.

### 2.8 Provisioning service

One service function, three callers:

```
provisionAccount({
  organizationId, userId, profileKey | profileVersionId,
  displayName?, startingBalanceMicros?, ruleOverrides?, executionOverrides?,
  instrumentLimits?, metadata?, activate?, idempotencyKey, actor
}) -> Account
```

* `POST /api/v1/admin/accounts` — an admin provisioning for a user.
* `POST /api/v1/provisioning/accounts` — machine-to-machine, authenticated by
  an organization API key (`provisioning_keys`, hashed like refresh tokens),
  rate-limited, requiring an `Idempotency-Key`. This is the seam a future
  "customer purchased a product" webhook plugs into. **No payment provider is
  built.**
* `ensurePracticeAccount(userId)` on registration — the practice account is
  provisioned through the same service with the `practice-150k` profile. It
  stops being a seed-script special case.

Idempotency: `provisioning_requests(key, organization_id, request_hash,
account_id)` with a unique index on `(organization_id, key)`. A repeat with
the same key returns the same account; a repeat with the same key and a
*different* body is a 409.

`POST /api/v1/accounts` (self-service creation by any trader) is **removed**.
Accounts come from provisioning.

### 2.9 Admin surface

Server: `/api/v1/admin/*` — overview, users, user detail, accounts, account
detail, live view, actions, audit search. Every route behind `requireRole`,
every action audited, every destructive action requiring an explicit
`confirm` field and a `reason`.

Client: `/admin` in the same Vite application but a **separate shell** —
its own layout, its own navigation, none of the terminal chrome, lazy-loaded
so a trader never downloads it. The terminal gains nothing admin-related.
(A second Vite entry point was considered and rejected: it would duplicate the
API client, the auth session and the money formatting for no benefit while
the two share an origin.)

### 2.10 Terminal integration

The account selector already reads `/api/v1/accounts`; it gains the public
account number and the widened statuses. Switching accounts must clear
positions, orders, valuation, rules and journal context before the new
account's snapshot arrives — the leak test is a browser check, not a code
review.

---

## 3. What this plan deliberately does not do

* No change to `engine.ts` matching, fills, P&L or the market data path.
* No `lifecycle_id` column on orders, executions or trades (see 2.5).
* No payment, payout, KYC, brokerage or copy-trading code.
* No firm-specific rule values in code — every number stays in a profile
  version row.
* No client-supplied balance, status, P&L or fill is ever trusted; the new
  provisioning inputs are validated and the balance still comes from the
  profile version unless an admin explicitly overrides it, which is audited.

---

## 4. Checkpoints

Each ends green (unit suite, server suite, browser suites, typecheck) and is a
commit.

| # | Checkpoint | Contents | State |
|---|-----------|----------|-------|
| I | **Data model** | organizations, roles, profiles + versions, lifecycles, audit log with the immutability trigger and hash chain, domain events, provisioning requests/keys, account columns, public account numbers, widened statuses, migration + backfill of every existing row. No behaviour change. | done |
| J | **Services** | provisioning service, account service (activate/lock/unlock/disable/enable/reset/archive), event bus + outbox, audit writer subscribed to the engine, practice account on registration, removal of self-service account creation. | done |
| K | **Configuration-driven rules** | `ruleConfigFor` reads the pinned profile version; allowed instruments and per-instrument sizing enforced in `risk.ts`; status gating for the new administrative states; profile versioning tests. | done |
| L | **Admin API** | overview, users, accounts, live view, actions, audit search; `requireRole`; rate limits; the full permission and isolation test suite. | done |
| M | **Admin UI** | `/admin` shell, overview, users, accounts, account detail with live view, actions with confirmation. | done |
| N | **Terminal + acceptance** | selector from the authenticated user's accounts, switching with no state leakage, multi-account independence, and the §20 acceptance flow as a browser suite. | done |

## 5. Test plan (§19)

Server-side, against the real database:

* new user → practice account provisioned, exactly once, idempotent on retry
* a user with ten accounts: all load, each independent
* switching accounts leaks no position, order, P&L or journal state
* provisioning validation, duplicate key, changed-body conflict
* reset: balance restored, flat, orders cancelled, rule state reset, previous
  lifecycle preserved with its trades still readable
* pass and fail transitions still driven by the rule engine
* admin permissions per role, including SUPPORT denied every mutation
* a user cannot read or act on another user's account (HTTP and WebSocket)
* organization isolation: an admin of org A cannot see org B
* profile versioning: editing a product does not alter a trading account
* audit records written for every listed event; `UPDATE`/`DELETE` on the audit
  table raises; the hash chain verifies
* concurrent orders on two accounts of the same user do not interleave state
* locking an account with an open position behaves as specified
* server restart: balances, positions, orders and rule state recover


---

## 6. What was found while building it

Three defects worth recording, because each one was invisible from the code
and only appeared when the whole path was exercised:

1. **An administrator's lock did not survive the next market tick.** The rule
   engine re-evaluates an account on every mark and writes its own status, so
   an operator's `LOCKED` was replaced by the rules' `ACTIVE` seconds later.
   Fixed by separating the administrative hold from the rule status: the rules
   keep advancing their own view underneath a hold, the effective status is
   theirs only when no hold is in place, and lifting a hold returns the account
   to wherever the rules actually left it.
2. **Two endpoints joined the rule-template table directly**, so a provisioned
   account - which has no template, because its terms live on a pinned product
   version - was refused with `ACCOUNT_NOT_FOUND` by the engine's risk loader
   and 404'd by the account P&L endpoint. Both go through the shared loader
   now, and a test walks every endpoint the terminal calls for a provisioned
   account.
3. **A column interpolated into a correlated sub-select renders unqualified**
   in Drizzle - `"id"` rather than `"users"."id"` - and silently binds to the
   subquery's own table, so the admin console's account counts and open-contract
   figures were zero. Written with explicit identifiers now, and asserted by
   value rather than by absence.

## 7. Where the seams are, for what comes next

* **Payments**: `POST /api/v1/provisioning/accounts`, authenticated by an
  organisation key and requiring an `Idempotency-Key`. A purchase webhook calls
  it; nothing about money is implemented on this side.
* **Notifications, CRM, payouts**: subscribe to the `domain_events` outbox or
  the in-process bus. The execution engine neither knows nor cares.
* **A second organisation**: every table already carries an organisation, every
  admin route is already scoped to the caller's, and the isolation is tested.
  What is missing is a branding surface, which the brief explicitly excludes.
* **Roles beyond four**: `requireRole` ranks them in one table.
