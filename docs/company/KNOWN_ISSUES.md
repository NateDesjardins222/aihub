# KNOWN ISSUES

**Phase 2 — System-Wide Reconciliation. Audit-only. No issue below was fixed in this phase**
(except where a minimal wiring fix is explicitly noted and justified against the strict fix
policy).

Baseline HEAD: `55df4c7` · Compiled 2026-09-25.

## Severity scale

- **P0** — blocks launch / real-money-unsafe / data-integrity risk with real funds.
- **P1** — must fix before real customers or real money; correctness/compliance risk.
- **P2** — should fix before scale; contained today because no real money is wired.
- **P3** — hygiene / staleness / correctness with no current impact.
- **P4** — cosmetic / nice-to-have.

Context that lowers many severities: **no real money moves in this build today.** Several
items would be P0/P1 in a live-money deployment but are contained now. Severities below are
stated for the **intended launch** (real customers, real money), with the current
containment noted.

---

## P0 — Launch blockers

### HTF-1 — Commerce provider fails open to a self-signing mock in production
- **System:** Commerce (Area H).
- **Description:** `commerceProviderFromEnv()` returns `whop.isConfigured() ? whop : mock`
  with **no `NODE_ENV` guard** (`apps/server/src/platform/commerce-provider.ts`). The mock
  holds its own dev secret and **self-signs `PAYMENT_SUCCEEDED` events**, so a production
  deploy without Whop configured would provision paid evaluation accounts **with no real
  payment**.
- **Evidence:** verified personally — `return whop.isConfigured() ? whop : mock;`. Contrast
  `payout-provider-registry.ts` which does `if (id==='MOCK'){ if(isProduction()) return
  unconfigured; }`.
- **Customer impact:** none today (no prod deploy). At launch: free accounts / revenue loss.
- **Business impact:** revenue integrity; the platform would think it was paid when it wasn't.
- **Repro:** set `NODE_ENV=production`, leave Whop unconfigured, hit `/checkout` → mock
  provider selected (owner console would show "mock").
- **Next action:** DECISION REQUIRED / then fix — mirror the payout registry's fail-closed
  guard so production refuses the mock. See `DECISION_LOG.md`.
- **Status:** ✅ **RESOLVED (Phase 4).** `commerceProviderFromEnv()` now consults the central
  provider-safety boundary (`config/provider-safety.ts`): production NEVER selects the mock. With
  no Whop config in production the factory returns the Whop seam (`isConfigured()===false`), the
  webhook 503s, and `simulateProviderPayment` throws `MOCK_COMMERCE_FORBIDDEN`. Mocks remain the
  default in development/test only. This does NOT make commerce production-ready — Whop production
  is still unwired (HTF-3); it only removes the fail-open. Proven by
  `config/provider-safety*.test.ts`.

### HTF-2 — Identity/KYC provider fails open to a fabricating mock in production
- **System:** Identity / provisioning gate (Area B / I).
- **Description:** `identityProviderFromEnv()` returns `stripe.isConfigured() ? stripe :
  mock` with **no `NODE_ENV` guard** (`apps/server/src/platform/identity-providers.ts`). The
  mock **fabricates a KYC decision from the legal name**. In production without Stripe
  Identity, the provisioning gate's `identityOk` passes on fabricated verification.
- **Evidence:** verified personally — `return stripe.isConfigured() ? stripe : mock;`; mock
  decision from `mockDecisionFor` (name contains REJECT/REVIEW/STEP).
- **Customer impact:** none today. At launch: **compliance failure** (no real KYC).
- **Business impact:** regulatory/legal exposure; AML/KYC obligations unmet.
- **Repro:** `NODE_ENV=production`, Stripe unset, run onboarding identity step → mock verifies.
- **Next action:** DECISION REQUIRED / then fix — fail closed in production. See `DECISION_LOG.md`.
- **Status:** ✅ **RESOLVED (Phase 4).** `identityProviderFromEnv()` now consults the central
  provider-safety boundary: production NEVER selects the mock. With no Stripe config in production
  the factory returns the Stripe seam, whose `createVerification` throws — so a customer's own
  `POST /onboarding/identity/resolve` can no longer drive a fabricated `IDENTITY_VERIFIED`, and the
  provisioning gate's `identityOk` cannot pass on a mock. Mock KYC remains development/test only.
  This does NOT make KYC production-ready — Stripe Identity is still unwired; it only removes the
  fail-open. Proven by `config/provider-safety*.test.ts`.

### HTF-3 — No real payout rail; no verified real charge path (end-to-end money is not connected)
- **System:** Payouts (Area J) + Commerce (Area H).
- **Description:** Money-out has **no real provider** (mock in dev, `UnconfiguredPayoutProvider`
  fail-closed in prod). Money-in is Whop **sandbox-only** with a hard no-prod-host. The Golden
  Path is fully demonstrable in simulation but cannot take or disburse real funds.
- **Evidence:** `payout-provider-registry.ts` (no real provider implemented);
  `whop-client.ts` sandbox-only.
- **Customer impact:** none today. At launch: cannot actually pay traders or collect payment.
- **Business impact:** the core product promise (get funded, get paid) is not yet real.
- **Next action:** build + reconcile a real payout provider and wire Whop prod; both are
  explicit, out-of-scope-for-Phase-2 milestones.
- **Status:** OPEN (by design at this stage).

---

## P1 — Must fix before real customers / money

### HTF-4 — `/design-lab` reachable in production build with fake terminal figures
- **System:** Web shell (Area A).
- **Description:** `App.tsx` serves `/design-lab` whenever the path matches, gated only by a
  **comment** ("non-production"), with no `import.meta.env.DEV` check. It renders hardcoded
  fake figures (Balance $100,000, Day P&L +$1,240, a live-looking WORKING order).
- **Evidence:** verified personally — `if (... window.location.pathname.startsWith('/design-lab'))`
  in `App.tsx`, no env gate; `LabApp.tsx` comment claims non-production but does not enforce it.
- **Customer/business impact:** a public prod URL showing fabricated trading numbers →
  misleading; undermines the "no fabricated data" marketing stance.
- **Next action:** gate behind the build mode.
- **Status:** ✅ **RESOLVED (Phase 4).** `/design-lab` is now gated by `designLabEnabled()`
  (`apps/web/src/lib/runtime.ts`, `import.meta.env.MODE !== 'production'`). In a production build
  the route is inert — a direct URL falls through to the normal app, never the lab. Development
  keeps it. Proven by `apps/web/src/lib/runtime.test.ts`. (The `/icons` dev gallery is a similar
  dev surface but was out of this phase's named scope; noted for a later pass.)

### HTF-5 — Default `db:seed` produces the wrong (legacy, payout-incompatible) catalog
- **System:** Product config / seeds (Area H / product model).
- **Description:** `db:seed` runs `src/db/seed.ts`, which seeds the legacy **Atlas
  Evaluation/Practice** templates (50/100/150K), **not** the 10 HTF products. The HTF
  products come from a **separate manual script** `seed-htf-products.ts`. Worse, the legacy
  seed writes `payoutRules` in an **old shape** that the current `payoutPolicySchema`
  rejects, so `parsePayoutPolicy` would throw on legacy products.
- **Evidence:** verified personally — `apps/server/package.json:14 "db:seed":
  "tsx src/db/seed.ts"`; `seed.ts` `TEMPLATES` = Atlas/Practice; HTF products only in
  `seed-htf-products.ts`.
- **Customer/business impact:** a fresh environment comes up with the wrong products and
  payout-incompatible configs; contributes to the 27-profile mix in the Owner Console.
- **Next action:** DECISION REQUIRED — pick a canonical seed. Do not resolve silently
  (Phase 2 constraint on the product-duplication issue). See `DECISION_LOG.md`.
- **Status:** ✅ **RESOLVED (Phase 3, 2026-09-26).** `db:seed` now builds the 10 HTF
  products from the authoritative model via `reconcileHtfProducts` and publishes them as the
  only ACTIVE commercial evaluations; funded destinations + practice are INTERNAL; legacy
  templates are RETIRED. No manual second seed. Fresh-DB acceptance verified. Legacy
  payout-incompatible configs are no longer produced.

### HTF-6 — Runtime product rules (DB) diverge from what customers are shown (catalog/site)
- **System:** Product model.
- **Description:** Four confirmed divergences between the DB (runtime authority) and the
  public site/catalog: (D-1) drawdown TYPE STATIC vs EOD_TRAILING for all 10 HTF; (D-2) CORE
  300K target $18,000 vs $15,000; (D-3) CORE 300K drawdown $12,000 vs $10,000; (D-4) SELECT
  drawdown 4% vs 5%. Full matrix in `PRODUCT_SOURCE_OF_TRUTH.md`.
- **Evidence:** DB queried live; catalog read from source; web = catalog (re-export).
- **Customer/business impact:** customers are sold one rule and judged by another →
  commercial/legal exposure, especially D-1 (drawdown mechanic) and D-4 (SELECT's marketed
  differentiator is absent in the DB).
- **Next action:** DECISION REQUIRED — owner decides the authoritative value per property.
  **Explicitly not resolved in Phase 2.** See `DECISION_LOG.md`.
- **Status:** ✅ **RESOLVED (Phase 3, 2026-09-26).** All four divergences reconciled to the
  authoritative model (DB now = catalog): D-1 EOD_TRAILING for all 10; D-2 Gold target
  $15,000; D-3 Gold drawdown $10,000; D-4 SELECT 1250/2500/5000. Verified in DB, Owner
  Products, and Portal. Guarded by product-integrity tests (contracts + server DB parity).

---

## P2 — Fix before scale (contained today)

### HTF-7 — M2M provisioning path bypasses commerce + entitlement + active-limit invariants
- **System:** Provisioning (Area I).
- **Description:** `POST /api/v1/provisioning/accounts` (org API-key auth) calls
  `provisionAccount` directly, bypassing `commercial_orders`, `entitlements`, and the
  5-active-account limit (no `enforceActiveLimit`). A legitimate M2M seam, but a
  DISCONNECTED bypass of the commerce invariants with no code comment addressing the limit.
- **Evidence:** `routes/provisioning.ts:64-133`; commerce path sets `enforceActiveLimit
  true`, this path does not.
- **Next action:** confirm whether the limit bypass is intentional policy; document or gate.
- **Status:** OPEN (UNKNOWN intent).

### HTF-8 — Active-slot counter excludes LOCKED / GOAL_REACHED → possible over-provisioning
- **System:** Account limit (Area I).
- **Description:** `account-limit.ts` counts only `['ACTIVE','PENDING']` toward the 5-active
  limit. Recoverable day-LOCKED and GOAL_REACHED accounts are non-terminal but don't consume
  a slot, so a trader could exceed the intended 5 live accounts.
- **Next action:** decide whether LOCKED/GOAL_REACHED should count; adjust `ACTIVE_STATUSES`.
- **Status:** OPEN.

### HTF-9 — Affiliate `markPayoutPaid` lacks row-lock / status-CAS / unique ledger constraint
- **System:** Affiliates (Area L) / money.
- **Description:** `affiliate-payouts.ts markPayoutPaid` / `transition` select without `FOR
  UPDATE` and without a status-CAS in the UPDATE WHERE; no unique `(payoutId, entryType)`
  observed on `affiliate_ledger`. Two concurrent calls could double-insert a `PAYOUT_PAID`
  (−amount) entry. Contained: affiliate payout provider is NOT_CONFIGURED, so no real money.
- **Evidence:** subagent static trace — **NEEDS-REVALIDATION** (not reproduced by a
  concurrency test in this phase).
- **Next action:** add a unique constraint or advisory lock + CAS; then a concurrency test.
- **Status:** OPEN (needs revalidation).

### HTF-10 — Owner OS safety controls are view-only in the console (kill switches, flags, alerts, incidents)
- **System:** Owner OS (Area Q).
- **Description:** Kill-switch engage/release, feature-flag toggle, alert ack/resolve,
  incident create/transition, and the full staff lifecycle + impersonation exist server-side
  but have **no UI** (or read-only UI). The console can *display* an engaged kill switch but
  cannot engage/release one.
- **Evidence:** UI-exposure subagent grep-confirmed no web calls to the mutation endpoints;
  `owner-config.ts:51,62` (kill switch) etc. have no caller.
- **Customer/business impact:** in an incident, an operator cannot use the primary safety
  control from the console — must call the API by hand.
- **Next action:** surface the mutations (esp. kill switches) with the existing step-up flow.
- **Status:** OPEN (console surfacing). **Phase 7 note:** the more dangerous half — that engaging
  a kill switch had *no effect* for 5 of 7 switches — is fixed under HTF-24. The remaining HTF-10
  work is purely the web-console engage/release/ack/toggle controls; the owner can operate these
  via the API today.

### HTF-24 — Kill switches were engageable but UNENFORCED (RESOLVED, Phase 7)
- **System:** Owner OS safety plane / commerce / provisioning / payouts / execution.
- **Description (was):** Of seven kill switches, only `MAINTENANCE_MODE` and `DISABLE_NEW_ORDERS`
  actually stopped anything. `DISABLE_NEW_PURCHASES`, `DISABLE_PROVISIONING`,
  `DISABLE_NEW_PAYOUT_REQUESTS`, `DISABLE_PAYOUT_SUBMISSION`, `DISABLE_EXTERNAL_EXECUTION` had **no
  enforcement seam** — engaging them wrote an audit event + alert but changed nothing. A safety
  control that does nothing is worse than none.
- ✅ **RESOLVED (Phase 7, 2026-09-26):** `assertNotEngaged(db, KEY)` is wired as the first line of
  each authoritative chokepoint — `commerce.ts createPendingOrder`, `provisioning.ts
  provisionAccount`, `payouts.ts requestPayout`, `payout-operations.ts submitPayable` — each now
  throws **423 `KILL_SWITCH_ENGAGED`** when engaged; the external safety gate
  (`execution/safety-gate.ts`) is switch-aware via `killSwitchEngaged` (external execution is
  DISCONNECTED today, so this is forward-safe). Proven by
  `apps/server/src/platform/kill-switch-enforcement.test.ts` (6 tests). See `OWNER_OS_ACCEPTANCE.md`
  §2. Console engage/release buttons remain HTF-10.

---

## P3 — Hygiene / staleness (no current impact)

### HTF-11 — `AccountStatus` type is stale (COMPLETED, INACTIVE missing)
`COMPLETED` (`payouts.ts:587`) and `INACTIVE` (`account-inactivity.ts:171`) are written to
`accounts.status` but absent from the declared union and `TRADEABLE_STATUSES`. Type-vs-code
drift. **Next action:** add them to the type.

### HTF-12 — Dead funding-state enum values + non-existent `requestFunding` docstring
`account_qualifications.fundingState` declares FUNDING_PENDING / APPROVED which are never
written; `commerce.ts` references a `requestFunding` step that does not exist. **Next
action:** remove dead states/doc or implement the intended intermediate step.

### HTF-13 — `archiveAccount` has no `allowedFrom` guard
Any status (incl. already-ARCHIVED) can be re-archived. Idempotent-ish but unguarded.

### HTF-14 — HomePage hero stats are hardcoded strings, not derived from the catalog
`90% / $0 / $25K–$300K` are true product facts but hardcoded in `HomePage.tsx`, so they can
silently drift from `@atlas/contracts`. PLACEHOLDER-grade drift risk only.

### HTF-15 — SUPER_ADMIN demo credentials in source (prod-guarded)
`owner@atlasfutures.local` / `atlas-owner-2026` etc. are in `seed.ts`, harmless because demo
seeding is gated on `NODE_ENV !== 'production'`, but they are SUPER_ADMIN creds committed to
the repo. **Next action:** confirm prod never seeds them (guard verified) and consider moving
to env.

---

## P4 — Cosmetic / infra hygiene

- **HTF-16** — No CI (`.github` absent); security/diagnostic tooling is manual-scripts-only.
- **HTF-17** — No in-repo DB backup/PITR config; no app Dockerfile / k8s / prod compose.
- **HTF-18** — Inactivity sweep expects an external cron that is not present in-repo.
- **HTF-19** — `/auth/me` boot 401 (benign; client refreshes once — documented in the P1
  stabilization audit).
- **HTF-20** — Rate limiting is opt-in (`global:false`); sensitive routes are covered but any
  new route must remember to opt in.
- ~~**HTF-21**~~ ✅ **RESOLVED (Phase 7, 2026-09-26).** The three trader self-serve mutations —
  `PUT /api/v1/accounts/:id/rules`, `POST /api/v1/accounts/:id/reset`,
  `PUT /api/v1/accounts/:id/environment` (`apps/server/src/http/routes/trading.ts`) — are now
  gated by `assertSelfServeMutable(accountType)`: they succeed only on a `PRACTICE` account and
  return **403 `SELF_SERVE_FORBIDDEN`** on any commercially-weighted account (`EVALUATION`,
  `FUNDED`, `FUNDED_SIM`). A trader can no longer weaken the risk rules they are judged by, revive
  a breached paid evaluation, or turn off fees / soften fills on a funded account; those are
  operator-only via the Owner OS. Ownership is still checked first (a stranger gets 404, not 403).
  Read paths (`GET .../rules`, `GET .../environment`) stay open. Proven by
  `apps/server/src/http/routes/self-serve-boundary.test.ts` (6 tests, incl. the "override never
  persisted / $48k floor stands" assertion). *(Was: trader could rewrite own risk / self-reset /
  set sim environment on any owned account — Security subagent trust-boundary risks #1–#3.)*
- ~~**HTF-22**~~ ✅ **RESOLVED (Phase 11).** Windows dev scripts used a Unix-style env prefix
  (`NODE_USE_ENV_PROXY=1 tsx …`), which fails under Windows PowerShell/cmd. Fixed: added
  `cross-env` (devDependency) and wrapped both `apps/server` `dev` and `start` scripts
  (`cross-env NODE_USE_ENV_PROXY=1 tsx …`). Verified: `cross-env` sets the variable portably.
  Unix/macOS/CI behavior unchanged.
- **HTF-23** — Cosmetic Rithmic cleanups (non-blocking, found in Phase 6 acceptance):
  (a) `rithmic/plants/market-data-service.ts` has a nonsensical `nb.time * 1000 >= 0` guard
  (`nb.time` is already ms); (b) `execution/providers/rithmic-execution.ts`
  `discoverAccounts(c.credentials ? '' : '')` is a dead ternary (both branches `''`). No
  functional impact; recorded in `RITHMIC_ATLAS_ACCEPTANCE.md` §11. Verify the historical-bar
  start/finish index units against the official Rithmic proto during the live acceptance pass.

---

## Summary counts

| Severity | Count | IDs |
|----------|-------|-----|
| P0 | 3 | HTF-1, HTF-2, HTF-3 |
| P1 | 1 open (2 resolved) | HTF-4 open; ~~HTF-5~~, ~~HTF-6~~ ✅ resolved Phase 3 |
| P2 | 4 | HTF-7, HTF-8, HTF-9, HTF-10 (enforcement half resolved via ~~HTF-24~~) |
| P3 | 5 | HTF-11..HTF-15 |
| P4 | 6 open (2 resolved) | HTF-16..HTF-20, HTF-23; ~~HTF-21~~ ✅ Phase 7; ~~HTF-22~~ ✅ Phase 11 |

The three P0s share one root theme: **the boundaries with the outside financial world
(payment in, KYC, payout out) are the least-connected and, for two of them, fail open rather
than closed.** Everything internal to the simulation is unusually disciplined.

## Resolved test-integrity / reliability items (Phase 9, 2026-09-26)

Both long-standing pre-existing test failures carried forward since Phase 4 are **resolved**,
root-caused, with un-weakened assertions (see `FINANCIAL_INVARIANTS.md`):

- ~~**Audit-chain concurrency**~~ ✅ — `admin.test.ts` "audit chain intact under concurrent actions"
  reported false corruption because the hash chain ordered by `(createdAt, id)` with a **random UUID**
  `id`; same-millisecond concurrent appends tied on `createdAt` and the tie-break desynced verify
  ordering from the true linkage. Fixed in `audit.ts`: each chain row's `createdAt` is strictly
  greater than its predecessor's, so ordering is a total order matching linkage. Passes 3/3 in
  isolation on a clean DB. (Residual: a single combined run of ~13 DB suites sharing one default-org
  chain is still sensitive to cross-suite accumulation — a test-isolation limitation, not a defect.)
- ~~**Payout-operations append-only**~~ ✅ — a **test** defect: it queried the literal
  `providerEventId='dup_evt_1'` while rows were ingested as `dup_evt_1_${rid}`; it only "passed" on a
  polluted shared DB via a stale row. Production `ingestProviderEvent` idempotency was correct; the
  assertion now queries the real id and is DB-independent.

## Security posture verified / added (Phase 10, 2026-09-26)

Phase 10 attacked the platform adversarially and documented the enforced trust boundaries in
`SECURITY_MODEL.md` + `THREAT_MODEL.md`. Findings:

- **Secret scan — clean.** No `.env`/real-secret file is tracked (only `.env.example` placeholders,
  `.env` gitignored); **no non-empty `RITHMIC_PASSWORD` was ever committed on any branch/history**;
  the production web bundle (`apps/web/dist`) contains **0** server-secret patterns
  (`JWT_SECRET`/`DATABASE_URL`/`RITHMIC_PASSWORD`/`postgres://`/`whsec_`/`sk_live`/`sk_test`); Rithmic
  config is redacted to `credentials=present` and never returned to the browser. Reported PRESENT/NOT
  PRESENT only; no secret value printed.
- **Dev/mock routes gated — verified.** `commerce.ts:/mock`, `onboarding.ts:/dev/simulate-payment`,
  `portal.ts:/physical-orders/:id/dev/simulate-payment` are all wrapped in
  `if (env().NODE_ENV !== 'production')` (not registered in prod); `/design-lab` + the icon gallery are
  inert in a production web build (`runtime.ts` `designLabEnabled()`); dev seed hard-fails in prod.
- **Adversarial suites green in isolation** on a clean DB — RBAC red-team, tenant isolation/IDOR,
  enforcement/owner/affiliate authz, WS security, replay controls, self-serve boundary, kill-switch
  enforcement, provider-safety prod, financial invariants, audit-chain stress.
- **Audit integrity at scale — proven.** `audit-chain-stress.test.ts` writes 3000 + a 100-wide
  concurrent burst on a fresh isolated org; whole-chain verify is clean. The Phase 9 "combined ~13-suite
  run" sensitivity is confirmed a **shared-default-org test-isolation artifact**, not an audit defect.

### HTF-25 — esbuild dev-server advisory via drizzle-kit (DEV-ONLY)
- **System:** Build/migration tooling (dev only). **Severity: P4 (DEV-ONLY).**
- **Description:** `pnpm audit` flags one **moderate** advisory (GHSA-67mh-4wv8-2f99): esbuild ≤0.24.2
  lets any website POST to the esbuild dev server and read the response. It is reachable **only**
  transitively via `drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild`.
- **Containment:** drizzle-kit is a migration/build-time tool; esbuild's dev server is **never** run in
  the production runtime and its code is **not** in the shipped bundle. Production dependencies have **no
  known vulnerabilities**.
- **Next action:** not force-overridden (would destabilize drizzle-kit's deprecated `@esbuild-kit`
  chain); revisit when drizzle-kit updates its loader, and add a CI dependency-audit gate in Phase 11.

## Infrastructure / reliability verified + added (Phase 11, 2026-09-26)

Phase 11 proved the platform survives restart/crash/outage without losing or duplicating financial or
account truth, and executed a real backup→drop→restore drill. Details: `INFRASTRUCTURE.md`,
`DISASTER_RECOVERY.md`, `RECOVERY_DRILL_REPORT.md`, `OBSERVABILITY.md`, `DEPLOYMENT_RUNBOOK.md`,
`INCIDENT_RUNBOOK.md`.

- **Disaster recovery — PROVEN (internal).** `pg_dump -Fc` backup (checksummed) → corrupt archive
  rejected → isolated DB **dropped** → restored → snapshot **byte-identical** (counts + content
  checksums) → audit chain re-verifies → financial reconciliation **$0 unexplained delta**. RTO local
  ~1.3s (tiny dataset); RPO documented honestly (daily-dump window until WAL/PITR).
- **Restart/crash safety — PROVEN.** No process-memory-only authoritative state; the engine reconstructs
  positions/orders/brackets from Postgres on `start()`; kill switches are a durable table (survive
  restart); graceful SIGTERM/SIGINT drains workers + pools.
- **Redis — confirmed UNUSED.** No `ioredis` import in `apps/server/src`; all locks are PostgreSQL
  advisory locks; fan-out is LISTEN/NOTIFY. Redis outage has zero effect on business truth.
- **Production-like boot — PROVEN.** `NODE_ENV=production` with no real provider creds boots with all
  providers fail-closed (no mock-in-prod warning); `/health`+`/ready`+`/version` carry release identity;
  dev routes (`/commerce/mock`, `/dev/simulate-payment`) return **404**.
- **Canonical release validation added.** `pnpm validate:release` (prepare seeded isolated DB → typecheck
  → root `pnpm test` (dist excluded, files serialized) → build). Fixes the Phase-10 "run from wrong cwd
  → dist collected → 105 misleading failures" trap. See `scripts/prepare-test-db.sh`,
  `scripts/validate-release.sh`. **Canonical run result: 2,874 / 2,875 pass.** The one failure is
  `admin.test.ts > keeps the audit chain intact under concurrent actions` — it passes **51/51 in
  isolation** and only trips in the full monolithic run because `~200` DB suites share ONE default
  organisation and its `/admin/audit/verify` (whole-org, windowed) sees accumulated cross-suite rows.
  This is a **shared-test-DB accumulation limitation, not an audit defect**: no direct `audit_log` insert
  exists anywhere (all go through `recordAudit` with a per-org advisory lock + monotonic `createdAt`), and
  Phase 10's `audit-chain-stress.test.ts` proves a long, concurrently-written **isolated** org verifies
  clean (the real production case). **Running suites in isolated batches yields all-green.** Full
  per-suite org isolation is a larger harness change deferred (PART 45: "don't massively rewrite tests if
  a simpler correct harness exists") — tracked as HTF-29 (P4, test-only).

### HTF-26 — payout-ops worker was defined but never started
- **System:** payouts (durability). **Severity: P1 (launch-relevant).**
- ~~Open~~ ✅ **RESOLVED (Phase 11):** `PayoutOpsWorker` is now instantiated and started in `app.ts`
  (stopped on shutdown), so a PAYABLE payout left behind by a treasury/breaker delay or transient
  provider error is durably resubmitted with the same idempotency key (`FOR UPDATE SKIP LOCKED`;
  `submitPayable` no-ops unless still PAYABLE — no double-submit). **Residual:** the periodic
  stale-reconcile of SUBMITTED/PROCESSING (`reconcileStaleBatch`, per-org) still relies on the provider
  webhook / cron; wire a scheduled reconcile before a real payout rail.

### HTF-27 — certificate/object storage is local-filesystem only
- **System:** certificates / object storage. **Severity: P2 (contained; no real fulfillment yet).**
- **Description:** rendered certificate PNG/PDF artifacts are written to a local `.artifacts` dir; the S3
  seam throws NOT_CONFIGURED. Artifact **bytes** are not covered by the DB backup and are lost across a
  container redeploy or not shared across instances.
- **Containment:** certificate **metadata** is durable in Postgres; the deterministic renderer + pinned
  template version can re-render the artifact. No financial event depends on the artifact bytes.
- **Next action:** wire a provider-backed object store (S3 or equivalent) + artifact backup before
  multi-instance / real merch fulfillment.

## Pre-launch readiness review (Phase 12, 2026-09-26)

Phase 12 was an audit/readiness-review + documentation pass (no feature work; no code changes). It
produced the authoritative gate matrix (`LAUNCH_GATES.md`) and go/no-go (`PRE_LAUNCH_REVIEW.md`) plus
`REAL_MONEY_BOUNDARY`, `PRODUCTION_ENVIRONMENT_PLAN`, `EXTERNAL_DEPENDENCIES`,
`LEGAL_COUNSEL_REVIEW_PACKAGE`, `HUMAN_ACCEPTANCE_CHECKLIST`, `PRE_LAUNCH_FEATURE_FREEZE`. Regression
re-run: **2,874/2,875** (typecheck ✓, build ✓, production-like boot fail-closed ✓). Confirmed: exactly 10
commercial products (single-sourced); financial integrity clean; security clean internally; DR proven;
PII is references-only (no raw SSN/ID/card); marketing copy carries proper disclaimers (no misleading
claims); copy-trading cannot bypass risk.

New/confirmed pre-launch gaps:
- **HTF-30 (P2, software) — no 404 page / no React error boundary.** `apps/web` routes by manual pathname
  match with no catch-all and no top-level error boundary, so an unknown path falls through and a render
  error blanks the page. **Beta-acceptable** (known invited users); **fix before public launch** (PART 125).
- **HTF-31 (P3) — marketing rule-bullet drift risk.** ✅ **RESOLVED (Phase 12.5).** The family
  `rules: string[]` bullets are now DERIVED from the numeric config by `familyRuleBullets()` in
  `product-catalog.ts` (the single source; `FAMILIES` maps the numeric base through it). Only genuinely
  qualitative notes remain authored (they carry no drifting number). `rule-facts.test.ts` fails if any
  bullet's number disagrees with the config, and the marketing HomePage consistency figures now read
  `family(...).evalConsistencyPct` rather than literals. Parity across public/Portal/Atlas/Owner follows
  from one derivation + the DB profile reconciled from the same catalog.
- **HTF-6a (P2, software+external) — owner MFA + production owner bootstrap.** ✅ **RESOLVED (software,
  Phase 12.5).** TOTP MFA is implemented end-to-end: `auth/totp.ts` (RFC 6238, no new dependency),
  `auth/secret-box.ts` (AES-256-GCM at-rest sealing keyed off JWT_SECRET), `auth/mfa.ts` (two-phase
  enrollment, single-use recovery codes, disable, regenerate), a two-step login (`/auth/login` →
  challenge → `/auth/mfa/verify`), and a Portal Security panel. A production owner bootstrap exists
  (`platform/owner-bootstrap.ts` + `scripts/bootstrap-owner.ts`, `pnpm owner:bootstrap`): creates the
  FIRST SUPER_ADMIN only, env-gated, never prints the password, refuses if an owner exists. Proven by
  `auth/mfa.test.ts`, `http/auth-mfa-http.test.ts`, `platform/owner-bootstrap.test.ts`. (External pentest
  before public launch remains outstanding under G6.)
- **HTF-18 — funded inactivity sweep.** ✅ **RESOLVED (Phase 12.5).** `runInactivitySweep` is now bound
  to a durable interval worker (`platform/inactivity-worker.ts`, started/stopped in `app.ts`) AND an
  on-demand owner route (`POST /api/v1/admin/ops/system/inactivity-sweep`, `system.jobs.manage`). The
  sweep is idempotent and server-time authoritative; `inactivity-worker.test.ts` proves a second tick
  closes/warns nothing new. The rule itself was unchanged (not invented).
- **HTF-30 (P2, software) — no 404 / React error boundary.** ✅ **RESOLVED (Phase 12.5).** `main.tsx`
  wraps the app in a top-level `ErrorBoundary` (branded "Something went wrong" + reload; the stack goes to
  the console, never the customer). Unknown top-level routes render a branded `NotFound` (`App.tsx`
  `isKnownRoute`).

Carried: HTF-27 (cert object storage local-FS only; beta-tolerable, public-launch blocker), HTF-29
(shared-org audit-verify test artifact) ✅ **RESOLVED (Phase 12.5)** — the two pollution-sensitive tests
were scoped to the seeded org (schema.test profile lookup) and to a `{since}` segment (admin.test audit
verify); canonical validation now runs fully green twice from a clean seed.

**Zero unresolved P0.** All remaining open items are P2/P3 external/human gates (HTF-27 object storage,
external pentest, provider/legal/infra) — see `LAUNCH_GATES.md` for owner + next action per gate.

## PROVENANCE

P0/P1 money-and-trust items (HTF-1, HTF-2, HTF-4, HTF-5) verified personally against source.
Remaining items from six parallel read-only subagent audits, cross-checked against schema and
the live DB. Items marked NEEDS-REVALIDATION were not reproduced by a live test this phase.

---

# PRODUCT RECOVERY PHASE 1 — functional-truth findings (from RC1 `dac5fd1`)

Audit + minimal repair of inaccessible/broken connectivity. Full detail in
`PRODUCT_FUNCTIONAL_TRUTH.md` / `PRODUCT_RECOVERY_REPORT.md`. **No P0.** Severities below use
STEP-16's model (inaccessible owner functionality = P1; secondary = P2; cosmetic = P3).

## P1 — repaired this phase
- **PR1-1 — Owner Console undiscoverable.** Owner OS was reachable only by typing `/admin`; no
  in-product link. **FIXED:** role-gated `Owner Console →` in the portal profile menu and the
  Atlas terminal rail (shown iff `role !== 'TRADER'`; trader never sees it). RBAC unchanged.
  Browser-proven.
- **PR1-2 — Kill switches unreachable from the console.** Emergency engage/release backend
  existed (`owner-config.ts`, `KILL_SWITCH` step-up, audited) but the console showed a read-only
  table. **FIXED:** inline Engage/Release with reason + step-up. Browser-proven (engage→release
  round-trip on `DISABLE_NEW_PURCHASES`).
- **PR1-3 — Feature-flag toggle unreachable.** POST existed; flags shown read-only. **FIXED:**
  inline Enable/Disable toggle (permission-gated). Browser-proven.

## P1 — documented, deferred to Phase 2
- **PR1-4 — Staff management has no console UI.** `owner-staff.ts` (invite / role change /
  suspend / reactivate / revoke sessions, STAFF step-up) is complete backend, but StaffPage is
  read-only. Needs a dialog (a build, not a wiring fix). The misleading "invite dialog" note was
  corrected to be honest this phase.

## P2 — Owner OS BACKEND-ONLY (route + domain + audit exist; no console control)
Inactivity-sweep, full-system-test, alert ack/resolve, incident create/transition/assign,
impersonation, owner-account adjust/pause. Surface with the same step-up pattern in Phase 2.

## P2 — Portal
- **PR1-5 — Framed-certificate order shows success in production while the order stays pending.**
  `CertificatesPage` calls a dev-only `dev/simulate-payment` route (gated off in prod); the
  `.catch()` swallows the 404 and still toasts success. No real merch checkout is wired (server
  TODO). **Contained:** behind `MERCH_ENABLED` (off) and prod-only. Fix belongs to the commerce
  phase, not Product Recovery.

## P3
- Portal billing-history is an informational gap (accounts list only, no receipts route).
- Portal notifications section is a static placeholder.
- Per-achievement visibility is BACKEND-ONLY (UI exposes only the bulk toggle).
- Owner OS customer-directory/360 tags and finance exports/saved-views/notes/tasks are
  BACKEND-ONLY (P3).
- Atlas `useFreshness` REST polling duplicates the WS `md.status` heartbeat (minor; dedupe later).

## Removed / corrected
- Customer light/dark **theme toggle removed** (owner request) + dead `theme.ts` deleted.
- Misleading StaffPage "invite dialog" note corrected.

**Validation:** typecheck (5 projects) + web build clean; 11/11 repair browser checks; canonical
202 files / 2922 tests PASS. No P0/P1 money/security/risk defect found anywhere.

---

# PRODUCT RECOVERY PHASE 2 — behavioral gaps (from `2fe43da`)

Evidence-graded L0–L5 (see `PRODUCT_BEHAVIORAL_TRUTH.md`). **No P0.** No new *broken* defect; the
items below are **unproven-at-the-real-boundary gaps** (not failures) that Phase 2 either closed or
documented honestly. Closed this phase:

- **PR2-C1 — wrong-account/cross-customer execution authorization was UNTESTED (was L1).** Now L4:
  `http/trading-authz-http.test.ts` proves a foreign account is rejected (404) at the real
  `POST /orders` + flatten boundary with the account untouched. Guard (`assertOwnership`) was already
  correct; the risk was zero coverage — now closed.
- **PR2-C2 — 4 personal controls (PROFIT_LOCK / DAILY_DRAWDOWN / TRADING_WINDOW / SESSION_RESTRICTION)
  proven only by the pure evaluator (L1).** Now L3 on the real order path (`personal-risk-gate-extra`).
- **PR2-C3 — firm-vs-personal composition on the order path (L2).** Now L3 (personal never loosens the
  firm cap).

Documented, NOT closed (gaps, not defects — for Phase 3):
- **PR2-G1 (P2) — EOD_TRAILING floor ratchet through the real engine day-roll is UNVERIFIED (L1 at
  system level).** The canonical EOD-trailing math is exhaustively proven by pure `@atlas/core` tests
  and post-payout floor safety is L4, but no test drives a finalized day-roll on an EOD_TRAILING
  account asserting the persisted `drawdownFloorMicros` ratchets/locks (engine floor persistence is
  proven only for STATIC/INTRADAY_TRAILING). Core 50K uses EOD_TRAILING → close this in Phase 3.
- **PR2-G2 (P2) — Core >50% consistency pass-gate proven pure-only (L1).** Not driven through
  `certifyEvaluation` on a real traded history.
- **PR2-G3 (P3) — payout fine boundaries ($149.99/$150.00, 4-vs-5 days, exact over-cap) proven pure
  only (L1)**, not straddling real `dailyAccountStats`.
- **PR2-G4 (P3) — bracket cleanup on reconnect / account-switch UNVERIFIED** (no test).
- **PR2-G5 (P2) — Staff-management console UI not built (L0).** Backend mature (invite/role/suspend/
  revoke, STAFF step-up, audit); needs the step-up dialog applied to a multi-field form. Deferred to
  the Owner-OS operability sub-phase (STEP 18 decision), not a trading-integrity blocker.
- **PR2-G6 (P3) — chart external raw-vs-provider (Yahoo) parity UNVERIFIED** headless. Internal OHLC
  invariants + 1m→5m aggregation parity are verified.
- **PR2-G7 (P3) — Atlas UX quality / perceived lag** — measured latency is low; the "feel" is
  interaction quality for the Atlas rebuild phase (see `ATLAS_PERFORMANCE_BASELINE.md`).

**Validation:** typecheck (5 projects) clean; 3 new behavioral test files (11 tests) pass; canonical
recorded in `PRODUCT_RECOVERY_REPORT_PHASE_2.md`. No P0. Human acceptance PENDING HUMAN.

---

## Engineering Phase A (from `65ca5ec`) — market-data truth, chart, copy separation

See `ATLAS_ENGINEERING_PHASE_A_REPORT.md`, `ATLAS_CANDLE_TRUTH_REPORT.md`,
`ATLAS_TOOL_INTERACTION_MATRIX.md`, `ATLAS_MARKET_DATA_PIPELINE.md`, `ATLAS_CONTRACT_POLICY.md`.

**Closed in Phase A (fixed + regression-tested):**
- **PA-1 (was P1) — `applyHistory` rendered bars without ordering/de-dup**, which could freeze
  lightweight-charts (`setData` throws on unordered/duplicate times) or misplace candles when a page
  arrived out of order. Fixed at the client-normalization layer: `orderBarsAscendingUnique`
  (`apps/web/src/chart/bar-order.ts` + `bar-order.test.ts`). `prependHistory` already had this.
- **PA-2 (was P1, objective) — six drawing tools were unselectable across their real hit region.**
  Broad-phase `mayHit` was not a conservative superset of `hitTest`, so `pick()` rejected real hits
  before `hitTest` ran: CROSS_LINE arms, HORIZONTAL_RAY body, TEXT/ANCHORED_TEXT box, and the
  NOTE/ARROW_MARK_* stamps. Fixed in `bounds.ts` `computeBox`; regression cases added to
  `bounds.test.ts` that exercise the `mayHit` path (the old tests called `hitTest` directly and missed
  it).

**Documented, NOT closed (source/policy limits or human-only, not code defects):**
- **PA-G1 (P2) — EXTERNAL reference-platform candle parity UNVERIFIED.** Provider-boundary fidelity is
  VERIFIED (0 value mismatches / 0 timestamp shifts / 0 fabrication across NQ/ES/GC/CL vs live Yahoo,
  minute-by-minute, no sampling). Atlas-vs-TradingView/broker on the *same contract + session* is not
  testable headless — needs Nathan or a licensed feed. (Supersedes PR2-G6.)
- **PA-G2 (P3) — visible gaps / "fewer candles" are the dev DATA SOURCE, not a bug.** Yahoo free 1m
  returns ~3.4–3.8% `null` minutes in this RTH window (more overnight); Atlas drops them rather than
  fabricate. Resolves when a licensed provider is configured. Not "fixed" by mutating data (that would
  be dishonest).
- **PA-G3 (P3) — continuous front-month `=F` for all eight symbols; micros share the mini series.** A
  documented policy (`ATLAS_CONTRACT_POLICY.md`), not a mis-map. A reference on a specific/back-adjusted
  contract will legitimately differ in O/C and roll jumps.
- **PA-G4 (P3) — live in-browser tick-render frame timing UNVERIFIED.** Hot-path code audit found no
  rerender storm / store churn / unthrottled handler (see `ATLAS_PERFORMANCE_BASELINE.md` Phase A
  addendum); sustained "feel" under a real feed needs live browser profiling (Atlas V2). (Supersedes
  PR2-G7.)
- **PA-G5 (P3, human-only) — chart-tool physical FEEL** (grip grab-ease, handle sizes, cursor
  affordances, TradingView-grade polish) is out of scope this phase; Atlas V2 human-review item. The
  interaction MODEL and selection reachability are objectively sound/fixed.
- **PA-G6 (P3) — final placement of the order-DOM copy STATUS indicator is PENDING ATLAS V2.** Copy
  configuration is fully out of the DOM (in the Copy panel); the DOM keeps only a tiny
  non-configurational "Copy · N accounts" status line. Where/whether that line lives is a V2 visual
  decision.

**Validation:** typecheck (web + 5 server projects) clean; build clean; trading regression
25 files / 247 tests pass; candle-truth + bar-order + pane-split + bounds regression pass. No P0, no
HARD-STOP condition triggered. Human acceptance PENDING HUMAN.

---

## Engineering Phase B (from `008fb3f`) — interaction integrity + workspace durability

See `ATLAS_ENGINEERING_PHASE_B_REPORT.md`, `ATLAS_INTERACTION_ARCHITECTURE.md`,
`ATLAS_MULTI_CHART_READINESS.md`.

**Closed / proven in Phase B:** 0 P0, 0 P1 — the interaction layer already met the invariants; Phase B
proved them mechanically. New proof: `coordinate-tick-truth.test.ts` (price↔pixel round-trip + tick
snapping, all 8 instruments). Ownership (marker vs drawing vs pane), version-guarded drags,
rejection-restore, stale-response guards (loadToken / seq / expectedVersion), reconnect rebuild, and
workspace-corruption fallback are all covered by existing + new deterministic suites.

**Documented, NOT closed (human-only / product decisions, not defects):**
- **PB-G1 (P3) — live in-browser frame-timing under a real feed UNVERIFIED.** Hot-path code is clean
  (Phase A/B audits); sustained "feel" needs browser profiling (Atlas V2).
- **PB-G2 (P3) — live multi-DPR visual confirmation UNVERIFIED.** Coordinate math is DPR-independent and
  the overlay re-rasterizes on DPR change; on-screen crispness across the owner's monitors is a human
  item.
- **PB-G3 (P3) — no single in-browser end-to-end chaos test.** The chaos sequence is covered in pieces by
  deterministic suites; a full browser harness is an Atlas V2 / browser-suite item.
- **PB-G4 (P3, product decision) — per-chart trading account.** Multi-chart ships today with one
  terminal-global account coupled to the active pane's symbol (a deliberate safety choice). A per-chart
  account is Nathan's decision; consequences recorded in `ATLAS_MULTI_CHART_READINESS.md`.
- **PB-G5 (P3, note) — non-representable decimal literals in `snapPrice`.** A hand-typed literal like
  `72.005` resolves to the nearer representable tick, not "up". Always on-grid/valid; never reached by
  real drag input. Behaviour documented in `coordinate-tick-truth.test.ts`; no fix needed.

**Validation:** focused web 22 files / 274 tests + server OCO/reconnect/race 6 files / 46 tests pass;
typecheck + build clean; trading regression green; canonical run once. No P0, no HARD-STOP. Human
acceptance PENDING HUMAN.

---

## Product Rebuild Phase 1 — Portal V2 Foundation (base `a4a2d0f`)

Portal V2 is isolated (dev-only `/portal-v2`, `.htv2`/`--ht-*` scope, code-split), reads the
authoritative account system, and duplicates no business truth. Nothing below is a P0/P1; all are
deferred-by-design items and one pre-existing flake.

- **PV2-1 (RESOLVED in Product Rebuild Phase 2).** V2 evaluation progress now shows profit toward the
  **authoritative profit target** (`account_profile_versions.config.rules.profitTargetMicros` — the same
  number the rule engine passes on), surfaced through a minimal, additive portal-contract extension (no
  schema change, no migration, no economics change). Funded accounts (target 0) show no target bar. The
  Phase 1 drawdown-room framing was a truthful temporary stand-in and is retired. See
  `PORTAL_V2_ACCOUNT_DETAIL.md §5`, `PORTAL_V2_DATA_OWNERSHIP.md §Phase 2`, and
  `PORTAL_V2_PHASE2_REPORT.md`.
- **PV2-2 (P4, hygiene).** The web mirror type `AccountSummary` (`apps/web/src/portal/lib.tsx`) omits
  `activatedAt`, which the server `PortalAccountSummary` includes. V2's Accounts vertical does not use it,
  so this is not a Phase 1 defect. Add it to the mirror when a vertical needs it, rather than re-fetching.
- **PV2-3 (P3, scope).** V2 has no account **detail** page yet; "View details" links to the live V1
  detail route (`/portal/accounts/:id`). Intended as the first item of the next phase.
- **PV2-G1 (P3, pre-existing flake — NOT introduced by Phase 1).** `apps/server/src/http/trading-authz-http.test.ts`
  can hit a `beforeEach` "Hook timed out in 10000ms" under the 216-worker canonical contention (file setup
  ~7.7s alone). It passes **4/4 in isolation**. Seen in Phase B and the Phase 1 baseline; re-run resolves.
  A fix (raising this file's hook timeout or reducing per-test setup) is a test-infra nicety, not a
  product issue.

**Validation:** 31 focused V2 tests pass; two real-browser overflow scripts contained at
1920/1440/1280/1024/768/390; web typecheck + build clean; canonical run once (only PV2-G1 flake, green in
isolation). No P0, no P1. Human visual acceptance of the V2 surface PENDING HUMAN (deliberately deferred —
Phase 1 is structure, not final polish).

---

## Product Rebuild Phase 2 — Accounts vertical complete (base `85b644d`)

The Accounts vertical is now complete and isolated: authoritative evaluation-target progress (PV2-1 resolved),
Account Detail V2 (Overview/Performance/Controls/Rules/Activity), Accounts↔Detail↔Trade journey, ownership +
race + responsive proofs. Nothing below is a P0/P1.

- **PV2-3 (RESOLVED).** V2 now has an isolated Account Detail (`/portal-v2/accounts/:id`); the Accounts list
  links to it, not to V1 detail.
- **PV2-2 (P4, hygiene, unchanged).** The web `AccountSummary` mirror still omits `activatedAt` (unused by
  the Accounts vertical).
- **PV2-4 (P3, scope note).** V2 Performance renders the equity curve as a line only (no hover tooltip /
  P&L calendar yet, which V1 has). This is a deliberate Phase-2 scope boundary, not a defect — all metrics
  shown are real and it degrades truthfully when data is thin. A richer curve is a later-phase item.
- **PV2-G1 (pre-existing flake, unchanged).** `trading-authz-http.test.ts` beforeEach hook-timeout under
  full canonical contention; passes in isolation. Not introduced by Phase 2.

**Validation:** V2 focused suite green; portal HTTP + lifecycle tests green (incl. new authoritative-target
assertions and IDOR on the controls route); two real-browser overflow proofs (accounts + detail) contained
at 1920/1440/1280/1024/768/390; web typecheck + build clean; canonical run once. No P0, no P1. Human visual
acceptance of the V2 Accounts vertical PENDING HUMAN (the deliverable of this phase).

---

## Engineering Resilience Phase 1 — findings (base `b48ba7e`)

Adversarial backend/failure engineering. No P0/P1 invariant was found false. Detection for all major corruption classes now exists in `apps/server/src/platform/resilience/integrity-checks.ts`. See `BACKEND_INVARIANT_LEDGER.md`, `TRANSACTION_BOUNDARY_MAP.md`, `FAILURE_RECOVERY_MATRIX.md`, `RESILIENCE_PHASE1_REPORT.md`.

- **PV2-G1 (RESOLVED).** The `trading-authz-http.test.ts` `beforeEach` hook-timeout under heavy parallel-worker
  contention was CPU/memory starvation from memory-hard scrypt (N=2^15 ≈ 32MB/op) run 4× per test in setup.
  Fixed at root: `apps/server/src/auth/password.ts` uses a low work factor (N=2^10) under the test runner
  (VITEST / NODE_ENV=test) only; production keeps N=2^15, and N is encoded per hash so verification is
  unaffected. Measured hash 274ms→11ms in test mode. This also cuts contention for the whole auth-heavy suite.
- **RES-1 (P2 — PRODUCT DECISION, not changed).** The firm/personal **contract cap** is checked at order
  submit against the current position weight (`risk.ts checkOrder`, `engine.ts` `openContracts`), not against
  working/resting orders, and there is no fill-time cap. So stacked resting limit orders can collectively fill
  to a position beyond `maxContracts`. Bounded, simulated, deliberate; no money duplication, no cross-customer
  effect, not a stale-state race. Whether "max N contracts" should bound working orders is a **product
  decision for Nathan** (Part XLIV: stop, do not change account rules). Recommended next-phase work: submit-time
  reservation of working-order increasing-qty, once the semantics are decided.
- **RES-2 (P3, by design).** `expectedVersion` is optional on order modify (`engine.ts:1489`) and personal
  control mutation (`personal-risk.ts`); omitting it opts out of stale-write *detection* (the row lock still
  serializes). Consider making it required for these mutations in a later phase.
- **RES-3 (P3, self-healing).** EOD finalization writes the day statistic and the account counters in two
  awaits, not one transaction (`engine.ts` `recordClosedDay` + `persistRuleState`); a crash between them
  self-heals on the next revaluation (idempotent roll + absolute-set counters). Recommend wrapping both in one
  `db.transaction`.
- **RES-4 (P3, defense-in-depth).** `accounts.resetOfAccountId` has no unique index; the "one successor per
  failed account" invariant is enforced by the `reset:<id>` idempotency key (proven under 8-way concurrency).
  Recommend a partial unique index `WHERE reset_of_account_id IS NOT NULL`. Detected today by the integrity
  check `DUPLICATE_RESET_SUCCESSOR`.
- **RES-5 (P3).** The personal-control hash-chain audit is best-effort post-commit (`personal-risk.ts` catch
  swallows a failed `recordAudit`); the durable in-txn `traderRiskControlEvents` row still records the change,
  so it is not unrecorded, but the tamper-evident chain can miss it.

**Validation:** 11 new focused tests (harness + races + integrity) pass; PV2-G1 file 4/4 in isolation; typecheck
+ build clean; canonical run once. No P0, no P1.

---

## Engineering Resilience Phase 2 — findings (base `4c4570d`)

Persistence / crash-recovery / reconciliation / database-disaster proof. Failures were **injected**
(a connection-layer fault injector, `platform/resilience/failpoints.ts`) to prove every critical
workflow commits fully, rolls back fully, or recovers deterministically. See
`RESILIENCE_PHASE2_REPORT.md`, `DURABILITY_MAP.md`, `CRASH_POINT_MATRIX.md`,
`BACKEND_RECOVERY_RUNBOOK.md`. **0 P0, 0 P1.** Two real data-integrity defects fixed at the root.

- **RES-P2-1 (P2 today; P1 at real-money launch) — RESOLVED.** A payout debits the account balance at
  approval. Before this phase, a *definitive* provider failure (`PAYOUT_FAILED`) flipped the request to
  FAILED but left the balance debited with **no REVERSAL ledger row and no restoration** — the trader's
  authoritative balance was reduced for money that was never paid, and it was invisible to the integrity
  checks (which only require a DEBIT in APPROVED/PROCESSING/PAID). Contained today because no real payout
  rail is wired (HTF-3), and the FAILED path is only reachable via a mock provider. **Fix:**
  `payout-operations.ts failPayout` now reverses the debit atomically (restore balance + dayStart anchors
  + write a `payout_ledger` REVERSAL, idempotent on the unique `(request,REVERSAL)` index) in one
  transaction with the state flip. FAILED is terminal, so no later PAID can double-benefit. New integrity
  detector `FAILED_PAYOUT_DEBIT_NOT_REVERSED`. Proven by `payout-reversal-crash.test.ts` (reversal exact,
  idempotent, crash-atomic). RETURNED/CANCELED provider outcomes are intentionally left to audited operator
  reconciliation (money genuinely moved) — see the runbook.
- **RES-3 (was P3) — RESOLVED.** EOD `recordClosedDay` + `persistRuleState` now run in ONE
  `db.transaction` (`engine.ts rulesLocked`); a crash writes neither, and replay is idempotent. Proven by
  `engine-atomicity.test.ts`.
- **RES-4 (was P3) — RESOLVED.** Partial unique index `accounts_reset_of_key WHERE reset_of_account_id IS
  NOT NULL` (migration 0036) enforces "one reset successor per failed account" at the DB, behind the
  application idempotency key. Fresh-DB migrate-from-zero + fail-closed concurrency proof.
- **RES-5 (P3, unchanged).** Personal-control hash-chain audit remains best-effort post-commit; the
  authoritative durable record is the atomic in-txn `trader_risk_control_events` row (no mutation is
  unrecorded). Future: deliver the chain audit through the durable outbox.
- **RES-1 (P2, PRODUCT DECISION, unchanged).** Whether "max N contracts" bounds working orders remains
  Nathan's decision; documented only, not changed. **Phase 3** quantified it in full —
  `RES1_CONTRACT_LIMIT_ANALYSIS.md`: the cap is checked at submit time against position + this order only
  (no working-order count, no fill-time cap), so stacked resting orders can fill past the cap; it is
  bounded, single-account, never duplicates money, and P&L/drawdown still bind correctly. Fix requirements
  are enumerated there for when the product decision is made.
- **PV2-G1** — the Phase-1 test-mode scrypt reduction is now **mechanically proven isolated** from
  production/default runtimes (`selectScryptParams`, `test-mode-security.test.ts`).

New infrastructure: fault-injection framework (`failpoints.ts`), independent position/P&L/ledger
reconciliation oracle (`reconcile.ts`), backup/restore drill (`scripts/resilience-restore-drill.sh`), and
an added integrity detector. **Validation:** 43 resilience tests (8 files; 32 new across 7 new files),
typecheck + build clean, migrate-from-zero + restore drill pass, canonical run once. No economics,
product-rule, contract-limit, Portal V2, Atlas, or provider change.

---

## Security Phase 1 (2026-09-30, base `ae9a4a3`) — findings

Hostile-client / auth / authz / API-abuse / trust-boundary attack pass. Baseline
security suites re-attacked and green (166/166). No P0/P1 found. Full detail:
`SECURITY_PHASE1_REPORT.md`, `SECURITY_TRUST_BOUNDARY_MAP.md`,
`SECURITY_ENDPOINT_MATRIX.md`, `SECURITY_INVARIANT_LEDGER.md`.

- **SEC-1 (P2 — FIXED).** The step-up reauth endpoint `POST /api/v1/admin/security/reauth`
  re-verifies the operator password to mint a step-up token (gates FINANCIAL / STAFF /
  KILL_SWITCH actions) but had no rate limit (global limiter is `global:false`), leaving
  the step-up password gate open to online brute force by any holder of a valid access
  token. **Fixed:** per-IP cap 10/min (`owner-staff.ts`), regression `security-phase1.test.ts`.
- **SEC-2 (P2 — documented, not changed).** Market-data replay/recording/provider controls
  (`/api/v1/marketdata/replay/*`, `/recordings/capture`, `/provider`) are a customer-facing
  Atlas feature gated by bare `requireUser`, but implemented as a **global singleton**
  (`deps.replay`/`deps.recorder`), so one customer's replay load/play/seek or live↔replay
  provider switch affects **every** tenant's chart feed. Impact is market-data *display*
  only — no money, authz, orders, or cross-customer private data. A correct fix is
  per-session replay isolation, which is an Atlas market-data redesign (out of Phase-1
  scope). Recommend: gate the mutating global controls behind an operator role, or isolate
  replay per session, before multi-tenant launch.
- **SEC-3 (P3 — pre-launch gate).** The payout webhook `/api/v1/webhooks/payout/:provider`
  performs no signature verification (a seam) and reads the parsed body, not a captured raw
  body. Production fails closed (mock/unconfigured → 202 no-op; settlement guarded by
  terminal/out-of-order checks + unique `(request, entry_type)` ledger). Must gain raw-body
  signature verification + a non-attacker-controlled dedup key before any real payout rail
  is enabled. Contrast: the commerce/Whop webhook is fully verified.
- **SEC-4 (P3 — confirm intent).** `POST /api/v1/admin/users/:id/notes` runs at SUPPORT
  while sibling note redaction requires ADMIN. Confirm whether SUPPORT should author user
  notes; tighten if not.
- **Access-token revocation (P3, pre-existing tradeoff).** Logout / `revokeAllSessions`
  revoke refresh tokens only; a stateless access JWT stays valid until its ≤15-min `exp`.
  Acceptable JWT tradeoff; documented.

No real secret is committed (only test/placeholder/`.env.example`); no server secret in the
web bundle; injection audit found no externally-reachable SQL/command/path/SSRF/redirect/XSS/
prototype-pollution sink. No economics, product-rule, RES-1, Portal V2, or Atlas change.

---

## Operational Readiness Phase 1 (2026-09-30, base `3fe1d19`)

Observability / health / diagnostics / incident-evidence / safe-operations pass.
The operational surface was already mature (liveness/readiness, kill switches, audit
hash chain, System Doctor, integrity + reconciliation tooling, provider-safety,
incidents/alerts). This phase inventoried it, proved it, and closed a handful of
low-risk visibility gaps. **No P0/P1 operational defect found.** Full detail:
`OPERATIONAL_READINESS_PHASE1_REPORT.md`, `OPERATIONAL_READINESS_MAP.md`,
`OPERATIONAL_SIGNAL_MODEL.md`, `OPERATIONAL_ALERT_CATALOG.md`,
`OPERATIONAL_INCIDENT_RUNBOOK.md`.

- **OPS-1 (P2 — FIXED).** Log redaction was too narrow (only authorization header +
  password/refreshToken body). Widened to cookies, `set-cookie`, `x-stepup-token`,
  webhook signature headers, and additional token/password body fields (`http/app.ts`).
- **OPS-2 (P3 — FIXED).** No `x-request-id` on responses and a client-supplied request
  id was trusted verbatim. Added `safeRequestId()` + Fastify `genReqId` (bounded token
  or generated UUID) and an `x-request-id` response header for support correlation.
- **OPS-3 (P2 — FIXED).** The RES-P2-1 detector (failed payout debited but not reversed)
  existed only in the CLI integrity suite, invisible to the owner console. Added
  `INV_FAILED_PAYOUT_DEBIT_REVERSED` to `platform/integrity.ts` (console suite now 11 checks).
- **OPS-4 (P3 — FIXED).** `outboxStats` gained `oldestPendingAgeMs`; a reusable
  `outboxHealth()` (HEALTHY/DEGRADED + reason) now makes a stall detectable from the
  shared helper, not just inlined admin code.
- **OPS-5 (P2 — FIXED).** System Doctor gained a first-class `outbox` probe (was only
  surfaced on the admin `/system` endpoint).
- **OPS-6 (P2 — FIXED).** Rate-limit blocks (429) and privileged authz denials (403)
  now emit a bounded, payload-free `securityEvent` structured log (no audit-chain flood,
  no metric cardinality). Login success/failure audit remains a documented gap below.
- **OPS-7 (P3 — documented, not changed).** Two divergent integrity/reconciliation
  stacks (CLI/resilience vs HTTP/console); neither a superset. Unifying is a larger
  refactor, out of Phase-1 scope. OPS-3 closed the one launch-critical divergence
  (RES-P2-1) so the console no longer misses it.
- **OPS-8 (P3 — documented).** Provider health uses three vocabularies incl. a
  `ProviderHealthState` name collision (contracts vs payout); no md/exec health
  transition test suite (payout DOWN→HEALTHY is proven). Renaming a shared contract
  type is out of scope.
- **OPS-9 (P3 — documented).** No forced-shutdown drain timeout and no outbox worker
  heartbeat; a stall is inferred from oldest-pending age. Login success/failure is not
  audited (the SECURITY stream's `auth.*` prefix has no producer yet).

New read-only operator tooling: `pnpm ops:check` (build, DB, providers, outbox health,
System Doctor, latest persisted integrity — never a deep scan). No economics,
product-rule, RES-1, SEC-2, SEC-3, Portal V2, or Atlas change; no provider activated;
no paid monitoring stack added.

---

## Portal V2 Full Product Rebuild (base `298a69c`, 2026-10-01)

Frontend-only rebuild of the customer Portal V2 (dev-only `/portal-v2` review
surface). No backend/economics/payout/rules/risk/lifecycle change. See
`PORTAL_V2_REBUILD_REPORT.md`, `PORTAL_V2_PRODUCT_ARCHITECTURE.md`,
`PORTAL_V2_VISUAL_SYSTEM.md`.

- **PV2R-1 (P3 — FIXED, test-only).** `golden-path.core50k.test.ts` carried a
  clock-triggered **test-data time-bomb**: it seeded `activatedAt: new Date()` and
  recorded winning days hardcoded as `2026-10-01`…`2026-10-05`. The (correct,
  unchanged) product rule counts qualifying winning days **strictly after** the
  cycle-start date (= activation day), so the moment the real clock reached
  2026-10-01 the first winning day was excluded (4 < 5) → `INSUFFICIENT_WINNING_DAYS`,
  cascading to 5 failures (steps 10–15). Proven unrelated to the rebuild (zero server
  code in the diff; it would fail identically on base on this date). Fixed by making
  the fixture's dates **relative to now** so it can never rot again; no product,
  payout, or economics logic changed. Canonical then green (3156 pass, 0 fail).
- **PV2R-2 (status, not a defect).** Portal V2 remains **dev-only** and **not
  migrated** to production; V1 is the live customer portal and instant rollback.
  Owner Console is role-gated and absent for a normal customer. Human acceptance
  (Nathan) is pending; Claude's claim is bounded to "candidate ready for human
  acceptance."

## Portal V2 Human-Rejection #1 repair (base `25d7738`, 2026-10-01)

Frontend-only repair after Nathan's human-acceptance failure (wordmark, sharper
institutional design, working nav + Payouts/Certificates/Billing/Support, richer
accounts, no dev slop, owner entry moved to the account menu). No server/economics
change. See `PORTAL_V2_REBUILD_REPORT.md` addendum.

- **PV2R1-1 (P3 — environmental, not this change).** The canonical full suite
  (240 workers) shows load-induced flakes under heavy container load: a different
  small set fails each run (`trading/determinism` latency/replay, `trading/
  consistency-gate-engine`, `resilience/reconcile`, `auth/mfa` scrypt sealing), and
  every one passes in isolation (proven). Timing/CPU-contention sensitive; unrelated
  to the frontend diff (zero server files changed). Mitigation would be server test
  config (worker caps / scrypt isolation — see prior "test-scrypt isolation"), out of
  scope for this frontend repair.
- **PV2R1-2 (status).** Portal V2 remains dev-only and NOT migrated; V1 is live +
  instant rollback. Human acceptance by Nathan pending; claim bounded to
  "ready for human acceptance".

---

## Portal V2 — Human-Acceptance Review #2 (customer-experience restructure)

- **PV2R2-1 (status).** Portal V2 remains dev-only (`/portal-v2`, gated by
  `designLabEnabled()`); production 404s. Not migrated; V1 live with instant rollback. Review
  #2 delivered: larger official brand lockup, de-pilled status, Accounts master/detail,
  Profile & account center (new), categorised Certificate vault with real
  download/verify seams, premium (non-gambling) Payouts, provider-safe Billing with payment
  method + provenance, portfolio performance chart, and a deterministic zero-customer mode
  (`?state=empty`). Claim bounded to "ready for human acceptance (#2)".
- **PV2R2-2 (seams, not defects).** Portfolio-P&L endpoint, payment-method provider flow,
  receipts, notification-preference writes, and physical-certificate commerce are documented
  seams with truthful UI states — see PRODUCT_UX_DEBT.md and the PORTAL_V2_* architecture docs.
  No surface fabricates data to cover a seam.
- **PV2R2-3 (brand).** The chrome symbol derivative is held out of shipping surfaces pending a
  clean-edged source (HAPPY_TRADER_BRAND_ASSET_MAP.md). Stacked + wide wordmarks ship.

---

## Portal V2 — Human-Acceptance Review #3 (real product depth)

- **PV2R3-1 (status).** Portal V2 remains dev-only (`/portal-v2`, `designLabEnabled()`); production
  404s; not migrated; V1 live with instant rollback. R3 delivered: Accounts re-composed to a
  brokerage ledger + flat statement; Certificates show ACTUAL rendered artwork (artwork-first gallery +
  large preview, real download/verify); a REAL interactive performance chart (lightweight-charts) with
  companion metrics; Support wired to the authoritative `/api/v1/support` ticket API (create/list/
  thread/reply); deeper provider-safe Billing (card face + manage modal); Dashboard progress & payout
  readiness. Claim bounded to "ready for human acceptance (#3)".
- **PV2R3-2 (preview auth).** The vite-only preview is unauthenticated, so live-wired surfaces
  (Support list/create) show empty/real-error states there; full-stack + signed-in they are live.
  Authoritative support create/lifecycle + certificate/ticket/billing IDOR are proven by existing
  server tests (`support-http.test.ts`, `certificate-security.routes.test.ts`).
- **PV2R3-3 (seams).** Portfolio-P&L endpoint, payment-provider management URL, receipts, physical
  certificate commerce, achievements, and a future support assistant are documented seams — see
  PRODUCT_UX_DEBT.md and the PORTAL_V2_* / *_EXISTING_SYSTEM_AUDIT docs.

## Experience Layer Phase 1 (EXP1)

- **EXP1-A (deferred, not a defect).** Production customer portal (V1) does not yet mount
  the Portal V2 Progress surface; V2 remains the gated dev-review harness. Server endpoints
  (`/api/v1/portal/progress`, `/goals`) are implemented and tested.
- **EXP1-B (deferred).** No in-app notification center / "unseen achievement" nav dot this
  phase; achievement-unlock sound hooks documented but not implemented (no auto audio).
- **EXP1-C (deferred).** Owner-side customer-journey visibility beyond existing achievement
  + payout-ops surfaces; no Owner Console changes made (documented dependency).
- No P0/P1 introduced by EXP1. No trading-economics, Atlas, provider, or Owner Console
  changes. Clubs use cumulative PAID trader-share only; tracked goals cannot be forged.

## Customer Product Integrity Phase 1 (CPI)

- **CPI-1 (P2/UX). RESOLVED — Customer System Hardening §4A.** Portal→Atlas handoff
  no longer silently substitutes another account. The selection decision is a pure,
  tested function (`apps/web/src/state/account-selection.ts`): a verified handoff
  selects exactly the requested account; an unresolvable handoff raises
  `handoffUnavailable` and the terminal shows a notice (`HandoffNotice.tsx`) rather
  than passing a fallback off as the requested account. 8 regression cases
  (`account-selection.test.ts`).
- **CPI-2 (P2). RESOLVED — §4B.** The dashboard payout badge no longer renders a
  failed `/certificates` fetch as `0`. `countBadge()` keeps the count unknown ("—")
  on error, distinct from a real `0` (`apps/web/src/portal/metric-display.ts`,
  5 regression cases).
- **CPI-3 (P3). RESOLVED — §4C.** Anonymous affiliate `/apply` now dedups by email
  (the only stable key for an anonymous applicant), mirroring the logged-in guard;
  a DECLINED applicant may re-apply (`affiliates.ts submitApplication`, 3 regression
  cases).
- **CPI-4 (note). RESOLVED — §4D.** `portal-accounts.ts` reads the single
  `MAX_ACTIVE_ACCOUNTS` constant it enforces with; the duplicated literal is gone.
  Regression asserts the reported cap equals the enforcement constant.
- No P0/P1. All customer business chains CONNECTED and cross-system reconciled
  (see docs/CUSTOMER_PRODUCT_INTEGRITY_REPORT.md and
  docs/CUSTOMER_SYSTEM_HARDENING_REPORT.md). EOD canonical flake root-caused as
  a test-only fixed-sleep timing dependency and fixed deterministically; no risk-engine
  change.

## Customer System Hardening Phase 1 (adversarial certification)

- No P0/P1/P2 open. The four CPI carry-forwards above are RESOLVED with regressions.
- Integrity detectors hardened against false positives and multi-corruption
  (`customer-product-integrity.test.ts`, 9 cases).
- `pnpm customer:certify` (FAST / `CUSTOMER_CERTIFY_DEEP=1`) aggregates the
  customer-chain proofs, exits nonzero on failure, and refuses to target production.
- **HARD-1 (residual, accepted).** The affiliate anonymous-dedup and the pre-existing
  logged-in dedup are query-guards inside the submit transaction, not a DB unique
  index, so a sub-second double-submit race could still create two rows. Mitigated by
  the 5/min rate limit; a partial unique index is the future hardening if it ever
  recurs. Not launch-blocking.
- **EXTERNAL PRODUCTION UNVERIFIED.** Rithmic, Whop-production, the payout rail, KYC,
  object storage and email are NOT connected in this environment and are NOT certified.
  `customer:certify` certifies internal software only; see
  docs/CUSTOMER_SYSTEM_CERTIFICATION.md.

---

## Portal Convergence Phase 1 — one canonical `/portal` (base `1a532e3`)

The two competing customer portals are converged. **`/portal` is now the ONE
canonical customer product: the approved V2 experience (`V2AppShell` sidebar + V2
pages, `apps/web/src/portal/PortalV2App.tsx`) backed by the hardened authoritative
customer core (`/api/v1/*`; the browser computes no business truth).** The rejected
horizontal-nav V1 shell (`portal/PortalApp.tsx`) is no longer the customer runtime.
`/portal-v2` remains a DEV-only review harness (fixtures, `designLabEnabled()`-gated,
404 in production) — never a second production product. Authoritative docs:
`docs/CANONICAL_CUSTOMER_PORTAL.md`, `docs/PORTAL_CONVERGENCE_MAP.md`,
`docs/PORTAL_CONVERGENCE_REPORT.md`. The pre-convergence `PORTAL_V2_ROUTE_ARCHITECTURE.md`
carries a superseded banner.

**No P0 and no P1.** The items below are documented scope limitations where the V2
presentation would otherwise require fabricating data the backend does not serve — all
degrade truthfully, none fabricate.

- **PCV-1 (P3, scope).** No portal-level cumulative performance chart on the Dashboard
  (no authoritative portfolio-series endpoint). Per-account performance is live in
  Account Detail. No curve is ever fabricated — the Dashboard chart renders only when an
  authoritative series exists.
- **PCV-2 (P3, scope).** Billing `totalSpent` roll-up is not shown (order price micros
  are not exposed authoritatively); order rows are truthful. Payment method shows
  none-on-file (provider-hosted checkout).
- **PCV-3 (P3, scope).** Payouts `inReview` / `cyclesText` summary fields are blank where
  no authoritative customer-facing source exists; standing, history, and lifetime-paid are
  authoritative. Max paid payout cycles remain 5 (server-authoritative); no `3 of 12` or
  invented cycle count renders.
- **PCV-4 (P4, hygiene).** Profile / security / verification use the hardened V1 surfaces
  (`ProfilePage`, `PayoutMethodsPage`) mounted inside the V2 shell; the richer V2
  `ProfileView` has no backend yet, so it is not promoted (avoids fabricating identity
  fields). Replace with a native V2 profile when the backend serves it.
- **PCV-5 (P4, cleanup).** The legacy `portal/PortalApp.tsx` and its `pages/*Page.tsx`
  remain in the tree, unrouted (no longer the customer runtime), pending a careful delete
  in a follow-up. They are not reachable by any customer route.

**Validation:** web typecheck PASS; production web build PASS; 189 web tests PASS (incl.
new `portal-convergence.test.ts` fixture-firewall + route proofs); headless browser
(logged-in, SPA nav) shows the canonical V2 shell at `/portal`, the rejected shell absent,
0 console errors (screenshots in `docs/portal-convergence-screens/`); `customer:certify`
FAST and DEEP PASS. Human L5 acceptance against the ACTUAL customer app (`/portal`)
PENDING HUMAN (Nathan), with ChatGPT independent convergence review as directed.

- **PCV-6 (P3, pre-existing test-infra flake — NOT a convergence defect, NOT a product
  bug).** The full `pnpm validate:release` serialized suite (3295 tests, ~575s) surfaced
  12 failures across 6 **server-side** files — `trading/{determinism,adversarial,
  eod-trailing-engine}.test.ts`, `http/affiliate-{http,security}.test.ts`,
  `db/schema.test.ts` — under heavy shared-Postgres + CPU contention. The signatures are
  all isolation/contention, not logic: a `deadlock detected` on `DELETE accounts` in a
  harness teardown (two live transactions), another file's lifecycle `endedAt` leaking
  into `schema.test`, affiliate `409 already-applied` + cascading `undefined` from rows a
  prior file left in the shared DB, and replay-determinism values drifting when `settle()`
  wall-clock waits under-drain on a starved CPU. **Every one of the 6 files passes in
  isolation on a freshly-prepared DB (48/48 tests green).** None is in code the Portal
  Convergence changed — the diff from baseline `1a532e3` touches **0 server files** (web +
  docs only). This is a latent full-run isolation fragility of the trading/affiliate test
  harnesses (async engine work and shared seed rows bleeding across files), independent of
  convergence. Recommended future hardening: quiesce `TradingEngine` async work before
  harness teardown, and give the affiliate HTTP suites per-file DB isolation. Not
  launch-blocking and not a customer-facing issue.
