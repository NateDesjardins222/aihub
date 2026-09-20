# Atlas — Owner Control Center V1 plan

Baseline `d5bc19b`, remote = local, tree clean.

## Phase 1 — architecture autopsy

The honest headline: **Atlas already has most of an owner console.** There is a
real `/admin` app (Overview, Users, Accounts, Account detail, Products) served
as a separate lazy bundle, backed by a real, role-gated admin API with
append-only hash-chained audit. This milestone is far more "expose the gaps,
refocus the vocabulary, and test hard" than "build from scratch." Building a
parallel dashboard would duplicate working infrastructure, so V1 extends the
existing `/admin` shell rather than replacing it.

### EXISTS AND WORKS (verified by reading the code)

* **Roles & gating.** `requireRole('SUPPORT'|'ADMIN'|'SUPER_ADMIN')` on the
  admin route group; read is SUPPORT, mutate is ADMIN, changing what a
  product/person may be is SUPER_ADMIN. Per-route rate limits.
* **Org isolation.** Every admin query filters `organizationId = organizationOf(user)`;
  cross-org reads 404 rather than leaking existence. (To be re-tested hostilely.)
* **Overview endpoint** (`GET /admin/overview`): user counts (total/active),
  account-status breakdown, aggregate balance/realized/fees/starting, open
  positions + contracts, working orders, 24h fills/volume, trade stats, recent
  activity. Real SQL over authoritative tables.
* **Users** (`GET /admin/users`), create user (ADMIN), disable/enable user
  (ADMIN, with reason + audit), role change (SUPER_ADMIN).
* **Accounts** (`GET /admin/accounts` with status filter + search joining the
  trader; openContracts and lastTradedAt computed), account detail
  (`GET /admin/accounts/:id`), live account snapshot (`/accounts/:id/live`).
* **Account lifecycle actions** (ADMIN, each with reason + audit):
  activate, lock/unlock (**this is Admin Hold**), disable/enable, archive,
  **reset** (through the real reset lifecycle with open-position safety).
* **Provisioning** (`POST /admin/accounts`): grants an account through the
  centralized `provisionAccount` service — the same path normal provisioning
  uses, not a shortcut.
* **Products** (`GET /admin/profiles`) with immutable **product versions**;
  publish a new version (SUPER_ADMIN) via `publishProfileVersion` — existing
  accounts stay pinned to their version.
* **Audit** (`GET /admin/audit` filterable by account/user/action) and
  **`GET /admin/audit/verify`** running the hash-chain verifier; **`/admin/events`**
  (outbox).

### EXISTS BUT NEEDS EXPOSURE (the real V1 gaps)

* **Trading surveillance page.** The data exists per-account (`/accounts/:id/live`)
  and in aggregate (overview counts), but there is no firm-wide rows view of
  open positions / working orders / recent fills joined to trader+account.
  → New read endpoints + a Trading page.
* **Risk page.** No page ranks accounts by remaining loss limit, on-hold, or
  largest unrealized loss. The inputs exist (account rule state + positions).
  → New read endpoint + a Risk page with transparent factual ordering.
* **System health page.** `/health` exists and the market-data provider exposes
  connection + freshness state, but there is no owner-facing System view that
  says HEALTHY / DEGRADED / DELAYED honestly. → New aggregation endpoint + page.
* **Vocabulary.** Nav says "Users"; the owner thinks "Traders". Refocus the nav
  to Overview / Traders / Accounts / Trading / Risk / Products / System.

### EXISTS BUT NEEDS HARDENING

* Grant-account idempotency under double-submit — provisioning is centralized;
  to be tested aggressively at the HTTP layer.
* Cross-org and role-escalation attempts on every new endpoint — to be tested.

### MISSING AND REQUIRED FOR V1

* The three read endpoints and pages above (Trading, Risk, System). Nothing
  else in the V1 nav is missing at the data layer.

### DEFERRED (documented, not faked)

* Payments, payouts, affiliates, promotions, billing, revenue — no backend;
  explicitly out of scope (Phase 72).
* Product **editing UI** with change-preview (Phase 38–39): the publish backend
  exists and is exposed read-only + via API; a full visual editor with diff
  preview is deferred to keep V1 honest and focused. Publishing remains
  available through the versioned API.
* 10k-row virtualization (Phase 48): current lists paginate server-side; a
  virtualized table is deferred until dataset size justifies it.
* Owner-action torture harness (Phase 61) and the full 150+150 manual matrices:
  a focused server-test + the existing execution torture cover the critical
  invariants; the exhaustive matrices are deferred and named.

## Metric definitions (Phase 6)

* **Active accounts** = accounts with `status = 'ACTIVE'`. Practice, evaluation
  and funded are all account *products*, not statuses; "active" is the lifecycle
  state, distinct from HELD/FAILED/ARCHIVED/DISABLED.
* **Open positions** = rows in `positions` with non-zero qty on accounts in this
  org. **Open contracts** = sum of abs(qty).
* **Working orders** = orders in a working state on this org's accounts.
* **Today's realized** = aggregate `realizedPnlMicros` (net of fees where the UI
  says so), from authoritative account rows — not browser math.
* **Admin hold** = account `status = 'LOCKED'` (the lock/unlock action).

## Acceptance for V1

Owner can: open Atlas → understand the firm → find a trader → inspect →
grant an account (once, idempotent, audited) → inspect trading → control access
(hold/reset/disable, each audited) → inspect risk → read product versions →
trace audit → verify system health — all on authoritative server state, with
org isolation and role enforcement tested hostilely.
