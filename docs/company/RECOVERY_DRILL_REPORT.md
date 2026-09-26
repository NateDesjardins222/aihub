# RECOVERY DRILL REPORT

**Happy Trader Funding — Phase 11 disaster-recovery drill. Executed, not described.**

Date: 2026-09-26 · Branch `claude/futures-trading-simulator-v8qefu` · Source commit `52484e5`.

> This is an **internal, local** drill on an **isolated recovery database**. It is real evidence that
> the backup→drop→restore path preserves financial and audit truth — it is **not** a production DR
> guarantee (no production hosting/DB exists yet; see `LAUNCH_GATES.md` G12). No real money, no
> production data, no secrets. The canonical development database (`atlas`) was never touched.

## What was drilled

The full backup → integrity-check → **destroy** → restore → verify cycle on a dedicated database
(`atlas_p11_src`) seeded with meaningful Happy Trader data through the **real domain** (no hand-written
rows): the canonical catalog, a practice/evaluation/funded/daily-funded account set, customer
identities, product profile versions, a pending payout request, and three rendered certificates, with a
hash-chained audit log.

## Evidence

### 1. Source dataset (pre-backup snapshot)
Deterministic counts + content checksums captured from `atlas_p11_src`:

| Metric | Value |
|---|---|
| users | 3 |
| organizations | 1 |
| accounts | 4 |
| account_profiles / versions | 21 / 22 |
| customer_identities | 2 |
| payout_requests | 1 |
| certificates | 3 |
| audit_log | 9 |
| SUM(account.balanceMicros) | 354,000,000,000 (= $354,000) |
| CHK accounts (md5) | `06f4c44b308cb1cd0642b8fdda8f2fee` |
| CHK audit_log (md5, ordered by createdAt,id) | `3e3c2640fb41779425905c3453c22c0a` |
| CHK certificates (md5) | `3dae12bb776a7e8b6d0d4ee154bf0965` |

Audit chain verified in source before backup: **ok=true, checked=9, brokenAt=none**.

### 2. Backup (manifest)
| Field | Value |
|---|---|
| database_name | atlas_p11_src |
| backup_format | PostgreSQL custom (`pg_dump -Fc`, compressed) |
| size_bytes | 471,384 |
| sha256 | `31820cdff9a0fc7f293afd209797df14f379a98fb1358ff02fc64c620a8f0521` |
| migrations_applied | 35 |
| source_commit | `52484e5` |
| pg_version | 16.13 |
| contains_secrets | NO |

### 3. Backup integrity (PART 36)
- `pg_restore --list` reads the archive TOC cleanly: **ARCHIVE VALID** (136 TOC entries, TABLE DATA present).
- Negative control: a truncated copy of the archive was **rejected** by `pg_restore --list` — a corrupt
  backup is detected, never silently trusted.

### 4. Destruction (PART 27)
`DROP DATABASE atlas_p11_src` executed; `pg_database` count for the name = **0** (proven gone). Only the
isolated recovery DB was dropped.

### 5. Restore (PART 28) — no manual row repair
Created a clean empty `atlas_p11_restored`; `pg_restore --no-owner --no-privileges` from the dump.
**Restore wall-clock: 1,288 ms.**

### 6. Restore integrity (PART 29/33) — deterministic diff
Re-ran the identical snapshot query on `atlas_p11_restored` and diffed against the pre-backup snapshot:
**SNAPSHOT IDENTICAL** — every count and every content checksum (accounts, audit_log, certificates)
matched exactly. `SUM(account.balanceMicros)` = $354,000, unchanged.

### 7. Audit survives restore (PART 32)
`verifyAuditChain` on the restored DB: **ok=true, checked=9, brokenAt=none** — the hash chain values
survived byte-for-byte and re-verify against their own linkage.

### 8. Financial reconciliation after restore (PART 30) — $0 delta
- `reconciliationCenter`: **openMismatches = 0** across TRADING_PROVIDER / PAYOUT_PROVIDER / EXECUTION /
  COMMERCE_PROVISIONING.
- `ledger-audit.auditLedgers`: **0 findings** (no orphan account, no PAID-without-debit, no
  debit-without-payout, no account missing a product version).
- **UNEXPLAINED DELTA introduced by backup/restore: $0.00.**

## RPO / RTO

- **RPO (Recovery Point Objective).** Target: ≤ 24h for beta (daily automated `pg_dump`), tightening to
  ≤ 5 min with WAL archiving / PITR before real money. **Proven in this drill: point-in-time** — the
  restore reproduced the exact state captured at backup with zero loss. The *window* of potential loss
  in production is whatever the backup cadence is; with only a daily dump, up to ~24h of writes could be
  lost, so PITR is required before real funds. **Honest gap:** no automated backup schedule or WAL
  archiving is configured yet (external infra gate G12).
- **RTO (Recovery Time Objective).** Target: ≤ 1h for beta. **Observed locally:** restore itself 1.3 s
  on a 471 KB dataset; a full drill (recreate DB + migrate baseline optional + restore + verify) ran in
  well under a minute. This is a **local laptop** figure on a tiny dataset — it is **not** a production
  guarantee; real RTO scales with dataset size, network, and provisioning of a fresh DB host.

## Security of backups (PART 37)
A backup contains sensitive customer/business data. Requirements (documented, not yet enforced by infra):
encrypted at rest, access-controlled, **never committed to Git**, never left in a public bucket. The
drill's dump file lives only in the session scratchpad and is **not** committed (verified in the Git
review). The manifest records a checksum but no secret values.

## Verdict
Backup created ✓ · integrity verified + corruption detected ✓ · isolated DB destroyed ✓ · restored ✓ ·
customer/account/identity/certificate/audit data survived byte-identical ✓ · audit chain re-verifies ✓ ·
financial reconciliation $0 unexplained delta ✓. **Internal disaster recovery is PROVEN.** Production DR
(automated scheduled backups, WAL/PITR, off-host encrypted storage, restore-to-fresh-host timing) remains
an external infrastructure gate (G12).
