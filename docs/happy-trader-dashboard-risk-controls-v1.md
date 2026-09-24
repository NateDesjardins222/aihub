# Happy Trader Dashboard V2 + Trader Risk Controls V1 — architecture & plan

**Milestone 5.** Two joined deliverables on the existing Atlas / Happy Trader
platform:

1. **Happy Trader Dashboard V2** — a premium, luxury redesign of the customer
   business/account/performance/control center at `/portal`, with a real design
   system (dark graphite + a genuine light theme), a global account switcher,
   redesigned dashboard + account cards, an interactive equity/performance
   experience, a P&L calendar, and clearer payout/rules/activity surfaces.
2. **Trader Risk Controls V1** — a **server-authoritative** personal risk-control
   system that can only make an account MORE restrictive, enforced on the normal
   authoritative order/risk path, surviving restart/multi-device, respecting copy
   trading, and never able to loosen firm rules.

> **Authoritative principle.** Happy Trader **surfaces** truth; it never invents
> it. Every monetary/risk/performance value has a server source. The browser can
> never enforce risk, forge account ownership, or loosen a firm/locked rule.

Starting HEAD: `290dda2` (Milestone 4 complete).

---

## 1. Product separation (non-negotiable)

Three surfaces, already separated by pathname in `apps/web/src/App.tsx` (no router
lib); this milestone keeps the boundary:

- **Happy Trader** — customer portal at `/portal` (`PortalApp`). Business,
  accounts, performance, payouts, achievements, billing, support, **personal risk
  controls**. NOT a trading terminal: no chart trading, DOM, order ticket, or
  execution controls live here.
- **Atlas** — the trading terminal at `/` (`TerminalShell`). Charts, order entry,
  positions, execution.
- **Owner console** — operational/admin at `/admin/*` (`AdminApp`).

The portal carries a persistent **Trade → / Trade in Atlas →** that opens Atlas
with the selected account **server-validated** (ownership, lifecycle,
trade-enabled). The browser cannot forge account ownership or trade permission.

---

## 2. Reuse map — authoritative systems (do NOT fork)

| Concern | Authoritative source | Surfaced how |
| --- | --- | --- |
| Auth principal / sessions / RBAC | `auth-plugin.ts` (`requireUser`, `requireRole`, re-reads role from DB) | portal bearer JWT |
| Account ownership (IDOR guard) | `portal.ts` `assertOwned` / `ownedAccount` (`WHERE id=? AND userId=?`) | every portal route |
| Portal account list + slots | `portal-accounts.ts` `listPortalAccounts` → `{accounts, activeSlotsUsed, maxActiveSlots=5}`, `portalState()`, `consumesSlot()` | `GET /api/v1/portal/accounts` |
| Account detail + lifecycles | `portal.ts` `portalAccountDetail` | `GET /api/v1/portal/accounts/:id` |
| Analytics (equity/trades/days/breakdowns/drawdown/MLL) | `analytics-core.ts` + `analytics.ts` `accountAnalytics` | `GET /api/v1/portal/accounts/:id/analytics?from&to&instrument&side` |
| Account risk fields (equity, dayPnl, remaining loss/drawdown, target progress, winning days) | `accounts.ts` `presentAccount` | `GET /api/v1/accounts` |
| Risk bands (drawdown/consistency) | `rule-status.ts` `drawdownStatus`/`consistencyStatus` (exists, unexposed) | **new** status route (M5-D) |
| Payout eligibility / caps / split / reasons / cycles | `payout-core.ts` `evaluatePayoutEligibility` + `payouts.ts` `getPayoutEligibility` | `GET /api/v1/payouts/eligibility/:accountId` (`presentEligibility`) |
| Product versions / firm terms | `profiles.ts` (immutable `account_profile_versions`), `seed-htf-products.ts` (the 10 products) | via account's pinned version |
| Firm risk rules | `packages/core/src/rules/rules.ts` `evaluateRules`, `account-rules.ts` `applyRules`, `trading/risk.ts` `checkOrder` | order path |
| Certificates / achievements | `certificates.ts`, `achievements.ts`, `recognition.ts` | `GET /api/v1/portal/certificates`, `/achievements` |
| Notifications | `notifications.ts` `enqueueNotification` (extend `NotificationType`) | delivery + **new** read route (M5-J) |
| Audit / events | `audit.ts` `recordAudit`, `events.ts` `events.publish`, engine `recordRisk`→`risk_events` | reused directly |
| DB / migrations | `db/client.ts`, `db/schema.ts`, drizzle (next: `0023`) | additive only |

**Net-new for M5:** the design system + shell + theme + switcher; interactive
performance + P&L calendar; a per-day trades route; a status/risk-bands route;
the **Trader Risk Controls** domain (schema + API + pure evaluator + engine gate
+ fill-time counters + locked-mode/trading-day lifecycle + owner read views);
Atlas `?account=` handoff consumption.

---

## 3. UI architecture (Happy Trader V2)

- **Design system** (`apps/web/src/portal/design/`): CSS custom-property tokens on
  `[data-pt-theme="dark"|"light"]` — surfaces, text hierarchy, hairlines, chrome
  silver, restrained gold, restrained pos/neg/status, radii, type scale, tabular
  numerals. **Genuine light theme** (not inverted). Theme preference persists
  (localStorage + document attribute; safe try/catch). Typography: **DM Sans
  Variable** (already self-hosted) with tabular figures for money/data; JetBrains
  Mono only where raw. Shared primitives (`Card`, `Pill`, `Metric`, `Stat`,
  `Money`, `Button`, `Toggle`, `Sparkline`, `Skeleton`, `EmptyState`).
- **Shell** (`PortalShell`): top nav **Dashboard · Accounts · Payouts ·
  Achievements · Billing · Support**, persistent **Trade →**, avatar menu
  (Profile · Verification · Security · Notifications · Log Out), and a **global
  account switcher** available across the authenticated experience (compact per
  active account: nickname, size, product family, status, balance, net P&L).
  Routed by pathname under `/portal/*` with a `popstate` listener (upgrade from
  the current local-state-only routing) so URLs are shareable and the switcher
  is deep-linkable; guards against IDOR (server owns ownership).
- **Pages**: Dashboard (command center), Accounts (cards), Account detail
  (Overview / Performance / Controls / Rules / Activity), Payouts, Achievements,
  Billing (existing checkout/reset links), Support (shell). Loading / empty /
  error / skeleton states throughout; keyboard nav, visible focus, semantic
  controls, contrast, reduced-motion.
- **Charts**: interactive equity curve as bespoke inline SVG (hover crosshair,
  point/day click, range filters 1D/7D/30D/90D/ALL/Custom, tooltip), fed by the
  authoritative analytics equity points + a new per-day trades route for the
  day → trades → trade drilldown. P&L calendar shares the same day drilldown.

Atlas is **not** redesigned. Atlas changes are limited to: consuming the
`?account=<publicId>` handoff (server-validated selection), surfacing personal
reject reasons as clear messages, and — if architecturally clean — sharing the
account-switch context.

---

## 4. Trader Risk Controls — domain

### 4.1 Storage (migration `0023`, additive, first-class)

- **`trader_risk_controls`** — one row per `(accountId, controlType)`. Columns:
  `id, organizationId, accountId, userId, controlType, enabled(bool),
  mode('FLEXIBLE'|'LOCKED'), valueMicros(bigint?), valueInt(int?),
  windowStart(varchar?), windowEnd(varchar?), sessionsJson(jsonb?),
  lockedAt(timestamptz?), lockedTradingDay(date?), version(int, CAS),
  createdAt, updatedAt`. Unique `(accountId, controlType)`. Account- and
  owner-scoped.
- **`trader_risk_control_events`** — append-only audit of every change: `id,
  organizationId, accountId, userId, controlType, action, oldState(jsonb),
  newState(jsonb), mode, effectiveTradingDay(date), actorUserId, source,
  createdAt`.
- **`trader_risk_day_state`** — running per-`(accountId, tradeDate)` counters,
  maintained at fill time inside the engine's match transaction: `id, accountId,
  tradeDate, openingTradeCount(int), contractsOpened(int),
  consecutiveLosses(int), lastLossClosedAtMs(bigint?), dayHighEquityMicros
  (bigint?), realizedNetPnlMicros(bigint), profitLockArmed(bool), updatedAt`.
  Unique `(accountId, tradeDate)`. A new trading day = a new row → counters reset
  for free (trading-day rollover is intrinsic, keyed by the authoritative
  `accountTradingDate()`).
- Reuse `orders.openedExposure` (new bool column on `orders`) to count an opening
  order **once** regardless of partial fills.

### 4.2 The 10 controls

| Control | value | reject reason |
| --- | --- | --- |
| Personal Daily Loss Limit | `valueMicros` | `PERSONAL_DAILY_LOSS_LIMIT` |
| Max Trades Per Day | `valueInt` | `PERSONAL_MAX_TRADES` |
| Personal Daily Drawdown | `valueMicros` | `PERSONAL_DAILY_DRAWDOWN` |
| Max Position Size | `valueInt` (contracts) | `PERSONAL_MAX_POSITION` |
| Max Total Contracts / Day | `valueInt` | `PERSONAL_DAILY_CONTRACT_LIMIT` |
| Daily Profit Lock | `valueMicros` | `PERSONAL_PROFIT_LOCK` |
| Consecutive Loss Lock | `valueInt` (losses) | `PERSONAL_CONSECUTIVE_LOSS_LOCK` |
| Loss Cooldown | `valueInt` (minutes) | `PERSONAL_COOLDOWN` |
| Trading Window | `windowStart`/`windowEnd` (HH:MM, exchange tz) | `PERSONAL_TRADING_WINDOW` |
| Session Restriction | `sessionsJson` | `PERSONAL_SESSION_RESTRICTION` |

New `PERSONAL_*` codes are added to the `RejectReason` union in
`packages/contracts/src/trading.ts`. Exact usage/trade/loss/drawdown/day
semantics are locked in `docs/trader-risk-controls-semantics.md`.

### 4.3 The gate (order path)

A pure evaluator `evaluatePersonalRisk(config, dayState, ctx, request):
RiskRejection | null` sits beside `trading/risk.ts`. It is called from
`engine.submitLocked` **only when firm `checkOrder` returned `null`** (personal
rules never remove a firm rejection — most-restrictive composition), and **only
against the exposure-increasing portion** (`increasingQty`): if the order does
not increase exposure it always passes (reduce / flatten / protective stop /
protective target / cancel are never blocked — the core safety semantic). A
breach reuses the engine's `recordRisk` + `throw OrderRejectedError`, so it
surfaces identically over HTTP and to every copy-trading follower with no
orchestrator changes. Firm limits remain authoritative: `effective =
min(firm, personal)`.

### 4.4 Flexible vs Locked

Each enabled control is `FLEXIBLE` or `LOCKED`. `LOCKED` is enforced
**server-side**: until the next authoritative trading day the trader may
**tighten** (a per-control `isStricter` comparator) but may not loosen or disable
it. Locking requires explicit confirmation and persists `mode/lockedAt/
lockedTradingDay/version` + an audit event. Expiry is computed from
`accountTradingDate()` vs `lockedTradingDay` on every mutation — no cron needed.

### 4.5 Concurrency & performance

`version` CAS under a per-account advisory lock; a stale concurrent edit fails
with `STALE_ORDER_VERSION`. The gate reads the account's controls (small, cached
per account with deterministic invalidation on any control write) plus one
indexed `trader_risk_day_state` read plus values already loaded by the engine
(position, openContracts, day P&L). Added gate latency is measured in a
deterministic benchmark (M5-L). Correctness before micro-optimization.

---

## 5. Migration plan

Single additive migration `0023_trader_risk_controls.sql`: three new tables +
`orders.openedExposure`. No historical migration edited. Applied to `atlas` and
`atlas_test` and verified. Schema definitions updated in `db/schema.ts`.

---

## 6. Test plan

- **Deterministic risk-control torture suite** (≥40 cases, `ScriptedMarket` +
  real test DB, injected exchange clock): CRUD, ownership/IDOR, enable/disable,
  typed-value persistence, OFF-preserves-value, firm-authoritative composition,
  each of the 10 locks, trading-day rollover, flexible edits, locked cannot
  loosen / can tighten / expires, restart persistence, concurrent-update
  protection, exits/flatten/protective allowed while locked, increasing rejected,
  reversal + partial-fill trade-count semantics, payout-debit/reset not counted as
  loss, copy leader-accepted/follower-rejected + no rollback of others, cross-
  account/customer isolation, malformed/negative/oversized values, structured
  reject reasons, audit events, lifecycle restrictions (completed/failed).
- **Regression kept green**: copy-trading, payout, account-lifecycle suites.
- **Flake baseline (spec §39)**: M4 ended 731/734 with 3 pre-existing real-clock
  trading-engine flakes (`adversarial`/`engine`/`rules.integration`/`determinism`);
  M4 changed zero `src/trading` files. M5 necessarily touches the order path, so
  we establish the baseline first, and if a clean deterministic fix removes the
  real-clock flakiness without changing trading semantics we apply it; otherwise
  we document precisely what is pre-existing vs introduced. No weakened
  assertions, no arbitrary sleeps.
- Server + web typecheck clean; production web build; migrations verified.

## 7. Browser acceptance plan

Extend `tests/browser/harness.mjs` + a new `happy-trader-acceptance.spec.mjs`
driving the real app/server/DB: login, dashboard, dark/light/persist, switcher,
cards, Overview, interactive equity curve + date filters + day click + trade
drilldown, P&L calendar, Rules, Activity, Controls (typed value ≠ enabled →
switch ON → refresh persists → OFF preserves → re-enable → Locked +
confirmation → loosen rejected → tighten accepted), Atlas handoff with selected
account, a deterministic personal limit triggering a rejected increasing order
while flatten/protective still work, copy follower personal rejection, payout
view, achievements, responsive smoke, owner read-only, no cross-account stale
data, no IDOR, logout/login persistence. Screenshots for key states.

## 8. Security

Every new endpoint: `requireUser` + server-side ownership; no IDOR; no trusting
`accountId`/`customerId` from the browser without authorization; locked controls
cannot be loosened through direct API calls; firm limits cannot be bypassed;
archived/failed/completed accounts cannot improperly mutate controls; owner
views read-only (no "turn off trader lock" backdoor); no secrets/credentials in
the bundle.

## 9. Known limitations / flags (from the audit)

- **`COMPLETED` / max-5-payout-cycle transition has no server producer today**
  (the state, event, notification, certificate are all wired to *consume* it, but
  nothing sets `status='COMPLETED'`). M5 renders `COMPLETED_MAX_PAYOUTS`
  truthfully **when present** and never represents it as FAILED, but does not add
  the producer (out of scope; preserving the payout state machine per §44). Flagged.
- **No in-portal notifications inbox route** exists; M5 adds a read-only route
  over `notification_messages` scoped by `customerIdentityId` (reusing the
  existing notification store — not a second engine).
- Session Restriction is implemented only to the extent the authoritative
  calendar/session model supports deterministically; no fake sessions are
  invented.
