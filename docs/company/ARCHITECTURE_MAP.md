# ARCHITECTURE MAP

**Phase 2 — System-Wide Reconciliation. Audit-only.**

Baseline HEAD: `55df4c7` · Branch: `claude/futures-trading-simulator-v8qefu` · Compiled 2026-09-25.

## What this product actually is (as the code self-identifies)

A **futures trading simulator + prop-firm ("funded trader") commerce platform**. Package
name `atlas-futures-terminal`. Execution is **SIMULATION-only** in the wired path; no
real-money rail is connected. The commercial layer (Happy Trader Funding) sells evaluation
accounts, runs them through a rules engine, funds the ones that pass, and pays simulated
payouts with certificates. Marketing copy is explicit that trading is simulated.

## Stack

- **Monorepo:** pnpm workspaces. `apps/web` (React 19 + Vite SPA, path-routed in
  `App.tsx`), `apps/server` (Fastify + Drizzle + PostgreSQL), `packages/{contracts,core,instruments}`.
- **Runtime deps:** PostgreSQL 16 (required). Redis is **declared but entirely unused** —
  real-time fan-out uses Postgres LISTEN/NOTIFY + a transactional outbox instead.
- **Data transport to the terminal:** WebSocket (`/ws`) for market data + account
  "something-changed" signals; REST for authoritative reads/writes.
- **Money:** integer micro-dollars ($1 = 1,000,000).
- **Migrations:** `apps/server/drizzle/` 0000–0034 (35 files); `db/schema.ts` (~197KB);
  135 tables live.
- **CI:** none (`.github` absent). Diagnostics/security tooling exist as manual scripts only.
- **Deployment config:** `docker-compose.yml` provisions only Postgres for local dev. No
  app Dockerfile, no k8s/Terraform, no production compose.

---

## The 17 areas (A–Q)

Legend: BUILT / PARTIAL / BROKEN / DISCONNECTED / STALE-LEGACY / PLACEHOLDER / DEV-ONLY /
NEEDS-REVALIDATION. Statuses describe **runtime wiring**, not test existence.

### A — Web app shell / routing
**BUILT.** `apps/web/src/App.tsx` path-routes between marketing homepage (signed-out `/`),
Atlas terminal, Owner OS (`/admin`), Customer Portal (`/portal`), checkout, onboarding,
affiliates public/portal, and dev-only pages. **DEV-ONLY leak:** `/design-lab` is reachable
in a production build (gated only by a comment — see `KNOWN_ISSUES.md` HTF-4).

### B — Identity / auth / RBAC
**BUILT.** Two spines: `users` (auth principal) vs `customer_identities` (permanent
identity, one-per-user in V1). Access token = short-lived HS256 JWT (15 min); refresh =
opaque 48-byte random, only SHA-256 hash stored, single-use race-safe rotation. Login is
timing-safe against enumeration. RBAC is dual-layer: linear roles (TRADER<SUPPORT<ADMIN<
SUPER_ADMIN, re-read from DB every call) + ~95 granular permissions with per-user
GRANT/DENY, protected-owner permissions that can't be stripped. Step-up reauth
(`x-stepup-token`, 5-min, risk-classed) is genuinely server-verified. Staff onboarding is
invitation-based with last-owner protection.

### C — Customer portal
**BUILT.** `apps/web/src/portal`. Dashboard, accounts (nickname/archive/reset-quote/reset),
account detail + analytics + payout eligibility, performance, payouts + payout methods,
achievements, certificates, billing, support (with attachments + CSAT), risk controls
(optimistic-concurrency), profile/verification/security/notifications, account review
(customer-side enforcement/appeals/self-report). Every page hits real `/api/v1/portal/*`.
Two **DEV shims:** provider-hosted payout-method add is dev/mock; physical-cert payment
uses a `dev/simulate-payment` endpoint.

### D — Atlas terminal (trading UI)
**BUILT, server-authoritative.** `apps/web/src/trading`. The web store is explicitly a
**replica** that "never computes a fill, a position or a P&L figure of its own." WS account
frames trigger a debounced REST re-read; the `pnl` valuation frame is applied directly but
gated by a monotonic per-account `seq` so stale data can't roll money backward. Order entry,
chart (Lightweight/TradingView adapters), instruments, order lifecycle, brackets/OCO, copy
trading, risk panel, journal all wired.

### E — Market data
**BUILT; default is DEV-grade.** Single provider seam (`marketdata/provider.ts`), one
composition point (`bootstrap.ts`). **Default provider = `yahoo-delayed`** — real
exchange-derived but ~600s delayed, OHLCV-only, no depth. Rithmic + Databento are real
adapters, **gated off** by flags defaulting false; selecting one without credentials
fails-fast (never silent-fallbacks to the dev feed). Replay + scripted providers are
recorded/test doubles. Stale-feed detection blocks order entry.

### F — Execution
**BUILT (simulation); external path DISCONNECTED.** The wired hot path is
`AtlasSimulationExecutionProvider` → `TradingEngine`, called directly by the trading routes.
The `ExecutionRegistry` + external safety gate + Rithmic execution adapter exist and are
tested but are **not on the order-submit path** (registry is wired only to admin routes).
No real or mock external execution is reachable in default/production config. Idempotency:
engine dedupes on `(accountId, clientOrderId)`.

### G — Risk
**BUILT, server-authoritative.** Every order passes the firm gate `checkOrder` under the
account lock before acceptance: account status, instrument policy, market open, stale-data
block, quantity, tick/price validity, **max-contracts** (weighted, increasing-exposure
only). Then personal controls (tighten-only) and enforcement holds. Reduce/flatten/
protective/liquidation orders are never blocked. Rules are pure `@atlas/core`, evaluated in
`engine.valuation`; daily boundaries roll drawdown; breach liquidation runs under the mutex.

### H — Commerce (purchase / checkout / webhooks)
**PARTIAL (provider sandbox/mock).** `POST /api/v1/checkout` → resolve EVALUATION product →
enforcement pre-check → pending order → Whop **sandbox** checkout session. Whop client is
**sandbox-only with a hard no-prod-host** and is inert without secrets. Mock provider is the
working default and self-signs events. Webhooks: Standard Webhooks HMAC verification over
raw body, `commerce_events` dedup ledger, normalized event kinds, amounts **not trusted**.
**DANGEROUS-IF-PRODUCTION:** `commerceProviderFromEnv` silently falls back to mock with no
`NODE_ENV` guard (see `KNOWN_ISSUES.md` HTF-1).

### I — Account lifecycle / provisioning
**BUILT (one bypass flagged).** Order → entitlement → gated provisioning
(`fulfillPurchaseGated`) requires identity + contact + agreements OK for PURCHASE/RESET.
Money-success is recorded **before** provisioning so paid-but-unprovisioned parks
recoverably. Idempotency is multi-layered. `MAX_ACTIVE_ACCOUNTS = 5` enforced transactionally
on the commerce path. **Two flags:** (a) a M2M `POST /provisioning/accounts` path bypasses
commercial_orders/entitlements/active-limit (legitimate seam, but a DISCONNECTED bypass of
invariants); (b) the active-slot counter excludes LOCKED/GOAL_REACHED, so day-locked
accounts don't consume a slot (possible over-provisioning). See `KNOWN_ISSUES.md`.

### J — Payouts
**BUILT & WIRED; provider MOCK/UNCONFIGURED.** Two state machines: economic
(REQUESTED..PAID, single debit at APPROVED, unique-ledger-key double-debit protection) and
operational (RECEIVED..RECONCILED, STP fast lane, exception lanes, reconcile-not-retry on
lost ack). `UnconfiguredPayoutProvider` fails closed; mock never runs in production. No real
bank/ACH rail exists. See `MONEY_FLOW.md`.

### K — Certificates / achievements
**BUILT & WIRED.** All four core triggers fire from live publishers (evaluation.qualified,
account.funded, payout.paid, account.completed). Exactly-once issuance, SAFE public display
fields only, deterministic render (canvas + pdfkit), write-once object store (S3 seam
disabled, LOCAL default). 5 v1 master templates on disk (funded-trader, payout,
account-completed, 10k/50k-club); EVALUATION_PASSED and 100K-club deliberately excluded from
renderable types. Physical fulfillment = MOCK (Prodigi disabled).

### L — Affiliates
**BUILT.** Application → review → agreement → activation lifecycle; referral link/click +
attribution; commission engine (exactly-once, append-only ledger); tiers + rate history;
refund/chargeback reversals; affiliate payout state machine (provider NOT_CONFIGURED).
Public intake + self-service portal + owner controls all wired. **One idempotency gap** in
`markPayoutPaid` (see `MONEY_FLOW.md`).

### M — Support
**BUILT.** Ticket lifecycle, messaging, customer center, owner inbox + workspace, object
linking + investigation timeline, disputes, remediation/refund approval (four-eyes), SLA +
escalation + incidents, attachments, templates/KB. Some backend features (config edit,
templates, KB, merge/split, incident-link, owner attachment download) have **no UI**.

### N — Enforcement (prohibited conduct)
**BUILT & WIRED.** Cases, signals, evidence, findings, actions, holds (capability-scoped:
TRADING/PAYOUT_REQUEST/PAYOUT_APPROVAL/PURCHASE/ACCESS), appeals, info requests, policy
acceptance. Integrated into payout/commerce/auth via holds. Owner workbench + customer
review/appeal UI both present.

### O — Economics
**BUILT ×2, both SIMULATION-only.** v1 (`economics-sim.ts`) and v2 (M13.0,
`platform/economics/`) both live and exposed side-by-side, SUPER_ADMIN only, persisted
immutably in `economics_runs`. v2 derives authoritative product inputs from `@atlas/contracts`
(the catalog, not the DB) and labels assumptions as non-fact. v1 is superseded but active;
v2 reuses v1's PRNG so v1 isn't trivially removable.

### P — Infrastructure
**PARTIAL.** DB (dual pool: queries + dedicated lock pool). In-process workers: transactional
outbox (SKIP LOCKED, backoff, dead-letter), account-changed LISTEN, notification worker,
auto-certify/auto-fund, provisioning recovery, copy-breach, payout-ops worker. **Inactivity
sweep expects an external cron that is not present in-repo (DEV-ONLY).** Object store LOCAL
(S3 disabled). Email/SMS = mock (Resend/Twilio seams suppress rather than fake). Health =
liveness only; no `/ready`, no metrics endpoint, no tracing. Secrets env-only with a
production boot guard (exits if dev JWT secret or `CORS_ORIGIN=*` in prod). **No CI, no
backups in-repo.**

### Q — Owner OS (admin console)
**BUILT (large backend/UI exposure gap).** 22 nav routes, all load real backend data
(verified in-browser in Stabilization P1). A second-generation "Owner OS (M10-K)" backend
under `/api/v1/admin/ops` is **largely BACKEND-ONLY** — the web app calls only a small
read-subset. Notably **read-only-in-UI but mutable-in-backend:** kill switches, feature
flags, alerts (ack/resolve), incidents (create/transition), staff lifecycle + impersonation.
Global search/object-explorer/inspect/correlation, finance/treasury summary, second customer
console, and owner balance-adjust have **no UI at all**. See `SYSTEM_STATUS.md` and the UI
exposure findings in the final report.

---

## Cross-cutting architectural strengths (proven, not claimed)

- **Server authority for all money/state.** Prices arrive as decimals and are snapped to the
  instrument tick grid server-side; P&L/equity/drawdown computed only by the engine; account
  and order IDs always ownership-checked (IDOR-guarded).
- **Append-only, hash-chained audit log** per organization; DB refuses UPDATE/DELETE;
  `verifyAuditChain` walks the chain.
- **Transactional outbox + LISTEN/NOTIFY** for reliable cross-process fan-out without Redis.
- **Immutable versioned config** for products (append-only versions) and immutable
  economics runs.
- **Honest degradation:** unknown/unavailable data propagates as UNKNOWN rather than being
  fabricated; real providers fail-fast or fail-closed. **Phase 4** added a central
  provider-safety boundary (`config/provider-safety.ts`) so the commerce, identity and
  notification selectors also fail closed in production (never a mock) — the last fail-open
  paths are gone.

## Cross-cutting architectural risks (see `KNOWN_ISSUES.md`)

- ~~Two provider selectors fail-open to mock in production (commerce, identity/KYC).~~
  **Resolved (Phase 4):** all mock-capable selectors route through `config/provider-safety.ts`
  and fail closed in production.
- Two competing seeds: default `db:seed` produces the legacy Atlas catalog with
  payout-incompatible rule shapes; the 10 HTF products come from a separate manual script.
- Runtime product authority (DB) diverges from the public site (catalog) on 4 properties.
- Large Owner-OS backend/UI exposure gap, including safety controls (kill switches) that are
  view-only in the console.
- No CI, no backups in-repo, no production deploy manifests, inactivity cron unbound.

## PROVENANCE

Compiled from six parallel read-only code audits + a full local stack boot + direct DB
inspection. Money/trust-critical claims (provider fail-open, seed wiring) were verified
personally against source. No file was modified in producing this map.
