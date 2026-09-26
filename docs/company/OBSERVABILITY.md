# OBSERVABILITY

**Happy Trader Funding — how an operator sees what is happening and what is wrong.** Phase 11 (2026-09-26).

## Health surface (Phase 11)
| Endpoint | Meaning | Checks | Status codes |
|---|---|---|---|
| `GET /health` | **Liveness** — is the process up? | process only + release identity | always 200 while alive |
| `GET /ready` | **Readiness** — can it serve? | **PostgreSQL `select 1`** (+ latency ms) | 200 ready / **503 not ready** |
| `GET /version` | Deployed build | release identity | 200 |

**No fake green:** `/ready` returns **503** when Postgres is unreachable, so a load balancer stops
routing to a server that cannot read/write business truth — even though `/health` (liveness) stays 200
so an orchestrator does not restart-loop a process over a transient DB blip. Liveness must **not** probe
optional providers: a down market-data feed should never restart the app.

## Release identity
`/health.release` and `/version` expose `{ commit, label, startedAt }`. The deploy pipeline sets
`GIT_SHA` (or `RELEASE_SHA`/`SOURCE_COMMIT`); unset → `dev`. Non-secret. An incident can now be tied to
an exact build (closes the Phase 11 "release identity not knowable" gap).

## Deep health (Owner console — authenticated)
Beyond the shallow HTTP probes, the **Owner System Doctor** (`runSystemDoctor`) and infra health
(`buildInfraHealth`) surface component-specific state, never a blanket green:
- **Database** — round-trip probe + schema/migration parity (sentinel tables).
- **Market data / execution** — provider mode + honest status (REAL / MOCK / DELAYED / UNCONFIGURED /
  NOT_VERIFIED); staleness is detectable (Phase 6 freshness), a frozen feed is not shown as live.
- **Payout reconciliation** — freshness + mismatch count.
- **Commerce / provisioning** — paid-but-unprovisioned queue, exception counts.
- **Notifications / KYC / payout / attachment storage** — configured vs mock vs suppressed.
- **Reconciliation center** — per-system matched/mismatch/unknown + open mismatch total.

Owner can answer, without a terminal: is the platform up, is the DB healthy, is market data / execution
/ payouts healthy, are reconciliations clean, what release is deployed.

## Logging
Structured (Fastify/pino), **secret-redacted** (`app.ts` log redaction). Level is `info` in production,
`warn` in dev. Recommended fields for production shipping: timestamp, level, service, environment,
**release commit**, request/correlation id, and — where safe — customer/account id, provider, error code.
**Never** log secrets, passwords, tokens, or the Rithmic password.

## Correlation
One incident is traceable across HTTP → domain action → provider op → financial event → audit, reusing
existing ids (request id, account id, payout request id, audit subject id, `commerce_events` id). The
audit log is the durable spine that ties an action to its actor and its effect.

## Error levels
DEBUG (dev detail) · INFO (normal lifecycle) · WARN (recoverable/degraded, e.g. provider unconfigured) ·
ERROR (genuine 5xx / invariant failure). A customer validation error (400) is **not** logged as a
catastrophic incident — the typed error handler returns `VALIDATION_FAILED`/`MALFORMED_JSON` without a
5xx.

## Metrics (current + recommended)
- **Present:** per-response server timing (`x-atlas-ms`), Rithmic metrics snapshot, per-response duration.
- **Recommended for production** (no vendor purchased yet): HTTP error rate + latency, DB availability +
  pool pressure, provider connectivity, order reject/error rate, payout processing failures,
  reconciliation mismatch count, job failure/stuck count, WebSocket connection count.
- **Business-safety signals (highest value):** duplicate-settlement attempt, financial-invariant failure,
  unknown payout state, account-state-transition failure, provider staleness, risk-engine error. Trader
  profitability is **not** a reliability metric.

## Alerts (conditions to wire when a channel exists)
CRITICAL: API down, DB down/unreachable (`/ready` 503), financial-invariant failure, payout
reconciliation mismatch, backup failure, migration failure. WARNING: provider unavailable, market data
stale, execution unavailable, job stuck, Redis (n/a — unused). INFO: routine job completion. Do **not**
alert on ordinary customer validation errors.

## Gaps (KNOWN_ISSUES)
- **HTF-19 / HTF-10** — no metrics/tracing export endpoint yet; safety-control mutations are API-operable
  but not all surfaced as console buttons. `/ready` + release identity + System Doctor now cover the
  detect-and-decide baseline for beta.
