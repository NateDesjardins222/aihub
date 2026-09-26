# DEPLOYMENT RUNBOOK

**Happy Trader Funding — how to ship a release safely and roll it back.** Phase 11 (2026-09-26).

> Procedure for the current architecture (single API process + web bundle + Postgres migrations). No
> hosting platform is provisioned yet (external gate G12); this is the sequence to follow once one is.

## Components to deploy
1. **Database migrations** (`apps/server/drizzle/`, applied by `db:migrate`) — **first**, backward-compatible.
2. **API server** (Fastify process; runs workers + WebSocket gateway + engine in-process).
3. **Web bundle** (static SPA; `pnpm --filter @atlas/web build`).

## Pre-deploy
- [ ] `git status` clean; on the intended commit; `remote == local`.
- [ ] `pnpm validate:release` passes (prepare seeded DB → typecheck → tests → build).
- [ ] Review pending migrations (`apps/server/drizzle/`): are they **backward-compatible** with the
      currently-running code? (Expand-then-contract: add columns/tables now, drop later.)
- [ ] Confirm provider posture for the target env (real vs mock) and that production fails **closed** for
      any unconfigured real provider (Phase 4).
- [ ] Note the release commit; ensure `GIT_SHA` will be set in the deploy environment.

## Backup (before any migration)
- [ ] Take a fresh `pg_dump -Fc` of the production DB, record its manifest (size, sha256, migration
      count, commit), store encrypted off-host. **Do not proceed without a verified backup.**

## Migrate
- [ ] Run `db:migrate` against production. Drizzle applies only pending migrations and tracks them in
      `__drizzle_migrations`. Watch for failure (see `INCIDENT_RUNBOOK` → migration failure).
- [ ] For a migration that cannot be transactional or is destructive, deploy it in its own expand step
      **before** the code that depends on it, never bundled with a destructive contract.

## Deploy
- [ ] Roll out the API server with `GIT_SHA` set. Graceful shutdown drains the old process (SIGTERM →
      stop accepting, finish in-flight, stop workers, close pools).
- [ ] Deploy the web bundle.

## Post-deploy health
- [ ] `GET /health` → 200, `release.commit` == the deployed commit.
- [ ] `GET /ready` → 200, `checks.database == ok`.
- [ ] Owner System Doctor: DB healthy, migration parity ok, provider posture as intended,
      reconciliation clean.

## Smoke (read-only, safe)
- [ ] Portal loads for a test customer; Owner console loads; account data renders; market-data mode is
      honest (delayed/mock as configured, never faked realtime).

## Reconciliation
- [ ] `reconciliationCenter` open mismatches == 0; `ledger-audit` findings == 0.

## Rollback criteria & procedure
- **Roll back the CODE** (not the DB) when: health/ready fail, smoke fails, error rate spikes, or a
  functional regression appears. Redeploy the previous API build; the web bundle likewise. Because
  migrations are backward-compatible (expand-then-contract), the previous code runs against the new
  schema.
- **Do NOT downgrade the DB** to "undo" a migration if it was destructive — that risks data loss. Prefer
  a forward-fix migration; restore from backup only for genuine data corruption (see `DISASTER_RECOVERY`).
- A payout/financial anomaly is an incident, not a rollback: engage the relevant kill switch
  (`DISABLE_PAYOUT_SUBMISSION` etc.), then diagnose (see `INCIDENT_RUNBOOK`).

## Post-deploy
- [ ] Confirm the deployed release identity is recorded; watch metrics/logs for the first period; keep the
      pre-deploy backup until the release is proven stable.
