# Atlas — production backup & restore requirements

What must be backed up, how often, and how a restore is validated. Atlas is
**deployment-agnostic** — this states *requirements*, not a cloud provider or a
product. PostgreSQL is the **only source of financial truth**; everything else
is either rebuildable from it or a client convenience.

## The one thing that must never be lost: PostgreSQL

The entire financial and commercial state lives in one PostgreSQL database.
Losing it is unrecoverable; losing anything else is not. Back it up accordingly.

### Authoritative tables (irreplaceable — a loss is real data loss)

- **Identity & tenancy** — `organizations`, `users`, `refresh_tokens`.
- **Accounts & authority** — `accounts`, `account_lifecycles`,
  `account_profiles`, `account_profile_versions`, `account_profile_drafts`,
  `rule_templates`.
- **Execution truth** — `orders`, `executions`, `positions`, `trades`,
  `daily_account_stats`, `practice_sessions`.
- **Commerce** — `commercial_orders`, `entitlements`, `account_qualifications`.
- **Operations & history** — `trader_notes`, `risk_events`, `account_events`,
  `provisioning_requests`, `provisioning_keys`.
- **Audit (append-only, hash-chained)** — `audit_log`, `domain_events`. These
  are integrity-critical: the chain proves the history was not altered, so a
  backup must preserve rows exactly (never rewrite or prune mid-chain).
- **Client-owned** — `layouts`, `chart_states`, `drawings`, `chart_indicators`,
  `user_preferences`, `user_drawings`, `trade_tags`, `trade_tag_links`,
  `session_tag_links`. Not financial, but user work; back up with the rest.

### Rebuildable (recoverable without backup, but back up anyway to shorten RTO)

- `account_projections` — the operational read model. Rebuildable from
  authoritative state via `reconcileAll` / `rebuildAllProjections`; if a restore
  brings it back stale, rebuild it rather than trusting it.
- `outbox_events` — in-flight delivery to the projection. The consumer is
  idempotent, so replay after restore is safe; undelivered rows re-drain.
- `historical_bars`, `market_data_meta` — a cache of market data; refetchable
  from the provider.

## Backup requirements

| Requirement | Target |
| --- | --- |
| Method | PostgreSQL physical (base backup + WAL archiving / PITR) **or** logical (`pg_dump`) — PITR preferred so a point just before an incident is recoverable |
| Full backup cadence | at least daily |
| Continuous WAL archiving | enabled (for PITR) if physical |
| Retention | ≥ 30 days rolling, plus longer-lived periodic snapshots per the firm's record-keeping needs |
| Encryption | backups encrypted at rest and in transit |
| Off-host / off-region copy | at least one copy isolated from the primary's failure domain |
| Access | restore credentials held separately from the running app's `DATABASE_URL` |

Recovery objectives to decide and document per deployment: **RPO** (max
acceptable data loss — with WAL archiving, minutes) and **RTO** (max acceptable
downtime).

## Restore procedure (and its validation)

1. Provision a fresh PostgreSQL instance; restore the latest base backup, then
   replay WAL to the chosen recovery point (PITR).
2. Point a **non-production** Atlas at the restored DB (`DATABASE_URL`).
3. Run the migration check — the schema version must match the app
   (`meta/_journal.json` / applied migrations).
4. **Verify audit-chain integrity** — run the audit chain verification
   (`verifyAuditChain`). A broken chain means the restore is corrupt or
   tampered; do not promote it.
5. **Rebuild the read model** — run `rebuildAllProjections` and confirm the
   system health check reports projections consistent (inconsistent = 0) and the
   outbox drained.
6. Spot-check authoritative balances/positions for a sample of accounts against
   the last known-good figures.
7. Only then repoint production.

## What is NOT backed up here (by design)

- **Secrets** — `JWT_SECRET`, `DATABASE_URL`, and the paused Whop/Databento keys
  live in the secret manager, backed up by that system's own policy, never in a
  DB dump or this repo. Rotating `JWT_SECRET` invalidates live access tokens;
  refresh tokens are DB-backed and survive a restore.
- **The ephemeral container** — the app is stateless; redeploy from source.
- **Rebuildable caches** — see above; restore-then-rebuild, don't depend on them.

## Restore drills

A backup unverified by a restore is a hope, not a backup. Perform a full
restore-and-validate drill on a schedule (at least quarterly), timing it against
the documented RTO and confirming steps 4–6 pass.
