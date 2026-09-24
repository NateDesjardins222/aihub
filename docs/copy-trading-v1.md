# Atlas Native Copy Trading — V1 (domain model & architecture)

One Happy Trader customer, up to five of *their own* active accounts, traded
together from Atlas as a first-class feature — not an external copier bolted on.

The rule that governs every line of this milestone:

> **ONE USER INTENT → ONE COPY INTENT → MULTIPLE INDEPENDENT ACCOUNT
> EXECUTIONS.** Every destination account passes the *existing* Atlas execution
> and risk pipeline on its own. The copy layer orchestrates; it never computes
> money, never fills an order, never bypasses risk, and never holds authority the
> browser could forge.

This document is the domain model and the architecture. Execution semantics
(sizing, brackets, OCO, modify/cancel, resync deltas) are in
`copy-execution-semantics-v1.md`; every failure path is in
`copy-trading-failure-modes-v1.md`.

---

## 1. What already exists (reused verbatim, never duplicated)

The authoritative trading systems this milestone orchestrates, all in
`apps/server/src/trading`:

- **`engine.ts`** — the only thing that can create money. Per-account serialized
  (`KeyedMutex.run(accountId, …)`). Public surface used here: `submitOrder`,
  `modifyOrder`, `cancelOrder`, `cancelAll`, `flatten`, `setProtection`,
  `runMatch`. It validates, persists, matches and writes positions/trades/P&L.
- **`risk.ts`** — `checkOrder(...)` returns a reason code + human sentence; the
  engine records it and throws `OrderRejectedError`. This is where MLL, contract
  limits, instrument permissions, daily loss, market/stale gating live.
- **account model** (`accounts` table) — status / `adminHold` / `accountType`
  gate whether an account can trade; `account-limit.ts` holds the
  five-active-account invariant (`countActiveAccounts`, `assertActiveSlotAvailable`).
- **realtime** — the account WS channels (`acct.<id>.orders|positions|executions|
  trades|pnl`), the outbox worker, `LISTEN/NOTIFY` fan-out and
  `publishAccountState`. The web store treats any frame as "something changed"
  and re-reads authoritative state over REST.
- **audit / events / outbox** — `recordAudit`, `events.publish`
  (`DomainEventType`), `enqueueOutbox`, all hash-chained / durable.

Copy trading adds an **orchestration layer above these** and a thin Atlas UI. It
introduces **no** second execution / risk / position / P&L / bracket engine and
**no** client-side trading authority.

```
        (trader clicks BUY 2 MNQ, copy active)
                        │
                        ▼
                 COPY INTENT  (one immutable logical request, idempotency key)
                        │  fan-out (parallel, per-account)
        ┌───────────┬───┴───────┬───────────┬───────────┐
        ▼           ▼           ▼           ▼           ▼
     leader A    follower B  follower C  follower D  follower E
        │           │           │           │           │
        ▼           ▼           ▼           ▼           ▼
   engine.submitOrder (each: risk.checkOrder → fill → position/P&L)   ← existing pipeline
        │           │           │           │           │
        └───────────┴───────────┴───────────┴───────────┘
                        │  per-account child results
                        ▼
              COPY CHILD rows  (accepted / rejected / order id)  → realtime + audit
```

## 2. Domain model

Four durable, normalized tables (real FKs + indexes, never relationships buried
in JSON). Migration in CT-B; names follow repo convention (`copy_*`).

### `copy_groups`
| column | notes |
| --- | --- |
| `id` uuid PK | |
| `organization_id`, `customer_identity_id` | tenancy + owner spine |
| `user_id` | the owning trader (denormalized for fast owner scoping) |
| `name` | trader label |
| `leader_account_id` | the current leader (nullable when leader lost → PAUSED) |
| `sizing_mode` | `SAME` \| `MULTIPLIER` \| `FIXED` (group default; per-follower can override multiplier/fixed value) |
| `status` | `ACTIVE` \| `PAUSED` \| `DISABLED` (see §7 lifecycle) |
| `version` int | optimistic concurrency on config edits |
| `created_at`, `updated_at` | |

Unique: a customer identity may hold multiple groups, but **an account may be the
leader of at most one non-disabled group**, and **an account may follow in at
most one non-disabled group** (enforced by partial unique indexes + a
service-level check; see §5 topology).

### `copy_followers`
| column | notes |
| --- | --- |
| `id` uuid PK, `copy_group_id` FK | |
| `account_id` | the follower account |
| `enabled` bool | trader can disable one follower without deleting it |
| `sizing_multiplier` numeric(6,3) nullable | for MULTIPLIER mode |
| `sizing_fixed_qty` int nullable | for FIXED mode |
| `created_at`, `updated_at` | |

Unique `(copy_group_id, account_id)`; an account appears once per group.

### `copy_intents`
| column | notes |
| --- | --- |
| `id` uuid PK, `copy_group_id` FK, `leader_account_id` | |
| `kind` | `SUBMIT` \| `MODIFY` \| `CANCEL` \| `FLATTEN` |
| `idempotency_key` | **unique per group**; the exactly-once identity of a logical action |
| `symbol`, `side`, `qty`, `order_type`, `limit_ticks`, `stop_ticks`, `bracket_config` | the leader action, captured immutably |
| `leader_order_id` | the leader's resulting order (for MODIFY/CANCEL correlation) |
| `state` | `PENDING` \| `FANNED_OUT` \| `COMPLETE` (a bookkeeping state; child rows hold the real outcomes) |
| `created_at`, `updated_at` | |

Unique `(copy_group_id, idempotency_key)` — the concurrency backstop: a retried /
double-clicked / replayed action converges to ONE intent.

### `copy_children`
| column | notes |
| --- | --- |
| `id` uuid PK, `copy_intent_id` FK, `account_id` | |
| `role` | `LEADER` \| `FOLLOWER` |
| `requested_qty` int | the computed quantity for this account |
| `sizing_note` | why this qty (e.g. `MULTIPLIER 0.5 → floor(1.0)`), or why zero/skipped |
| `status` | `PENDING` \| `ACCEPTED` \| `REJECTED` \| `SKIPPED` |
| `order_id` | the real order in the existing `orders` table, once placed |
| `reject_code`, `reject_message` | from `risk.checkOrder` / `OrderRejectedError` |
| `created_at`, `updated_at` | |

Unique `(copy_intent_id, account_id)` — one child per account per intent (the
per-child idempotency backstop). `order_id` references the authoritative
`orders` table; the child row is metadata/orchestration only and never carries
money.

## 3. Ownership & security (server-authoritative)

- A group may contain ONLY accounts whose `user_id` / `customer_identity_id`
  match the group's — verified by a server query on every mutation, never from a
  browser-supplied ownership claim. Cross-customer copying is impossible by
  construction (an account that is not the caller's fails the ownership check and
  is a 404, as elsewhere in the platform — no enumeration signal).
- Same-owner copying **is allowed** and is never flagged as fraud merely because
  trades match; it is the entire point of the feature. (Owner visibility, §CT-K,
  gives operations traceability without treating it as abuse.)
- Every copy endpoint is IDOR-guarded: follower ids, quantities, ownership and
  account state submitted by the client are re-validated server-side.

## 4. Five-active-account invariant (reused)

The platform-wide maximum — **five active accounts per verified identity** — is
unchanged and is *the* reason a V1 group is at most **1 leader + 4 followers**.
Copy trading does not create accounts and cannot conjure a sixth: group
membership is drawn only from the trader's existing active accounts, and
`account-limit.ts` remains the single authority. A group can never reference more
than five distinct active accounts because there can never be more than five.

## 5. Topology (one leader → N followers; no chains, no loops)

- V1 is strictly **one leader → up to four followers**. No chained copying
  (`A→B→C`) and no loops (`A→B`, `B→A`).
- Enforced structurally: an account that is a **leader** of a non-disabled group
  cannot be a **follower** of any non-disabled group, and vice-versa; and an
  account cannot follow the same group twice. Partial unique indexes back the
  service checks so a concurrent create cannot slip a loop through.
- An account may appear in at most one active group in either role.

## 6. Eligibility (checked server-side, at config time AND execution time)

An account may participate only if, verified against authoritative state:
ownership holds; the account is a live `EVALUATION` or `FUNDED_SIM`; its status
is trade-capable (`ACTIVE`, not `PASSED`/`FAILED`/`COMPLETED`/`INACTIVE`, no
disabling `adminHold`); it is not terminal. Eligibility is re-checked at
execution time because state can change between preflight and fan-out (a follower
may breach mid-action). Evaluation + funded accounts may mix freely in one group;
each enforces its own product rules independently.

## 7. Group lifecycle

`ACTIVE` — fans out leader actions. `PAUSED` — accepts no new copy intents
(existing positions/orders untouched; pausing never flattens or cancels).
`DISABLED` — retired by the trader. Transitions:
- leader becomes ineligible → group auto-`PAUSED`, leader cleared, trader must
  pick a new eligible leader (never silent promotion of a follower);
- a follower becomes ineligible → that follower auto-`enabled=false` + divergence
  recorded; the group continues for the others;
- trader pause/resume/disable are explicit; resume re-validates everyone.

Divergence (`SYNCED` / `PARTIAL` / `DIVERGED` / `ERROR`) is a *derived* view over
leader vs. follower positions and the last intent's child outcomes, surfaced per
account with a reason — see `copy-execution-semantics-v1.md` §divergence.

## 8. Fan-out execution (the orchestrator)

`copy-orchestrator.ts` turns one leader action into one `copy_intent` + N
`copy_children`, then executes each child through the existing engine:

1. **Record the intent** under its idempotency key (`onConflictDoNothing`); a
   duplicate returns the existing intent and its children — exactly-once.
2. **Compute per-account quantity** (sizing, §semantics) and write `copy_children`
   PENDING (one per account, unique per (intent, account)).
3. **Fan out in parallel** with `Promise.allSettled`: each child calls
   `engine.submitOrder` (or modify/cancel/flatten) for its account, which runs
   the full risk + execution pipeline under that account's own mutex. A child
   rejection (`OrderRejectedError`) is caught and recorded on that child only.
4. **Never roll back** valid children because one failed — cross-account
   execution is not one transaction. Result is `5/5` or `4/5` etc.
5. **Record + emit** per child (audit + `copy.*` events + outbox) so the web and
   owner surfaces update in realtime with no manual refresh.

The leader is executed as one of the children (role `LEADER`); its own risk
checks apply exactly as they would without copy. Preflight (§CT-D) is a fast
early reject for obvious problems and is **not** final authority — the
execution-time pipeline is.

## 9. Idempotency & concurrency

- The client generates a per-action idempotency key; the server scopes it to the
  group (`unique(copy_group_id, idempotency_key)`). A double-click, a network
  retry, or a reconnect replay converges to one intent and one child per account.
- Each child's `engine.submitOrder` also carries its own `clientOrderId` derived
  deterministically from `(intentId, accountId)`, so the engine's existing
  `orders_client_id_key` unique index is a second backstop against a duplicate
  order per account.
- Group config edits use the `version` column (optimistic concurrency).

## 10. Realtime, restart & recovery

- Copy config is durable server-side, so it survives refresh, WS reconnect,
  logout/login and server restart. On reconnect the web reads the group over REST
  and re-subscribes to each member account's existing channels.
- On server startup a reconciliation sweep re-reads any `copy_intents` left
  `PENDING`/`FANNED_OUT` and resolves each child from the authoritative `orders`
  table rather than blindly replaying execution (idempotency keys make a genuine
  re-drive safe, but recovery *reads* first).

## 11. HTTP surface (all owner-scoped, under `/api/v1/copy`)

`GET /groups`, `POST /groups`, `GET /groups/:id`, `PATCH /groups/:id`
(name/sizing), `POST /groups/:id/leader`, `POST /groups/:id/followers`,
`PATCH /groups/:id/followers/:accountId` (enable/sizing),
`DELETE /groups/:id/followers/:accountId`, `POST /groups/:id/pause|resume`,
`POST /groups/:id/flatten`, `GET /groups/:id/resync` (delta) +
`POST /groups/:id/resync`, `POST /groups/:id/intents` (the fan-out entry for
submit/modify/cancel), `GET /groups/:id/intents` (recent, for the UI/audit).
Eligible-account discovery: `GET /copy/eligible-accounts`.

## 12. Explicit non-goals (V1)

No chained copying; no automatic mini↔micro conversion (same-instrument only,
architected to add later); no silent quantity clamping; no silent resync; no
silent leader promotion; no flatten-on-pause; no live capital / external
brokerage / TradeSea; no new instruments or market-data providers; no
backtesting; no Atlas redesign or portal rebuild.
