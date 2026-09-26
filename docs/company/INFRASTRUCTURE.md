# INFRASTRUCTURE

**Happy Trader Funding — the actual runtime architecture, its state model, and what each tier needs to
survive the real world.** Phase 11 (2026-09-26). Source commit `52484e5`.

> Describes what exists today, evidence-backed (file:line). Separated into CURRENT / REQUIRED FOR BETA /
> REQUIRED FOR PRODUCTION / FUTURE SCALE so nothing is claimed ready that is not.

## Runtime components (CURRENT)

| Component | Required? | State | Prod-ready? | Failure / recovery |
|---|---|---|---|---|
| Web SPA (`apps/web`) | yes (UI) | stateless client | dev bundle | Not authoritative for anything; reloads and re-reads from API. |
| API server (Fastify, `apps/server`) | yes | stateless process | prod-ready | Restart-safe (all truth in Postgres). Graceful SIGTERM/SIGINT (`index.ts:16-23`). |
| **PostgreSQL 16** | **yes — sole source of truth** | **DURABLE** | prod-ready (self-hosted gate) | If down: `/ready` → 503; System Doctor CRITICAL. No DB = total outage, fail-closed. |
| Redis | **no — reserved, UNUSED** | n/a | not wired | **No `ioredis`/client import anywhere in `apps/server/src`.** All locks = PostgreSQL advisory locks; fan-out = Postgres LISTEN/NOTIFY. Redis outage has **zero** effect. |
| Background workers | partial | drive DURABLE tables | mixed | Outbox, notification, **payout-ops** (wired Phase 11), engine valuation loop. Inactivity sweep still cron-gated (HTF-18). |
| WebSocket gateway | yes (live UI) | EPHEMERAL sockets | prod-ready | On reconnect the client re-reads authoritative state from DB; heartbeat loop. |
| Market-data providers | yes (trading) | EPHEMERAL feed | dev-feed / seam | Honest mode/health; unconfigured = DELAYED/mock, never faked realtime; reconnect loops. |
| Execution providers | yes | via engine → DB | SIMULATION only | Default Atlas SIMULATION; Rithmic registered as honest seam (UNCONFIGURED without creds). |
| Commerce (Whop) | yes (purchases) | events → DURABLE | seam + mock | Webhook-driven, signature-gated; provisioning only from a verified server event. Fail-closed in prod (Phase 4). |
| KYC / identity | yes (compliance) | DURABLE records | mock/seam | Honest mock; fail-closed in prod. |
| Payout provider | yes (payouts) | DURABLE ops | mock registry | Idempotency-keyed; mock never disburses; fail-closed in prod. |
| Notifications (Resend/Twilio) | optional | DURABLE queue | mock/suppress | No creds → suppress, never fake SENT; retry/backoff worker. |
| Object / certificate storage | yes (certs) | **LOCAL FS only** | **prod gap** | `.artifacts` dir; S3 seam throws NOT_CONFIGURED. Ephemeral across redeploys (see gaps). |
| Logging | yes | EPHEMERAL stdout | prod-ready | Fastify/pino, secret-redacted. |
| Metrics | partial | EPHEMERAL | limited | Per-response `x-atlas-ms`; Rithmic metrics snapshot. No Prometheus/OTel endpoint. |
| Health checks | yes | n/a | **liveness + readiness (Phase 11)** | `/health` liveness+release; `/ready` DB-probing 503; `/version`. Deep checks via owner System Doctor. |

## State classification

- **DURABLE (PostgreSQL):** customer identity, account state, orders, positions, P&L, risk state, payout
  requests/ledger/operations, audit log (hash-chained, append-only), certificates (metadata), kill
  switches, product profile versions, commerce orders/entitlements.
- **RECONSTRUCTABLE (derived from Postgres on restart):** the trading engine's in-memory
  `activeSymbols` index, working-order set, valuation subscriptions — all rebuilt by `engine.start()`
  from durable rows. Bracket/OCO children live on the parent order row (JSON) and are reconstructed.
- **EPHEMERAL (safe to lose):** per-tick price windows, control-flow dedup sets, WebSocket sockets,
  eligibility-wake timers (an optimization; the order itself is durable), logs, in-process metrics.
- **EXTERNAL AUTHORITY:** market price + exchange trading-day boundary (feed `exchangeTs`); a real
  charge (external processor); a real KYC decision; a real payout settlement.

**There is no process-memory-only authoritative business state.** A restart or crash loses no money,
order, position, payout, or audit truth.

## Source of truth (per domain)
- CUSTOMER / IDENTITY / ACCOUNT / ORDER / POSITION / RISK / PAYOUT / AUDIT / CERTIFICATE (metadata) /
  KILL SWITCH / PRODUCT VERSION → **PostgreSQL**.
- MARKET PRICE & trading-day boundary → **market-data provider / exchange feed**.
- SESSION → **stateless JWT** (no server session store).
- Certificate **image/PDF bytes** → local object store today (durable metadata in Postgres; bytes are a
  production gap until provider-backed).

## Deployment model (CURRENT)
Deployable units: the **web** static bundle, the **API server** process (which also runs the in-process
workers + WebSocket gateway + engine), and **database migrations** (`drizzle/`, 35 files, applied by
`src/db/migrate.ts`). `docker-compose.yml` provides local Postgres only. No app Dockerfile / k8s /
Terraform in-repo — intentionally simple (see "no enterprise cosplay", Phase 11 boundary).

## Connection pool
Two postgres.js pools (`db/client.ts`): a query pool (`max:10`, `idle_timeout:20s`) and a dedicated lock
pool (`max:20`) so advisory-lock-held connections never starve queries. Graceful `sql.end({timeout:5})`
on shutdown. ≈30 connections per instance — size DB `max_connections` for N instances.

## Gaps carried into KNOWN_ISSUES
- **HTF-27** — certificate/object storage is local-FS only; not durable across container redeploys or
  shared across instances; S3 provider unimplemented (throws NOT_CONFIGURED). Metadata is safe in
  Postgres; the rendered artifact is not. **Deterministic re-render from metadata + template is the
  mitigation** until provider-backed storage exists.
- **HTF-18** — funded-account inactivity sweep (`runInactivitySweep`) is idempotent but has no runtime
  scheduler; needs an external cron.
- **HTF-26** — payout-ops worker resubmission/retry was defined but not started; **wired in Phase 11**
  (`app.ts`). Periodic stale-reconcile (`reconcileStaleBatch`) is still per-org/cron-driven; webhook
  reconciliation remains the primary path.

## Staging / progression
- **CURRENT:** local + isolated test DBs; runs the Golden Path in simulation.
- **REQUIRED FOR BETA:** a hosted Postgres with automated daily backups; a single API host; the
  inactivity cron bound; object storage decision for certificates.
- **REQUIRED FOR PRODUCTION:** WAL/PITR backups + off-host encrypted storage; real payment/KYC/payout/
  market-data providers wired (Phases C/D/E/H); metrics/tracing endpoint; deploy manifests + rollback.
- **FUTURE SCALE:** multi-instance API (already lock-safe via advisory locks; provider connections are
  leader/singleton — see `THREAT_MODEL`/scaling notes); edge/WAF/DDoS. **Do not** add Kubernetes/mesh/
  Kafka/multi-region before they are genuinely required.
