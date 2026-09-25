# Milestone 10 — Happy Trader Owner Operating System — Architecture (V1)

Status: **implementation contract for M10.** Starting HEAD `b2663e9`, branch
`claude/futures-trading-simulator-v8qefu`. This document records what already
exists (the §0 audit) and the design M10 builds on top of it. It describes
**actual implemented behavior** as each checkpoint lands; aspirational items are
called out as DEFERRED.

The objective is not "a nicer admin dashboard." It is the internal operating
system / control plane from which the owner and authorized staff can understand,
investigate, operate, test, configure and **safely** control everything built
through M9 — answering, for every subsystem, the seven questions: what is
happening, what happened, why, who/what caused it, is the system correct, what
can I safely do, and can I prove it afterward.

---

## 0. Non-negotiable safety principle

Owner power ≠ unsafe mutability. Every action that can materially affect customer
money, payout eligibility, balance, lifecycle, trading permissions, access,
enforcement, economics, staff privileges, provider config or production
availability is: **authenticated, authorized (granular), reason-coded, validated,
audited**, and where practical **previewable, reversible via compensating action,
and re-authenticated**. There are **no raw DB mutation buttons, no editable
balance field, and no silent deletion of history.** Financial corrections are
append-only ledger/adjustment records; lifecycle corrections preserve prior
state and provenance.

---

## 1. What already exists (audit result)

M10 **reuses and integrates** these; it does not rewrite them.

### 1.1 Auth / RBAC (today)
- One `users` table (`db/schema.ts`), customers and staff share it, distinguished
  only by `role varchar(16)`: linear `TRADER < SUPPORT < ADMIN < SUPER_ADMIN`
  (`RANK` in `http/auth-plugin.ts`). Owner seed: `owner@atlasfutures.local`
  (SUPER_ADMIN). `status ACTIVE|DISABLED`. No MFA/verified/invite columns.
- scrypt password hashing (`auth/password.ts`); stateless HS256 JWT access token
  (`auth/tokens.ts`); rotating opaque refresh tokens in `refresh_tokens`
  (hash-only, replay-detecting) with `auth/service.ts:revokeAllSessions`.
- Authorization is entirely `requireUser` + `requireRole(min)` preHandlers
  (`http/auth-plugin.ts`); `requireRole` **re-reads the DB** (token role not
  trusted). No granular permissions, no `requirePermission`, no impersonation,
  no operator MFA/step-up, no session manager.

### 1.2 Audit / events / jobs (reuse targets)
- **`audit_log`** — append-only (DB trigger blocks UPDATE/DELETE), **hash-chained
  per org**, written by `platform/audit.ts:recordAudit`, verified by
  `verifyAuditChain`. Actor from `platform/actor.ts` (`USER|ADMIN|SYSTEM|SERVICE`
  — no on-behalf-of dimension yet). This is THE table for owner actions / change
  history. It has `request_id` + `context jsonb` but **no `correlation_id`
  column** (M10 carries correlation inside `context`).
- **`domain_events`** — outbox/event bus; **`outbox_events`** — the generic
  transactional job/queue with `available_at`, `attempts`, `dead_letter` (the
  jobs/DLQ primitive; drained FOR UPDATE SKIP LOCKED). `account_events` is the
  engine's per-account sequenced stream (not a general log).
- Check-result pattern: `payout_operational_checks` (PASS|FAIL|SKIP + detail).
  Kill-switch/config pattern: `payout_operations_config` (`production_enabled`,
  `circuit_breaker_open`) + append-only `payout_circuit_breaker_events`.

### 1.3 Domain subsystems (server-authoritative integration points)
M10's inspectors **consume** these, never re-derive rules:
- **Accounts**: `platform/projection.ts` (`readAccountProjection`,
  `valueProjection → ValuedProjection`); `trading/engine.ts:valuation().rules →
  RuleStatus` (breach codes `MAX_LOSS_LIMIT|TRAILING_DRAWDOWN_BREACH|
  DAILY_LOSS_LIMIT|MAX_TRADING_DAYS`, `requirements[]`, `consistency`, `canTrade`)
  from pure `@atlas/core/rules`. Transitions via `platform/account-service.ts`
  (`lock/unlock/disable/enable/archive/resetAccount`, reason-coded
  `AccountActionError`). **Three status axes**: `accounts.ruleStatus` (engine),
  `accounts.adminHold` (operator), `accounts.status` (effective); enforcement
  holds are a separate axis in `enforcement_holds`.
- **Personal risk (M5)**: `trading/personal-risk.ts:evaluatePersonalRisk →
  RiskRejection|null`; view via `platform/personal-risk.ts`. 10 control types.
- **Payouts (M8)**: `platform/payout-core.ts:evaluatePayoutEligibility →
  PayoutEligibility{reasonCodes: PayoutReasonCode[], …, currentQualifyingBalance,
  requiredNextQualifyingBalance}`; service `platform/payouts.ts`
  (`getPayoutEligibility`, state machine); ops `platform/payout-operations.ts`.
- **Enforcement (M7)**: `platform/enforcement.ts` (`enforcementSummary`,
  `listHolds`, `caseDetail`, `placeHold`); hot-path `enforcement-holds.ts:
  holdBlocking`. **`NON_MISCONDUCT_CODES`** must never be shown as findings.
- **Commerce/identity**: `platform/owner-customer.ts` (`customerDetail`,
  `provisioningExceptionQueue` = paid-but-not-provisioned, `reconciliation`,
  `exceptionCounts`); `provisioning-gate.ts:evaluateProvisioningGate`;
  `commerce.ts:provisionFromEntitlement`.
- **Resets**: `account-reset.ts` (`resetQuote`, `createResetOrder`) / courtesy via
  `account-service.resetAccount`; preservation via `accountLifecycles` +
  `accounts.resetOfAccountId`.
- **Certificates (M6)**: `certificates.ts` (`issueCertificate` — event-gated,
  exactly-once by `dedupeKey`; `publicVerification`). M10 reacts to
  `certificate.issued`; never issues directly.
- **Copy (M3)**: `copy-groups.ts:listGroupViews`; breach isolation automatic.
- **Provider health (M4/M9)**: `infra/health.ts:buildInfraHealth →
  InfraHealthSnapshot`; `reconciliation.ts:getReconciliationState`;
  `rithmic/*` truthful config (`resolveRithmicConnection`).
- **Product catalog** is data-driven: `account_profiles` +
  `account_profile_versions` (immutable), read via `platform/profiles.ts`.

### 1.4 Owner console (today)
- Web shell `apps/web/src/admin/AdminApp.tsx` (hand-rolled router: `AdminRoute`
  union, `NAV`, `parseAdminRoute`/`adminPath`, `<main>` switch). Shared kit
  `admin/shared.tsx` (`Panel`,`Stat`,`Money`,`StatusPill`,`AuditTable`,
  `ConfirmAction`,`useLoad`,`usePagedList`). Client `admin/api.ts` (`adminApi`,
  base `/api/v1/admin`) + `admin/types.ts`. Styling `Admin.css` (`.adm-*`), which
  uses the terminal's **single dark** token set (`styles/theme.css`). **No
  dark/light toggle** in admin today; the `/portal` two-theme system
  (`portal/theme.ts`, `data-pt-theme`, `#0B0B0C`, gold `#c8a24a`) is the pattern
  M10 adapts.
- ~19 existing pages: Overview, Users, User, Accounts, Account, Customers (360),
  Trading, Risk, Funding, Payouts, Economics, Audit, Products, Product,
  Enforcement, PayoutOperations, System, Infra, CertificateStore.
- Server route modules under `http/routes/`: `admin.ts` (floor `SUPPORT`),
  `payouts.ts`, `customers.ts`, `enforcement.ts`, `payout-ops.ts`; registered in
  `http/app.ts` via `app.register(module, { prefix })`.

---

## 2. M10 design decisions

### 2.1 Granular RBAC (backward compatible)
- Add a **permission catalog** (`platform/permissions.ts`): dotted strings
  (`customers.read`, `payouts.adjust`, `system.kill_switches.manage`, …), grouped.
- Keep the 4 legacy roles as the coarse rank AND introduce a **role → permission
  map** (`platform/rbac.ts`) so `SUPER_ADMIN` implies all, `ADMIN`/`SUPPORT` map
  to sensible defaults, plus **per-user granular overrides** stored in a new
  `staff_permissions` table (grant/deny). Authorization uses a new
  `requirePermission(perm)` preHandler that (a) re-reads the user's role+status
  from the DB (like `requireRole`), (b) computes the effective permission set from
  role defaults ± overrides, (c) 403s if missing. `requireRole` is retained; all
  new M10 routes use `requirePermission`. **Server-enforced; UI hiding is never
  authorization.** Every M10 route has a test that calls it with a token lacking
  the permission.
- **Owner protection** (`platform/owner-guard.ts`): the last remaining
  reachable OWNER/SUPER_ADMIN cannot be disabled, demoted, or stripped of
  ownership; ownership transfer is a deliberate separate flow (DEFERRED beyond a
  guard). Enforced server-side in staff mutations.

### 2.2 Staff lifecycle & invitations
- New `staff_invitations` (email, role, token hash, invited_by, status
  `INVITED|ACCEPTED|REVOKED|EXPIRED`, expires_at). Owner creates staff by email;
  the invite carries a time-limited single-use activation token (hash stored, raw
  returned once to the creating call / delivered via notification seam) → invitee
  sets their **own** password (reusing `auth/password.ts`). Owner never sees or
  stores the password. Staff states map to `users.status` plus invite state.
  MFA is architected as a readiness flag (`users` gains an MFA-enrolled column;
  actual TOTP enrollment DEFERRED, surfaced honestly as NOT_ENROLLED).

### 2.3 Reauth / break-glass
- New `reauth` primitive: a short-lived, single-purpose **step-up token** minted
  by re-verifying the operator's password (`POST /admin/security/reauth`), scoped
  to a risk class, consumed by high-risk endpoints via a `requireReauth(class)`
  preHandler. Break-glass = a high-risk action that additionally requires an
  explicit reason + confirmation and writes an **enhanced** audit event and an
  owner alert. Break-glass increases auditing; it never bypasses it.

### 2.4 Impersonation ("View as customer")
- New `impersonation_sessions` (operator_user_id, target_user_id, reason,
  started/ended, originating session, status). A short-lived support token with an
  `imp` claim marks the session; **default is read-only/safe support mode** and
  dangerous customer actions (trade, password/destination change, purchase, payout
  request, identity change, destructive account ops) are refused for impersonated
  tokens server-side. Every start/stop is audited with both the operator and the
  target as distinct actors. Owner can terminate active impersonations.

### 2.5 Canonical operational event model
- Reuse `audit_log` for **staff/system change events** (what changed) and
  `domain_events` for **activity events** (what business objects did). Add a
  read-side **operational event query** (`platform/ops-events.ts`) that unifies
  both plus provider/security event sources behind one typed query API with
  filters (subject, account, correlation, time, severity, source) — **without a
  duplicate event table.** Correlation lives in `audit_log.context.correlationId`
  and `domain_events.payload.correlationId`. The four logging concepts (activity,
  audit, technical, security) stay semantically distinct in the query API.

### 2.6 New M10 schema (migration 0030)
Genuinely new, normalized: `staff_invitations`, `staff_permissions`,
`saved_views`, `internal_notes` (polymorphic subject), `ops_tasks`, `incidents`,
`incident_links`, `alerts`, `alert_subscriptions`, `system_check_results`,
`integrity_check_results`, `feature_flags`, `kill_switches`,
`admin_approval_requests`, `impersonation_sessions`, `export_jobs`. Plus small
column additions to `users` (mfa readiness, invited_by). One migration, applied to
dev + test DBs. Every table is org-scoped where meaningful and carries created/
updated timestamps.

### 2.7 System Doctor / Integrity — truth principle (§107)
- **System Doctor** = "is infrastructure/software operating?" It runs **safe**
  probes (DB, migration parity, providers' configured/health, market freshness
  session-aware, reconciliation age) → `HEALTHY|WARNING|CRITICAL|SUSPICIOUS`,
  persisting `system_check_results`. **Rithmic and all providers are reported
  truthfully**: architecture-installed ≠ authenticated ≠ verified. Market-closed
  is never a false "stale feed critical."
- **Data Integrity Center** = "does our business data still make sense?"
  deterministic invariant checks (≤5 active accounts/identity, no PAID payout
  without evidence, ≤5 payout cycles, no double execution/debit, no cert without
  qualifying event, no paid-unprovisioned beyond threshold, hash-chain intact, …)
  → `integrity_check_results`. **Detect first; never silently repair serious
  failures.**

### 2.8 Alerts / incidents (honest channels)
- `alerts` with severity `INFO|NOTICE|WARNING|CRITICAL|EMERGENCY`, a
  **dedup key** and **incident grouping** + cooldowns so one provider outage →
  one incident, not 400 notifications. `incidents` lifecycle
  `OPEN|ACKNOWLEDGED|INVESTIGATING|IDENTIFIED|MONITORING|RESOLVED`. Channels
  `IN_APP|EMAIL|SMS|PUSH` via a `NotificationProvider` abstraction; SMS/PUSH
  report **NOT_CONFIGURED** honestly and are never faked.

### 2.9 Config / flags / kill switches
- `feature_flags` (env-scoped, enabled, description, audited) and generic
  `kill_switches` generalizing the payout circuit-breaker pattern:
  `DISABLE_NEW_PURCHASES|DISABLE_PROVISIONING|DISABLE_NEW_ORDERS|
  DISABLE_NEW_PAYOUT_REQUESTS|DISABLE_PAYOUT_SUBMISSION|
  DISABLE_EXTERNAL_EXECUTION|MAINTENANCE_MODE`. **`DISABLE_NEW_ORDERS` preserves
  risk-reducing actions** (cancel/flatten/reduce). Activation requires permission
  + reason + confirmation (+ reauth for the highest-risk) and writes a CRITICAL
  audit event + owner alert. Config changes reuse `audit_log` before/after; a
  deterministic impact preview is shown where computable (never a fake exact
  count).

### 2.10 Environment awareness & data truth
- The console visibly shows environment (LOCAL/TEST/STAGING/PRODUCTION). External
  live remains disabled (`EXTERNAL_LIVE_ENABLED=false`); Rithmic is TEST. No fake
  production styling. No status is presented as verified reality unless actually
  known (§107).

---

## 3. Checkpoints (see 15-m10-final-report.md for as-built results)
A audit+architecture · B staff/RBAC/invite/reauth/impersonation · C
events/audit/correlation/search + object explorer/inspectors · D Customer
Directory + Customer 360 + tags · E account ops/reset/holds/adjustments/
provisioning · F config/flags/kill-switches/change mgmt · G System Doctor/
integrity/reconciliation/full-system-test · H alerts/incidents/notifications ·
I jobs/webhooks/provider+Rithmic/market-data/execution-quality · J financial
ops/money-trace/exports/saved-views/notes/tasks/agreements · K Command Center +
nav + dark/light + polish · L tests(≥200)/browser/security/docs/final report.

Each checkpoint: typecheck → focused tests → commit. Secret + model-id audit
before every push. External live stays disabled throughout.

## 4. Locked business rules preserved
Product economics (CORE/SELECT/DAILY prices, targets, drawdowns, contract limits),
payout caps/minimums/50%/90-10 split, DAILY progressive qualifying-balance rule,
≤5 active accounts per verified identity, ≤5 payout cycles, EOD trailing drawdown,
consistency-delays-not-fails, winning-day ≥ $150, refund-before-execution — all
remain server-authoritative and unchanged. M10 **operates** these; it does not
re-implement or weaken them, and it consumes their reason codes rather than
re-deriving verdicts.
