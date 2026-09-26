# INCIDENT RUNBOOK

**Happy Trader Funding — detect, contain, diagnose, recover, verify.** Phase 11 (2026-09-26).

> Operational guidance, not legal commitment. Golden rule: **protect customer money and truth first;
> never blindly resend an unknown payment; never edit PostgreSQL rows by hand during a normal incident.**

## Incident categories
APPLICATION · DATABASE · REDIS (n/a — unused) · MARKET DATA · EXECUTION · COMMERCE · KYC · PAYOUT ·
SECURITY · DATA INTEGRITY.

## Severity
- **SEV-1** — money at risk or moving wrongly, data loss/corruption, platform down, security breach.
  Examples: payout double-pay suspected, DB corruption, financial-invariant failure, credential leak.
- **SEV-2** — degraded but contained. Examples: market data stale, execution provider down, a stuck job,
  reconciliation mismatch with no customer-visible loss.
- **SEV-3** — minor/cosmetic, no money or data risk.

## Universal loop
Detect (`/ready`, System Doctor, alerts, reports) → **Contain** (kill switch / stop routing) → Diagnose
(logs by correlation id, audit log, reconciliation) → Protect customers → Recover → **Verify** (health +
reconciliation + audit) → communicate internally → post-incident review.

## Kill switches (containment levers — durable, audited, survive restart)
Engage via owner API with a reason; they persist in `kill_switches` and enforce at the server chokepoint
(HTTP 423): `DISABLE_NEW_PURCHASES`, `DISABLE_PROVISIONING`, `DISABLE_NEW_ORDERS`,
`DISABLE_NEW_PAYOUT_REQUESTS`, `DISABLE_PAYOUT_SUBMISSION`, `DISABLE_EXTERNAL_EXECUTION`. Engaging one is
the first containment step for its domain.

---

## DATABASE incident
- **DB down:** `/ready` returns 503 (fail-closed; no fake success). Do not restart the app in a loop —
  liveness stays green. Restore DB connectivity; the app reconnects (pool), no manual app restart needed.
- **Corruption suspected:** engage relevant kill switches; take a fresh backup of the current (suspect)
  state for forensics before anything; decide restore vs forward-fix (see below); after restore, run
  `verifyAuditChain` + `reconciliationCenter` + `ledger-audit` before resuming.
- **When NOT to restore:** a code bug (roll back code instead); a single wrong account (operator
  adjustment with audit trail); to "undo" legitimate recent activity (never).
- **Reconciliation after restore:** must show 0 mismatches / 0 findings before traffic resumes.

## PAYOUT incident
- **Provider unknown/timeout state:** the system reconciles via `getPayout`/webhook and **never
  blind-retries**; HTTP 200 ≠ PAID. If a duplicate is suspected, engage `DISABLE_PAYOUT_SUBMISSION`,
  freeze payout operations, and reconcile the specific request before any further action.
- **Reconciliation mismatch:** investigate the specific `payout_operations` row; the ledger's unique
  `(request, entry_type)` makes a double-debit structurally impossible, so a mismatch is a state/timing
  issue, not lost money. Resolve via reconciliation, not a manual second payment.
- **Never** manually resend a payment whose provider state is unknown.

## TRADING incident
- **Market data stale:** freshness detection marks it stale (Phase 6); Atlas shows it, does not present
  frozen prices as live. No fills are assumed against stale data.
- **Execution unavailable:** orders are rejected/unavailable rather than uncertainly executed; on
  reconnect there is no duplicate replay. Engage `DISABLE_NEW_ORDERS` / `DISABLE_EXTERNAL_EXECUTION` for a
  full halt.
- **Risk engine error / order-state uncertainty:** halt new orders; the engine reconstructs authoritative
  order/position state from Postgres on restart, so a restart is safe.

## COMMERCE / KYC incident
- Provider outage in production **fails closed**: no free account, no fabricated `VERIFIED`. Parked orders
  re-drive when the gate clears; the startup sweep recovers crash-orphaned provisioning.

## SECURITY incident
- Follow `SECURITY_MODEL` / `THREAT_MODEL`: rotate the affected secret (env, no code change), revoke
  sessions if needed (role/status re-read denies revoked access immediately), engage kill switches for the
  affected money path, preserve the audit chain for forensics.

## Recovery (do not flip everything back on)
After clearing an incident, verify in order before releasing each switch: DB healthy (`/ready` 200) →
reconciliation clean → provider posture correct → risk/orders sane → payouts reconciled. Then
release switches one domain at a time, watching health.

## Stuck job
The durable workers (outbox, notification, payout-ops) are idempotent and resume on restart. A job that
appears stuck: check the worker's dead-letter/attempts state and the relevant table; a restart re-claims
`FOR UPDATE SKIP LOCKED` rows. Owner reconciliation surfaces payout ops that need attention.
