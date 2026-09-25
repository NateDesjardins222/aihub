# SYSTEM STATUS

**Phase 2 — System-Wide Reconciliation. Audit-only.**

Baseline / LAST VERIFIED COMMIT for every row: `55df4c7` (branch
`claude/futures-trading-simulator-v8qefu`) · Compiled 2026-09-25.

## How to read this

- **STATUS** uses the Phase 2 vocabulary: BUILT / PARTIAL / BROKEN / DISCONNECTED /
  STALE-LEGACY / PLACEHOLDER / DEV-ONLY / NEEDS-REVALIDATION. **No system is marked
  PRODUCTION-VERIFIED** — that bar requires extraordinary evidence not available in this
  environment.
- **BROWSER VERIFIED** = a human/agent opened it in a real browser against the live stack.
  Owner OS routes were browser-verified in Stabilization P1 (`55df4c7`); most other surfaces
  are code-traced, not browser-walked, this phase.
- **PROVIDER** names the external dependency and its reality (mock / sandbox / unconfigured /
  dev-feed / none).

---

| SYSTEM | STATUS | USER SURFACE | BACKEND | DATABASE | PROVIDER | TESTS | BROWSER VERIFIED | KNOWN ISSUES | NEXT ACTION |
|--------|--------|--------------|---------|----------|----------|-------|------------------|--------------|-------------|
| Web shell / routing | BUILT (one DEV leak) | `App.tsx` all SPAs | — | — | — | — | partial | HTF-4 `/design-lab` ungated | gate design-lab to DEV |
| Auth / session | BUILT | login/refresh | `auth/service.ts`, `tokens.ts` | users, refresh tokens | none | yes | via console login | — | — |
| RBAC / permissions | BUILT | Owner OS gating | `permissions.ts`, `rbac.ts`, plugins | staff_permissions | none | yes | via console | — | — |
| Customer identity | BUILT | onboarding/verify | `customer-identity.ts` | customer_identities | — | yes | partial | — | — |
| KYC / identity verify | PARTIAL / DEV-ONLY | onboarding step | `identity-verification.ts` | identity records | **mock active; Stripe seam only, fails open** | yes (mock) | partial | **HTF-2 (P0)** | fail-closed in prod; wire Stripe |
| Customer portal | BUILT (2 dev shims) | `/portal` | portal routes | many | mock payout-method add; dev cert payment | yes | partial | — | — |
| Atlas terminal | BUILT | `/` trading UI | trading routes + engine | accounts, orders, positions | market-data dev-feed | extensive | yes (prior milestones) | HTF-21 self-serve rule edit | gate rule/reset/env to PRACTICE |
| Market data | BUILT; default DEV | terminal feed pill | `marketdata/*` | marketDataMeta, bars | **`yahoo-delayed` ~600s**; Rithmic/Databento gated off | yes | partial | — | choose real feed for launch |
| Execution | BUILT (sim); external DISCONNECTED | order flow | `execution/*`, engine | orders/fills | **simulation only**; registry off submit path | extensive | partial | — | — |
| Risk engine | BUILT | (server) + portal controls | `trading/risk.ts`, `@atlas/core` | accounts, dailyAccountStats, traderRiskControls | none | extensive | partial | drawdown TYPE per HTF-6 | resolve product rule |
| Commerce / checkout | PARTIAL | `/checkout` | `commerce.ts`, `commerce-provider.ts` | commercial_orders, commerce_events, entitlements | **Whop sandbox; mock fails open** | yes | partial | **HTF-1 (P0)**, HTF-3 | fail-closed; wire Whop prod |
| Account lifecycle | BUILT (2 flags) | portal/console | `account-service.ts`, `account-rules.ts` | accounts, account_lifecycles, account_qualifications | — | yes | partial | HTF-7, HTF-8, HTF-11, HTF-12, HTF-13 | resolve slot/limit + type staleness |
| Provisioning | BUILT (bypass flagged) | (server) | `provisioning.ts` | provisioning_requests | — | yes | n/a | HTF-7 M2M bypass | confirm limit policy |
| Payouts (economic) | BUILT & WIRED | portal + console | `payouts.ts`, `payout-core.ts` | payout_requests, payout_ledger, payout_cycles | — | extensive | partial | HTF-3 | — |
| Payout operations (STP) | BUILT & WIRED | Payout Ops console | `payout-operations.ts`, `payout-ops-worker.ts` | payout_operations, submission_attempts, provider_events | **mock (dev) / unconfigured (prod, fail-closed)** | yes | partial | HTF-3 | build real rail |
| Payout destinations | BUILT | Payout Methods | `payout-destinations.ts` | payout_destinations | tokenized only | yes | partial | — | — |
| Certificates | BUILT & WIRED | portal vault / public verify | `certificates.ts`, render service | certificates | LOCAL object store (S3 disabled) | yes | partial | eval/100k-club not renderable (by design) | — |
| Achievements | BUILT & WIRED | portal | `achievements.ts` | achievements | — | yes | partial | — | — |
| Physical cert fulfillment | PARTIAL (mock) | Certificate Store | `physical-orders.ts`, `certificate-store.ts` | physical_certificate_orders | **MockFulfillment; Prodigi disabled** | yes | partial | — | wire Prodigi if launching merch |
| Affiliates | BUILT (1 gap) | public + portal + console | affiliate-* modules | affiliate_ledger, commissions, payouts | payout provider NOT_CONFIGURED | extensive | partial | **HTF-9 (P2)** | add ledger constraint |
| Support | BUILT (UI gaps) | portal + console | support modules | support tickets/messages | — | extensive | partial | some backend features no UI | surface config/templates/KB |
| Enforcement | BUILT & WIRED | console + portal review | `enforcement.ts`, holds engine | cases/holds/appeals | — | extensive | partial | — | — |
| Economics v1 | STALE-LEGACY (active) | Economics page | `economics-sim.ts` | economics_runs | none (SIMULATION) | yes | yes (P1) | superseded by v2 | decide retirement |
| Economics v2 (M13) | BUILT (SIMULATION) | Economics (M13) page | `platform/economics/*` | economics_runs | none (SIMULATION) | yes | yes (P1) | derives from catalog not DB | — |
| Owner OS console | BUILT (exposure gap) | `/admin` (22 routes) | `admin.ts` + `owner-*.ts` | many | — | extensive | **yes (P1)** | **HTF-10 (P2)** + large backend-only set | surface safety mutations |
| Product config | BUILT; DB≠catalog | Products page | `profiles.ts` | account_profiles, versions, drafts | — | yes | yes (P1) | **HTF-5, HTF-6** | resolve authoritative model |
| Infrastructure / workers | PARTIAL | Infra/System pages | outbox, notify, workers | outbox_events | email/SMS mock; S3 disabled | yes | partial (read-only views) | HTF-18 cron unbound | — |
| Audit log | BUILT | Audit explorer | `audit.ts` | audit chain | — | yes | yes (P1) | — | — |
| CI / deploy / backups | MISSING | — | — | — | none | manual scripts only | n/a | HTF-16, HTF-17 | stand up CI + backups |

---

## Roll-up by status

- **BUILT & wired, internally sound:** auth, RBAC, identity spine, terminal, execution (sim),
  risk, payouts (economic), certificates, achievements, enforcement, audit, account lifecycle,
  Owner OS (as a set of loading pages).
- **PARTIAL (provider mock/sandbox/dev):** commerce, KYC, market data, physical fulfillment,
  payout settlement, infrastructure workers.
- **STALE-LEGACY (active):** economics v1; the default `db:seed` Atlas/practice catalog.
- **DISCONNECTED:** external execution registry (off the submit path); large Owner-OS ops
  backend (no UI); M2M provisioning bypass.
- **MISSING:** CI, backups, production deploy manifests.
- **DEV-ONLY leaks:** `/design-lab` in prod builds; fail-open mock providers (commerce, KYC).

**Nothing is PRODUCTION-VERIFIED.** The most defensible statement is: *the system is
comprehensively BUILT and internally server-authoritative, runs the full Golden Path in
simulation, and is not yet connected to real money, real KYC, or a production operating
environment.*

## PROVENANCE

Rows compiled from six parallel read-only subagent audits + the Stabilization P1 browser
inventory + direct DB inspection. LAST VERIFIED COMMIT is `55df4c7` for all rows. Money/trust
rows (commerce, KYC, payouts, product config) verified personally.
