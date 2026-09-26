# RELEASE CHECKLIST

**Happy Trader Funding — the gate every release passes.** Phase 11 (2026-09-26).

Run top to bottom. The single command that covers 2–5 is `pnpm validate:release`.

## Source
- [ ] `git status` clean; on the intended branch; `remote == local`.
- [ ] Changelog / commit message describes the change; no secrets, no `.env`, no DB dumps staged.

## Validation (`pnpm validate:release`)
- [ ] **Test DB prepared** — isolated, migrated from zero, seeded (`scripts/prepare-test-db.sh`). Never
      the canonical dev DB.
- [ ] **Typecheck** — `pnpm -r typecheck` clean.
- [ ] **Tests** — `pnpm test` from the **repo root** (root vitest config: `.test.ts` only so compiled
      `dist` is never collected; `fileParallelism:false` so DB-sharing suites serialize). Report the
      aggregate honestly — no "N failed but explainable".
- [ ] **Build** — `pnpm build` (packages + server) and `pnpm --filter @atlas/web build`.

## Migrations
- [ ] Pending migrations reviewed; ordered; backward-compatible (expand-then-contract); destructive steps
      isolated and sequenced after their expand.

## Safety / providers
- [ ] Production fails **closed** for any unconfigured real provider (commerce/KYC/payout) — no mock in
      prod (Phase 4).
- [ ] Dev/mock routes not registered in production; `/design-lab` inert in the prod web build (Phase 10).
- [ ] Secret scan: no secret committed; `.env` gitignored; no Rithmic password anywhere.

## Security & known issues
- [ ] Review `SECURITY_MODEL` / `THREAT_MODEL` for anything the change touches.
- [ ] Review `KNOWN_ISSUES` open P0/P1; none newly introduced.

## Backup readiness
- [ ] A verified, restorable backup path exists for the target DB (drill on record; see
      `RECOVERY_DRILL_REPORT`).

## Release
- [ ] Tag/record the release commit; ensure `GIT_SHA` is set in the deploy environment so `/version`
      reports it.
- [ ] Follow `DEPLOYMENT_RUNBOOK` (backup → migrate → deploy → health → smoke → reconcile).
