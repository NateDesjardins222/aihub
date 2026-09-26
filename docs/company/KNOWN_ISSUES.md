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
- **Status:** OPEN.

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
- **HTF-21** — Trader can rewrite their own account risk rules / self-reset / set sim
  environment via ownership-only routes. Contained today (simulator, no commercial weight on
  those account types), but the boundary trusts customer-supplied risk parameters; must be
  gated (PRACTICE only) before those account types certify a paid evaluation. *(Security
  subagent trust-boundary risks #1–#3 — NEEDS-REVALIDATION for any account with commercial
  weight.)*
- **HTF-22** — Windows dev scripts use a Unix-style env prefix. `apps/server/package.json`
  `dev`/`start` are `NODE_USE_ENV_PROXY=1 tsx …`, which fails under Windows PowerShell/cmd.
  Documented (not fixed) in Phase 3: the clean cross-platform fix (`cross-env`) would add a
  new dependency + install, out of scope for the product-truth phase. **Re-reviewed Phase 3.5
  and deliberately left OPEN:** the only clean fix still requires a new dependency
  (`cross-env`), which the Phase 3.5 brief scoped out ("fix only if tiny and dependency-free").
  **Next action (next stabilization pass):** add `cross-env` and wrap both scripts.
  Unix/macOS/CI unaffected.
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
| P2 | 4 | HTF-7, HTF-8, HTF-9, HTF-10 |
| P3 | 5 | HTF-11..HTF-15 |
| P4 | 8 | HTF-16..HTF-23 |

The three P0s share one root theme: **the boundaries with the outside financial world
(payment in, KYC, payout out) are the least-connected and, for two of them, fail open rather
than closed.** Everything internal to the simulation is unusually disciplined.

## PROVENANCE

P0/P1 money-and-trust items (HTF-1, HTF-2, HTF-4, HTF-5) verified personally against source.
Remaining items from six parallel read-only subagent audits, cross-checked against schema and
the live DB. Items marked NEEDS-REVALIDATION were not reproduced by a live test this phase.
