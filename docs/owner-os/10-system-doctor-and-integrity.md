# Owner OS — System Doctor, Data Integrity & Reconciliation

Three distinct questions, three distinct tools. None of them ever fakes a green.

Modules: `system-doctor.ts`, `integrity.ts`, `reconciliation-center.ts`
Routes: `/api/v1/admin/ops/system/doctor | /integrity | /reconciliation`

## System Doctor — "is the infrastructure operating?"

`runSystemDoctor(db, org, persist)` checks:

- **database** — connectivity/health.
- **migrations** — verified by presence of latest-schema sentinel tables
  (`kill_switches`, `incidents`, `alerts`, `staff_invitations`,
  `admin_adjustments`), because the drizzle tracker drifted during hand-applied
  migrations and cannot be trusted as the source of truth.
- **Rithmic** — reported **truthfully**: code-installed / configured but **never
  "connected" or "verified" from code alone**. M9 did not complete a live Rithmic
  acceptance, so the doctor distinguishes installed vs configured vs authenticated
  vs verified and never claims more.
- **payout reconciliation**, **provisioning**, **notifications**.

Results persist to `system_check_results` so the console can read back the last
run. Overall status is `HEALTHY` / `WARNING` / `CRITICAL`.

## Data Integrity Center — "does the business data still make sense?"

`runIntegrityChecks(db, org, persist)` runs deterministic invariant checks and
**detects; it never silently repairs** a serious failure:

| Key | Invariant |
|-----|-----------|
| `INV_ACTIVE_ACCOUNTS_PER_IDENTITY` | ≤ 5 active accounts per identity (§78) |
| `INV_PAYOUT_CYCLES` | ≤ 5 PAID payout cycles per account (§78) |
| `INV_PAID_PAYOUT_HAS_DEBIT` | every PAID payout has a ledger DEBIT |
| `INV_NO_DOUBLE_DEBIT` | at most one DEBIT per payout |
| `INV_AUDIT_CHAIN_INTACT` | the hash-chained audit log verifies end to end |

Each check reports status/severity/affected-count/expected/actual/sampleRefs and
persists to `integrity_check_results`. `report.ok` is true only if no check FAILs.

## Reconciliation Center — "do our records match reality?"

`reconciliationCenter(db, org)` aggregates the trading, payout, execution and
commerce reconciliation systems with truthful matched/mismatch/unknown counts and a
total `openMismatches`. It surfaces mismatches for investigation; it does not
auto-correct financial records.

## Full system test

`POST /system/full-test` runs the doctor end to end (requires
`system.doctor.run`). It is a diagnostic, not a destructive test — it never places
real trades, moves real money, or charges a card.
