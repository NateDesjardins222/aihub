# Operational Readiness Map

**Operational Readiness Phase 1** — an honest inventory of what already exists for
detecting, explaining, and safely responding to failures, classified so we never
build a second version of something that already works. Base commit:
`operational-readiness-phase1-start` (from Security Phase 1 head `3fe1d19`).

Legend: **PROD** = production-capable · **PARTIAL** = works but has a gap ·
**DEV/TEST** = development/test only · **MISSING** = absent · **DUP** = duplicated.

---

## 1. Health / liveness / readiness

| Capability | Where | Class | Notes |
|---|---|---|---|
| Liveness `GET /health` | `http/app.ts` | **PROD** | Always 200 while the loop runs; never probes DB/providers (no restart-loop on a DB blip); carries release identity; secret-free (tested). |
| Readiness `GET /ready` | `http/app.ts` | **PROD** | Probes PostgreSQL only (`select 1`, 2s timeout race) → 200/503. Provider outage does **not** flip readiness. |
| Version `GET /version` | `http/app.ts` + `config/release.ts` | **PROD** | `releaseInfo()` = commit (`GIT_SHA`/`RELEASE_SHA`/`SOURCE_COMMIT`, else `dev`) + label + boot time. |
| Infra posture `GET /api/v1/admin/infra` | `infra/health.ts`, `http/routes/admin.ts` | **PROD** | Redacted provider/posture snapshot (SUPPORT-role gated). Never a credential. |

Liveness and readiness have **distinct** semantics and are correct. Readiness
deliberately does not check migrations (that is a System Doctor deep check) — a
documented choice so `/ready` never flaps during a deploy migration window.

## 2. Startup / shutdown / version identity

| Capability | Where | Class | Notes |
|---|---|---|---|
| Env boot guard | `config/env.ts` `guardProduction` | **PROD** | `process.exit(78)` in prod on dev `JWT_SECRET` or wildcard CORS. Fail-fast. |
| Provider-safety boot summary | `index.ts`, `config/provider-safety.ts` | **PROD** | Per-capability mode printed at boot, secret-free; LOUD warning if a MOCK runs in prod. |
| `unhandledRejection` keep-alive | `index.ts` | **PROD** | Logs and stays up (liveness 200, readiness 503) through a transient DB loss. |
| Graceful shutdown | `index.ts` + `http/app.ts` onClose | **PROD** | SIGINT/SIGTERM → stop all workers → engine → market feed → `closeDb()`. |
| Build/version identity at runtime | `config/release.ts` | **PROD** | Surfaced on `/health`, `/version`, `/ready`. |
| Forced-shutdown timeout | — | **MISSING** | No self-imposed drain deadline; relies on orchestrator SIGKILL (P3, documented). |
| Migration check at boot | System Doctor `checkMigrations` | **PARTIAL** | Not in the boot path or `/ready`; verified by System Doctor (deep) instead. |

## 3. Logging / request id / correlation / error taxonomy

| Capability | Where | Class | Notes |
|---|---|---|---|
| Structured JSON logger (pino) | `http/app.ts` | **PROD** | JSON in prod. |
| Log redaction | `http/app.ts` `redact` | **PROD** (was PARTIAL) | **OPS-1**: widened to cookies, `set-cookie`, `x-stepup-token`, webhook signature headers, and password/token body fields. |
| Request id (every request) | Fastify `genReqId` | **PROD** (was PARTIAL) | **OPS-2**: `safeRequestId()` accepts a short plain client token or generates a UUID; echoed as `x-request-id`. No injection via the id. |
| Correlation | `platform/ops-events.ts` `correlationTrace()`, audit `context.correlationId`, entity ids | **PROD** | Entity ids + correlation trace suffice; no distributed-tracing system needed (by design). |
| Central HTTP error envelope | `http/errors.ts`, `http/app.ts` error handler | **PROD** | Uniform `{error:{code,message,detail}}`; 500 leaks no internals. |
| Domain error codes | ~30 per-module classes | **DUP** | Consistent envelope, dispersed code enums; no central registry (P3, documented — refactor out of scope). |

## 4. Outbox / queue health

| Capability | Where | Class | Notes |
|---|---|---|---|
| Transactional outbox + worker | `platform/outbox.ts` | **PROD** | At-least-once; SKIP-LOCKED claim; backoff → dead-letter after `maxAttempts`. |
| `outboxStats` (pending/deadLetter/delivered) | `platform/outbox.ts` | **PROD** (extended) | **OPS-4**: now also returns `oldestPendingAgeMs`. |
| `outboxHealth` (state + reason) | `platform/outbox.ts` | **PROD** (new) | **OPS-4**: reusable HEALTHY/DEGRADED assessment (dead-letter or stale-beyond-threshold), read-only. |
| Stall detection | `outboxHealth`, System Doctor, admin `/system` | **PROD** (was PARTIAL) | **OPS-5**: was inlined in `admin.ts` only; now a first-class System Doctor `outbox` probe using the reusable helper. |
| Worker heartbeat | — | **MISSING** | A stall is inferred from oldest-pending age, not an observed heartbeat (P3, documented). |

## 5. Integrity checking

| Capability | Where | Class | Notes |
|---|---|---|---|
| CLI/resilience integrity suite | `platform/resilience/integrity-checks.ts`, `scripts/integrity-check.ts` (`pnpm integrity:check`) | **PROD** | 10 detectors incl. RES-P2-1 `FAILED_PAYOUT_DEBIT_NOT_REVERSED`; JSON + exit codes (0/1/2). |
| HTTP/console integrity suite | `platform/integrity.ts`, `owner-system.ts` `/system/integrity` | **PROD** (extended) | 10 → **11** `INV_*` checks. **OPS-3**: added `INV_FAILED_PAYOUT_DEBIT_REVERSED` so the console surfaces the RES-P2-1 corruption the CLI already caught. |
| Two-stack divergence | both of the above | **DUP** (documented) | Not a superset either way (CLI has drawdown/phantom; console has affiliate/support). Documented in the report; unifying is a larger refactor, out of scope. |
| Cheap-vs-deep separation | `/health`,`/ready` (cheap) vs `/system/*`, `pnpm integrity:check` (deep) | **PROD** | Deep integrity/reconcile is never run on a health request. |

## 6. Reconciliation

| Capability | Where | Class | Notes |
|---|---|---|---|
| Execution/venue reconciler | `platform/reconciliation.ts` | **PROD** | Distinguishes IN_SYNC / RECONCILIATION_REQUIRED / **UNKNOWN** (venue unreachable). |
| Independent oracle (CLI) | `platform/resilience/reconcile.ts` | **PROD** | Position/P&L rebuilt from executions; balance identity; ledger arithmetic. |
| Reconciliation Center | `platform/reconciliation-center.ts` | **PROD** | matched / mismatch / unknown / **EMPTY** (never-run) per system. |
| Payout reconcile | `platform/payout-operations.ts` `reconcilePayout` | **PROD** | Provider-authoritative; never blind-retry. |

## 7. Provider / dependency state

| Capability | Where | Class | Notes |
|---|---|---|---|
| Provider-safety boundary | `config/provider-safety.ts` | **PROD** | REAL / MOCK / UNAVAILABLE; prod never silently selects a mock. |
| Provider health snapshot | `infra/health.ts` | **PROD** | Redacted; `ProviderHealthState` (md/exec). |
| Disabled ≠ failed | provider-safety, System Doctor | **PROD** | Unconfigured future rails report DISABLED/NOT_CONFIGURED/UNAVAILABLE at INFO, never CRITICAL. |
| OUTCOME UNKNOWN vs FAILED | `payout-provider.ts` (`LOST_ACK`/`TIMEOUT`), `execution/external-provider.ts` (`UNKNOWN`) | **PROD** | First-class and tested (payout DOWN→HEALTHY resume). |
| One canonical provider-state enum | — | **DUP** | Three health vocabularies incl. a `ProviderHealthState` name collision (contracts vs payout). Documented (P3); renaming a shared contract type is out of scope. |
| md/exec health transition test suite | — | **PARTIAL** | Payout DOWN→HEALTHY is proven; md/exec CONNECTED→DEGRADED→ERROR transitions are asserted only indirectly (P3, documented). |

## 8. Diagnostics / metrics / audit / incidents / alerts / flags / kill switches

| Capability | Where | Class | Notes |
|---|---|---|---|
| Owner observability (events/correlation/inspectors) | `http/routes/owner-observability.ts` | **PROD** | Permission-gated (`audit.read`, `customers.read`, …). |
| System Doctor + integrity + reconciliation routes | `http/routes/owner-system.ts` | **PROD** | `system.doctor.run` / `system.read`. `/system/full-test` = one overall. |
| Command Center roll-up | `platform/command-center.ts` | **PROD** | Doctor + integrity + financial + alerts + incidents + jobs. |
| Metrics/counters | `rithmic/metrics.ts`, `payout-ops-metrics.ts` | **PROD** | Bounded cardinality — **no** customer/account/order/payout label dimension. |
| Audit chain | `platform/audit.ts` | **PROD** | Append-only, tamper-evident hash chain per org; DB refuses UPDATE/DELETE. |
| Domain events | `platform/events.ts` (~130 types) | **PROD** | Machine-readable categories. |
| Incidents | `platform/incidents.ts` | **PROD** | Dedupe/group; statuses OPEN…RESOLVED; severities incl. EMERGENCY. |
| Alerts | `platform/alerts.ts` | **PROD** | Coalesce/escalate; INFO…EMERGENCY; truthful channel config. |
| Feature flags | `platform/feature-flags.ts` | **PROD** | Env-scoped, optimistic-concurrency, audited; never a secret. |
| Kill switches (7) + 6 chokepoints | `platform/kill-switches.ts` | **PROD** | HTTP 423; audited CRITICAL; queryable engaged-state. |
| Security operational events | `http/app.ts` error handler | **PROD** (new) | **OPS-6**: 429 (rate-limit) and 403 (authz-denied) now emit a bounded, payload-free `securityEvent` structured log. Login-success/failure audit remains a documented gap. |
| `ops:check` composition | `scripts/ops-check.ts` (`pnpm ops:check`) | **PROD** (new) | Read-only: build, DB, providers, outbox health, System Doctor, latest persisted integrity. Never a deep scan. |
| State probe | `platform/state-probe.ts` | **DEV/TEST** | Never mounted; CLI refuses prod. Correct. |

---

## What this phase changed (all low-risk, in-scope)

- **OPS-1** widen log redaction · **OPS-2** safe `x-request-id` · **OPS-3** RES-P2-1
  detector in the console integrity suite · **OPS-4** outbox oldest-pending age +
  `outboxHealth` · **OPS-5** System Doctor `outbox` probe · **OPS-6** security
  operational log signal · plus the `ops:check` self-check command.

## What already worked and was left alone

Liveness/readiness, startup/shutdown, kill switches, audit hash chain, incidents,
alerts, feature flags, reconciliation, provider-safety fail-closed, metric
cardinality, Command Center, and the CLI integrity/reconciliation tooling were all
already production-capable and were **not** rebuilt.
