# PRODUCTION ENVIRONMENT PLAN

**Happy Trader Funding — environments, separation, secrets, and access.** Phase 12 (2026-09-26).
Planning document. No infrastructure is purchased or provisioned here (external gate G12).

## Environments

| Env | DB | Providers | Domain | Secrets | Logging | Data policy |
|---|---|---|---|---|---|---|
| **LOCAL** | local Postgres (`atlas`) | all mock/seam; Rithmic Test only if owner-run | localhost | `.env` (gitignored) | stdout | throwaway; dev seed allowed |
| **TEST/CI** | ephemeral `atlas_test` (migrated+seeded per run) | all mock | none | CI env vars (no prod secrets) | stdout | synthetic only |
| **BETA/STAGING** | managed Postgres (separate instance) | sandbox/test where possible; **fail-closed** for any real provider not yet wired | staging subdomain + TLS | secret manager | shipped, retained | test/invite data; **no real money** unless the beta mode explicitly allows it |
| **PRODUCTION** | managed Postgres + PITR, encrypted, restricted network | real providers, credentialed, fail-closed | primary domain + TLS | secret manager, rotated | shipped + retained + alerting | real customer data; retention per counsel |

## Required production components (owner: INFRASTRUCTURE/NATE)
- **Runtime:** Node 22 / Fastify process; long-lived (holds WebSocket gateway, in-process workers, engine,
  and — when enabled — a singleton Rithmic connection). Needs a host that supports persistent processes
  and WebSockets (not a short-lived serverless function).
- **Database:** managed PostgreSQL 16; automated backups + WAL/PITR; encryption at rest; restricted
  network; monitored; sized for ~30 connections/instance (10 query + 20 lock pool).
- **Object storage:** durable provider-backed store for certificate artifacts (HTF-27); private access
  with signed URLs; versioned/immutable; backed up.
- **Redis:** **not required** (unused today — locks are PG advisory locks, fan-out is LISTEN/NOTIFY). Only
  introduce if a future multi-instance need is proven.
- **Secrets:** a secret manager or platform env injection; rotation; access audit; never in repo, CI logs,
  test DB, or the browser bundle (Phase 10 verified 0 secrets in the web bundle).
- **Observability:** ship structured logs; wire an alert-delivery channel (email/SMS/incident tool) to the
  conditions in `OBSERVABILITY.md`; expose release identity (`/version`) and readiness (`/ready`).
- **Deploy:** repeatable deploy + rollback (`DEPLOYMENT_RUNBOOK.md`); migrations expand-then-contract;
  `GIT_SHA` set so `/version` reports the build.

## Environment separation (hard rules)
- No production credentials in the local repo, the test DB, CI logs, or the browser bundle.
- Production fails **closed** for any unconfigured real provider (never a mock) — proven Phase 4/11.
- Staging must never point at the production DB; production must never point at a dev/test DB.
- The canonical dev database (`atlas`) and any production DB are never dropped by a drill; recovery drills
  use an isolated recovery DB only (`DISASTER_RECOVERY.md`).

## Owner access plan (owner: NATE)
- Individual named accounts (no shared admin login); least privilege by role
  (SUPPORT < ADMIN < SUPER_ADMIN); MFA on owner/admin (see PART 20-21 / G6).
- Production first-owner bootstrap is NOT the dev seed and NOT a universal password (procedure below).
- Revocation is immediate: `requireRole` re-reads role+status from the DB (Phase 10), so a disabled
  operator is denied even with a valid token.
- Every privileged mutation is audited with a required reason.

## Production owner bootstrap (procedure — owner: NATE + CLAUDE to build)
1. A one-time, non-seed bootstrap (env-gated invite or CLI that creates the first SUPER_ADMIN with a
   strong operator-set password + enrolled MFA), then disabled. **Not yet implemented — G6 gap.**
2. First owner enrolls MFA immediately; sets a recovery method.
3. Additional staff are invited through Owner OS staff management (exists) with least-privilege roles.
4. Revocation and re-invitation are through Owner OS, audited.

## Business-continuity note (PART 84)
Production must not depend on any single laptop, `C:\Users\...\aihub`, a local Postgres, a local
certificate directory, a local `.env`, or a Claude session. Every such dependency is a launch blocker for
real money and is tracked in `EXTERNAL_DEPENDENCIES.md` / the Claude-dependency audit (`PRE_LAUNCH_REVIEW.md`).
