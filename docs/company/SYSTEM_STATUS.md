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

> **⟳ Phase 3.5 (2026-09-26) — product acceptance + risk-semantics lock.** The authoritative
> product model (Phase 3) was accepted against real rendered surfaces — public pricing, Owner
> Products, Customer Portal — and the funded-risk + payout semantics were **locked** in
> `@atlas/contracts` (EOD-trailing floor locks at starting balance,
> `trailingLockAtMicros = 0`; breach on equity; CORE/SELECT $0 funded buffer; post-payout
> floor safe). Reconciliation published new immutable versions (v2) per profile; pinned
> accounts keep v1. Owner auth re-verified: `owner@atlasfutures.local` is SUPER_ADMIN and
> reaches admin APIs; the demo TRADER is correctly 403 on admin APIs — RBAC unchanged. Still
> **no system is PRODUCTION-VERIFIED**, and the Owner Console mouse-wheel fix remains
> **owner-manual-acceptance-pending** (Playwright is not sufficient evidence). See
> `PRODUCT_SOURCE_OF_TRUTH.md`, `ACCOUNT_STATE_MACHINE.md`, `DECISION_LOG.md` DR-11.

> **⟳ Phase 4 (2026-09-26) — production provider safety boundaries.** The fail-OPEN P0/P1s are
> closed. A central provider-safety boundary (`apps/server/src/config/provider-safety.ts`) makes
> the rule **production never silently selects a mock**: commerce, identity and notification
> factories return the real (unconfigured) seam in production — fail closed — instead of a mock.
> `/design-lab` is gated to development builds; the development seed HARD-FAILS in production.
> Owner provider health + a startup safety summary surface the posture so a mock can never read as
> "healthy" in production. **This did NOT connect any real provider:** commerce (Whop prod), KYC
> (Stripe Identity) and payouts remain UNCONFIGURED and are **not** production-ready. Market data,
> execution, object-store and the payout registry were already fail-closed/deliberate and were
> revalidated. Still no system is PRODUCTION-VERIFIED. See `DECISION_LOG.md` DR-3 and
> `KNOWN_ISSUES.md` HTF-1/HTF-2/HTF-4 (resolved).

> **⟳ Phase 5 (2026-09-26) — CORE 50K Golden Path proven end-to-end (simulation).** A durable
> integration harness (`apps/server/src/platform/golden-path.core50k.test.ts`, 15 tests) +
> ownership/cap suite (`golden-path.security.test.ts`, 2 tests) drive the whole lifecycle with
> REAL domain services and the REAL trading engine: identity → $95 purchase → trusted mock payment
> → one Core 50K eval account → real NQ trade (P&L + commission + balance invariant) → EOD-trailing
> risk + consistency → evaluation pass → one funded account → funded cert → 5 winning days → payout
> eligibility → request → approval (exact 90/10 split, single debit, floor unchanged) → dev/test
> settlement → PAID (meta.mock) → payout cert → reconciliation, all exactly-once. Settlement and
> identity are DEV/TEST only; execution is SIMULATION. Nothing is PRODUCTION-VERIFIED. See
> `GOLDEN_PATH.md`.

> **⟳ Phase 6 (2026-09-26) — Atlas + Rithmic Test market-data & execution-path acceptance.** The
> Rithmic integration is proven **deterministically without live credentials**: framing, codec,
> template registry (ids derived not hardcoded), plants, the full connection state machine
> (`DISCONNECTED→CONNECTING→CONNECTED→AUTHENTICATING→AUTHENTICATED`, `DEGRADED/RECONNECTING/FAILED/
> STOPPED`), heartbeat, bounded reconnect, discovery (`SYSTEM_ABSENT` when the configured system is
> missing — never a silent swap), market-data normalization + ms-consistent timestamps + freshness
> (open socket ≠ fresh), historical bars + no-dup/no-backward merge, order lifecycle (ack ≠ fill,
> lost-ack → `SUBMISSION_UNKNOWN`), P&L, and reconciliation — **107 Rithmic + 127 market-data/
> provider-health/execution/P&L + 100 instrument + 23 owner-health tests green**, plus the Phase 5
> Golden Path still green (17). Provider selection is **fail-fast with NO fallback masking**
> (`MARKET_DATA_PROVIDER=rithmic` unconfigured → throws; never fabricates `CONNECTED`/quotes/bars/
> fills). Owner health is truthful: `UNCONFIGURED` / `NOT_VERIFIED` / `verified:false` until a live
> Rithmic Test session is run. **No Rithmic credentials exist in this environment**, so the live
> half — official R\|Protocol conformance, live auth, live tick, live order round-trip vs Rithmic
> Test — is classified **OWNER MANUAL REQUIRED** (checklist in `RITHMIC_ATLAS_ACCEPTANCE.md` §9).
> Rithmic stays **TEST-only**; nothing wired to production Rithmic; nothing PRODUCTION-VERIFIED.

> **⟳ Phase 7 (2026-09-26) — Owner OS operational control-plane acceptance.** Two real fixes plus an
> honest classification. **HTF-21 resolved:** the trader self-serve `rules`/`reset`/`environment`
> mutations (`http/routes/trading.ts`) are now PRACTICE-only (`assertSelfServeMutable`); a
> commercially-weighted EVALUATION/FUNDED account returns **403 `SELF_SERVE_FORBIDDEN`** — a trader
> can no longer weaken the rules they are judged by, revive a breach, or turn off their own fees
> (`self-serve-boundary.test.ts`, 6 tests). **HTF-24 resolved (kill-switch enforcement):** 5 of 7
> kill switches were engageable but inert; `assertNotEngaged` is now wired at the commerce /
> provisioning / payout-request / payout-submission chokepoints (423 `KILL_SWITCH_ENGAGED`) and the
> external safety gate is switch-aware (`kill-switch-enforcement.test.ts`, 6 tests). **Acceptance
> verdict:** routine ops (accounts, customers, payouts+STP, enforcement, support, affiliates, audit,
> product config, provider health) are console-operable without SQL/AI; the safety/config/incident
> plane + financial exports remain **view-only in the console (HTF-10 open)** — operable via API,
> now with real effect. Golden Path stayed green (17). Nothing PRODUCTION-VERIFIED. See
> `OWNER_OS_ACCEPTANCE.md`.

---

| SYSTEM | STATUS | USER SURFACE | BACKEND | DATABASE | PROVIDER | TESTS | BROWSER VERIFIED | KNOWN ISSUES | NEXT ACTION |
|--------|--------|--------------|---------|----------|----------|-------|------------------|--------------|-------------|
| Web shell / routing | BUILT (one DEV leak) | `App.tsx` all SPAs | — | — | — | — | partial | HTF-4 `/design-lab` ungated | gate design-lab to DEV |
| Auth / session | BUILT | login/refresh | `auth/service.ts`, `tokens.ts` | users, refresh tokens | none | yes | via console login | — | — |
| RBAC / permissions | BUILT | Owner OS gating | `permissions.ts`, `rbac.ts`, plugins | staff_permissions | none | yes | via console | — | — |
| Customer identity | BUILT | onboarding/verify | `customer-identity.ts` | customer_identities | — | yes | partial | — | — |
| KYC / identity verify | PARTIAL / DEV-ONLY | onboarding step | `identity-verification.ts` | identity records | **mock active; Stripe seam only, fails open** | yes (mock) | partial | **HTF-2 (P0)** | fail-closed in prod; wire Stripe |
| Customer portal | BUILT (2 dev shims) | `/portal` | portal routes | many | mock payout-method add; dev cert payment | yes | partial | — | — |
| Atlas terminal | BUILT | `/` trading UI | trading routes + engine | accounts, orders, positions | market-data dev-feed | extensive | yes (prior milestones) | ~~HTF-21~~ resolved (Phase 7) | — (self-serve rule/reset/env now PRACTICE-only) |
| Market data | BUILT; default DEV; Rithmic proven-in-sim | terminal feed pill | `marketdata/*`, `rithmic/*` | marketDataMeta, bars | **`yahoo-delayed` ~600s**; Rithmic Test wire path deterministically proven, live=OWNER-MANUAL; Databento gated off | yes (107 Rithmic + 127 md/health/exec/pnl) | partial | HTF-23 (cosmetic) | live Rithmic Test acceptance (owner, creds) |
| Execution | BUILT (sim); external DISCONNECTED; Rithmic adapter proven-in-sim | order flow | `execution/*`, `rithmic/plants/*`, engine | orders/fills | **simulation only**; Rithmic execution adapter fail-closed (refuses unless enabled), live route=OWNER-MANUAL | extensive | partial | HTF-23 (cosmetic) | live Rithmic Test order round-trip (owner, creds) |
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
| Owner OS console | BUILT; routine ops PROVEN, safety plane view-only | `/admin` (22 routes) | `admin.ts` + `owner-*.ts` | many | — | extensive | **yes (P1)** | HTF-10 (console surfacing) open; ~~HTF-24~~ enforcement resolved (Phase 7) | surface safety mutations in console |
| Product config | BUILT; **authoritative (Phase 3)** | Products page | `profiles.ts` + `@atlas/contracts/product-model.ts` + `product-reconcile.ts` | account_profiles, versions, drafts | — | product-integrity tests (contracts 149 + server DB 6) | yes (P3 browser: Owner Products + Portal) | ~~HTF-5, HTF-6~~ resolved | — (canonical model; DB=catalog) |
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
