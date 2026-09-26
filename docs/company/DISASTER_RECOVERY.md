# DISASTER RECOVERY

**Happy Trader Funding — how to not lose the business.** Phase 11 (2026-09-26).

> Internal recovery procedure, proven locally (`RECOVERY_DRILL_REPORT.md`). Production DR depends on
> hosting/backup infrastructure that is an external gate (G12). No step here requires editing PostgreSQL
> rows by hand during a normal incident.

## Data sources & what protects them
| Data | Store | Protection |
|---|---|---|
| All business truth (customers, accounts, orders, positions, payouts, ledger, audit, certs metadata, kill switches, product versions) | **PostgreSQL** | pg_dump backup + restore (proven); append-only hash-chained audit; advisory-lock serialization |
| Certificate/attachment **artifact bytes** | local object store (`.artifacts`) | **GAP (HTF-27):** not covered by the DB backup; re-renderable from metadata + template |
| Secrets (JWT, provider creds) | environment | not in DB, not in backup; managed by the deploy platform |
| Market data | provider (external authority) | reconstructed on reconnect; never authoritative in our DB |

## Backup strategy (recommended)
- **Method:** `pg_dump -Fc` (custom, compressed) for logical backups; add **WAL archiving / PITR** before
  real money for a tight RPO.
- **Frequency:** at least daily for beta; continuous WAL for production.
- **Retention:** ≥ 30 days daily + monthly for a year (tighten with compliance later).
- **Encryption:** at rest, always. Backups contain sensitive customer data.
- **Storage:** off-host, access-controlled bucket. **Never** committed to Git; never public.
- **Verification:** a backup is not trusted until a **restore drill** succeeds (see cadence below).

## Restore procedure (proven)
1. Provision a clean empty database (never restore over a live one).
2. `pg_restore --no-owner --no-privileges -d <newdb> <dump>`.
3. Verify integrity: row counts + content checksums vs the manifest; `verifyAuditChain` per org
   (expect ok=true); `reconciliationCenter` + `ledger-audit` (expect 0 mismatches / 0 findings).
4. Point the application at the restored DB; smoke the Golden Path read paths (Portal, Owner, account).
5. Only then cut traffic over.

**Proven in drill:** restore reproduced the source byte-identical (all checksums matched), audit
re-verified, financial reconciliation had **$0 unexplained delta**, in ~1.3 s for the test dataset.

## Backup integrity & corruption
`pg_restore --list` must read the archive TOC before a backup is trusted; a truncated/corrupt archive is
rejected (proven with a negative control). A backup job reporting "completed" is **insufficient** — only
a periodic restore drill proves recoverability.

## RPO / RTO
- **RPO:** target ≤ 24h (beta, daily dump) → ≤ 5 min (production, WAL/PITR). Proven point-in-time in the
  drill; the production window is the backup cadence — **daily-only means up to ~24h of writes at risk**,
  so PITR is required before real funds.
- **RTO:** target ≤ 1h (beta). Local restore 1.3 s on a tiny dataset — not a production guarantee;
  real RTO scales with dataset size + host provisioning.

## When NOT to restore
- If only the **application** is broken (bad release), roll the **code** back — do **not** restore the DB
  (see `DEPLOYMENT_RUNBOOK.md` rollback). A restore is for **data loss/corruption**, not code bugs.
- If a single account looks wrong, it is an **operator correction with an audit trail** (admin
  adjustment), never a full-DB restore.
- Never restore an older snapshot to "undo" recent legitimate activity — that would silently roll back
  real customer state and break the audit chain's continuity with reality.

## Object storage recovery (HTF-27)
Certificate artifact bytes are local-FS today and not in the DB backup. Until provider-backed storage
exists: the certificate **metadata** (in Postgres) plus the deterministic renderer + pinned template
version can **re-render** the artifact. Treat lost artifact files as re-renderable, not as lost records.

## Drill cadence (recommended)
Run a full backup→drop→restore→verify drill on an **isolated** DB **monthly** (quarterly at minimum),
recording a fresh `RECOVERY_DRILL_REPORT`. Never drill against the canonical dev or a production DB.
