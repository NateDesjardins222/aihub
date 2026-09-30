# Operational Incident Runbook

**Operational Readiness Phase 1.** Concise operator procedures for the highest-value
incidents, expressed as **detect → assess scope → contain → reconcile → recover →
verify**. This is the *operational* runbook; it complements and points to the
existing detailed procedures rather than duplicating them:

- `INCIDENT_RUNBOOK.md` — Phase-11 incident categories, SEV scale, kill switches.
- `BACKEND_RECOVERY_RUNBOOK.md` — step-by-step safe recovery for each failure state.
- `FAILURE_RECOVERY_MATRIX.md` — per-flow retry safety (the source of the retry column below).

> Golden rules (unchanged): **protect customer money and truth first; never blindly
> resend a payment whose provider outcome is unknown; never edit PostgreSQL rows by
> hand during a normal incident; detection never auto-repairs.**

## Detect (where signals surface)

| Layer | Command / surface |
|---|---|
| Cheap health | `GET /health` (liveness), `GET /ready` (DB readiness) |
| Operator self-check | `pnpm ops:check` (build, DB, providers, outbox, System Doctor, latest integrity) |
| Deep infra | `GET /api/v1/admin/ops/system/full-test` (doctor + integrity + reconciliation) |
| Deep integrity/reconcile | `pnpm integrity:check` (read-only, exit 0/1/2) |
| One-screen roll-up | `GET /api/v1/admin/command-center` |

## Safe-retry classification (Part XLII — from the Failure Recovery Matrix)

Every recovery action is one of:

- **SAFE TO RETRY** — idempotent; a repeat is a no-op (dedup key / unique index).
- **DO NOT RETRY** — a repeat could double an effect; act on authoritative state only.
- **RECONCILE FIRST** — external outcome unknown; ask the provider before acting.
- **MANUAL REVIEW** — no safe automated action; escalate.

---

## Highest-value incidents

### 1. Database unavailable (DATABASE, CRITICAL)
- **Detect:** `/ready` 503; `ops:check` DB UNREACHABLE; System Doctor `database` CRITICAL.
- **Assess:** liveness `/health` stays 200 — the process is fine; the dependency is not.
- **Contain:** nothing to disable; do **not** restart-loop the app.
- **Recover:** restore Postgres; the pool reconnects on its own. **SAFE TO RETRY** (reads only).
- **Verify:** `/ready` 200; `ops:check` OK.

### 2. Integrity violation (DATA INTEGRITY, CRITICAL)
- **Detect:** `integrity:check` exit 2; `/system/integrity` any FAIL.
- **Assess:** read the detector `key`/`INV_*` + sample entity refs; scope to those entities.
- **Contain:** engage the domain kill switch (e.g. `DISABLE_PAYOUT_SUBMISSION`).
- **Reconcile:** run the matching reconciler for the entity; do **not** auto-repair.
- **Recover:** apply the documented, audited operator action for that invariant. **MANUAL REVIEW.**
- **Verify:** re-run `integrity:check` → clean.

### 3. Failed payout missing reversal (PAYOUT / DATA INTEGRITY, CRITICAL — RES-P2-1)
- **Detect:** `INV_FAILED_PAYOUT_DEBIT_REVERSED` / `FAILED_PAYOUT_DEBIT_NOT_REVERSED` FAIL.
- **Assess:** the specific `payout_requests` row is FAILED with a DEBIT and no REVERSAL.
- **Contain:** `DISABLE_PAYOUT_SUBMISSION`.
- **Recover:** re-run `failPayout(db, requestId)` — it writes the compensating REVERSAL atomically and is idempotent on the unique `(request, REVERSAL)`. **SAFE TO RETRY.**
- **Verify:** balance restored; detector clean.

### 4. Position ≠ execution reconstruction (TRADING / DATA INTEGRITY, CRITICAL)
- **Detect:** `PHANTOM_POSITION` detector; `reconcile.ts` POSITION_* drift.
- **Assess:** the account's stored position disagrees with fold-of-executions.
- **Contain:** `DISABLE_NEW_ORDERS`.
- **Reconcile:** `reconcileAccount(db, accountId)` for the exact drift lines. **RECONCILE FIRST.**
- **Recover:** engine reconstructs authoritative state from Postgres on restart. **MANUAL REVIEW** if drift persists.

### 5. Payout/ledger mismatch (PAYOUT, CRITICAL/WARN)
- **Detect:** `PAYOUT_LEDGER_ARITHMETIC`, `APPROVED_PAYOUT_WITHOUT_DEBIT`; Reconciliation Center mismatch.
- **Assess:** unique `(request, entry_type)` makes double-debit structurally impossible → a mismatch is state/timing, not lost money.
- **Recover:** resolve via reconciliation, never a second manual payment. **DO NOT RETRY** a payment of unknown outcome.

### 6. Outbox stalled (OUTBOX, WARN→ERROR)
- **Detect:** `ops:check`/System Doctor `outbox` DEGRADED (oldest pending > threshold, or dead-letter > 0).
- **Assess:** worker down vs poisoned event (dead-letter count).
- **Recover:** restart the process (worker resumes; SKIP-LOCKED claim); inspect dead-letter rows. **Never delete or fake-ack an event.** **SAFE TO RETRY** (redelivery is idempotent — projection recomputes from authority).
- **Verify:** `outboxHealth` HEALTHY; backlog drains.

### 7. Provider unavailable (PROVIDER, WARN→ERROR)
- **Detect:** System Doctor provider check; `buildInfraHealth` DEGRADED/UNAVAILABLE.
- **Assess:** distinguish **DISABLED/NOT_CONFIGURED** (intended — not an incident) from a *configured* provider that is down.
- **Contain:** for a live customer-facing outage, engage the domain kill switch.
- **Recover:** wait for recovery; payouts stay PAYABLE (owed); market data marks STALE, never fakes live; execution rejects rather than executes uncertainly. **RECONCILE FIRST** for any external side effect (payout/execution).

### 8. Invalid / replayed webhook spike (SECURITY / COMMERCE, WARN)
- **Detect:** `commerce.event_rejected` domain events; `securityEvent` volume.
- **Assess:** invalid signature → rejected (401), recorded, no effect; duplicate → deduped no-op (200).
- **Recover:** none needed structurally; if sustained, treat as a SECURITY incident and investigate source. **SAFE** (verify-before-effect; dedup on `(provider, eventId)`).

### 9. Kill switch engaged (PLATFORM, CRITICAL-visibility)
- **Detect:** `kill_switch.engaged` audit (CRITICAL).
- **Assess:** which chokepoint, who, why (reason is required and audited).
- **Recover:** resolve the underlying incident, then `releaseKillSwitch` with a reason. **MANUAL REVIEW.**
- **Verify:** `listKillSwitches` shows released; the domain resumes.

---

## Operability gaps (what still needs care — see the Phase 1 report)

- Some launch-critical recovery still assumes an operator running a **read-only** CLI
  (`integrity:check`, `ops:check`) plus the documented safe domain actions; there is
  no broad "fix everything" command, by design. Direct SQL **mutation** of money is
  never a normal-incident action.
- No forced-shutdown drain timeout and no outbox worker heartbeat (both P3); a stall
  is inferred from oldest-pending age.
