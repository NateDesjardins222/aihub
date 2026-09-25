# 12 — Integrity checks & System Doctor

Support's guarantees are not only enforced at write time — they are continuously
verified. Data-integrity checks assert the money-safety and resolution invariants
against the stored data, and System Doctor probes the live support surface. Both
report the truth; nothing is faked green.

## Data-integrity invariants (`integrity.ts`)

### `INV_REMEDIATION_FOUR_EYES` (CRITICAL)

The money-safety invariant of support: **every executed remediation went through
four-eyes.** The check selects `support_remediations` in status `EXECUTED` or
`EXECUTING` where `approved_by_user_id is null` **or**
`approved_by_user_id = requested_by_user_id`. Any such row is a breach:

- pass → status `PASS`, severity `INFO`, "four-eyes upheld";
- fail → status `FAIL`, severity `CRITICAL`, "`<n>` remediation(s) breach
  four-eyes", with sample ids.

Because approval and execution are already guarded at write time (doc 07), this
check should always pass; if it ever fails, it means money moved without an
independent approver, which is a critical finding.

### `INV_RESOLVED_TICKET_HAS_SUMMARY` (WARNING)

**Every resolved/closed ticket carries a customer-facing resolution summary.** The
check selects tickets in status `RESOLVED`/`CLOSED` whose
`resolution_summary_customer` is null or blank:

- pass → `PASS` / `INFO`;
- fail → `WARN` / `WARNING`, "`<n>` resolved ticket(s) without a summary", with
  sample ids.

This backstops the write-time requirement in `resolveTicket` (which rejects an
empty summary) and catches any ticket that reached a terminal state through another
path without one.

Both checks run as part of `runIntegrityChecks` and persist their results.

## System Doctor probes (`system-doctor.ts`)

### `support` — API reachability + SLA pressure

`checkSupport` queries the open-ticket set (proving the support surface is live and
the table is reachable) and counts how many are past SLA using the same pure
`slaState` function as the inbox:

- reachable, no breaches → `HEALTHY` / `INFO`;
- reachable with breaches → `WARNING` (never faked green), reporting
  `<open> open ticket(s), <breached> past SLA`;
- query error → `CRITICAL` "unreachable".

The active-ticket scan is bounded (limit 5000) to stay cheap.

### `support_storage` — attachment backend

`checkSupportStorage` reports the live attachment backend truthfully via
`supportStorageStatus()`: the provider name and whether it is a configured object
store or the in-process default. It never pretends a real store is present when it
is not.

### Migration-parity sentinel

The migration-parity sentinel list includes the support tables `support_tickets`
and `support_remediations`, so System Doctor's schema-drift check verifies those
tables exist as expected alongside the other core tables.
