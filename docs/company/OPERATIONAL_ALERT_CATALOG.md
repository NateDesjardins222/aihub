# Operational Alert Catalog

**Operational Readiness Phase 1.** The alerts a future monitoring provider *should*
deliver — defined now, against provider-neutral signals that already exist, so that
when a real alerting stack is connected there is a specification to wire it to. **No
paid monitoring product is integrated by this phase.** These are the signals; the
delivery mechanism is future work.

Every alert is defined by: **signal source · operational severity · why it matters ·
operator first action · page?** The first-action column points at the runbook
(`OPERATIONAL_INCIDENT_RUNBOOK.md`, `BACKEND_RECOVERY_RUNBOOK.md`,
`FAILURE_RECOVERY_MATRIX.md`) rather than repeating it.

> Anti-fatigue principle (Part XLIV): if firing it would not justify waking a human,
> it is a **dashboard/log/metric** signal, not a page. Ordinary customer errors,
> normal risk/order rejections, single expected payout ineligibilities, and
> intentionally-unconfigured providers are **never** alerts.

---

## Page-worthy (CRITICAL → wake someone)

| Alert | Signal source | Sev | Why it matters | Operator first action |
|---|---|---|---|---|
| **Database unavailable** | `/ready` 503; System Doctor `database` CRITICAL | CRITICAL | No authoritative reads/writes; platform effectively down. | Restore DB connectivity; app reconnects (pool). Do **not** restart-loop — liveness stays green. |
| **Integrity violation** | `integrity:check` exit 2; `/system/integrity` any FAIL; `INV_*`/detector CRITICAL | CRITICAL | Authoritative data may be wrong (over-cap, >5 cycles, duplicate successor, phantom position, ledger arithmetic). | Contain (kill switch for the domain); investigate the specific entity; **never** auto-repair. |
| **Failed payout missing reversal** | `INV_FAILED_PAYOUT_DEBIT_REVERSED` / `FAILED_PAYOUT_DEBIT_NOT_REVERSED` FAIL | CRITICAL | Money debited and not returned (RES-P2-1 class). | Engage `DISABLE_PAYOUT_SUBMISSION`; re-run `failPayout` (idempotent) to restore balance; verify ledger REVERSAL. |
| **Duplicate business effect detected** | `INV_NO_DOUBLE_DEBIT`, `DUPLICATE_FUNDED_SUCCESSOR`, `DUPLICATE_RESET_SUCCESSOR` FAIL | CRITICAL | A structural guard was bypassed — possible double-pay / double-account. | Freeze the domain; reconcile the specific rows before any action. |
| **Suspected DB corruption** | audit chain verify FAIL (`INV_AUDIT_CHAIN_INTACT`); reconciliation mismatch cluster | CRITICAL | Tamper or corruption of authoritative history. | Take a forensic backup first; decide restore vs forward-fix; reconcile to 0 before resuming. |
| **Kill switch engaged** | `kill_switch.engaged` audit (CRITICAL) | CRITICAL | A money/lifecycle chokepoint is halted — intended, but everyone must know. | Confirm who/why; track the incident; plan release. |
| **Security: privileged brute-force** | `securityEvent=rate_limit_blocked` sustained on `/admin/*` or auth; `securityEvent=authz_denied` burst | ERROR→CRITICAL | Repeated attempts to breach auth/authz or the step-up gate. | Investigate source; confirm rate-limit holding; consider IP block upstream. |

## Actionable but not page-worthy (WARN/ERROR → dashboard, page only if sustained)

| Alert | Signal source | Sev | Why it matters | Operator first action |
|---|---|---|---|---|
| **Outbox stalled** | `outboxHealth` DEGRADED; System Doctor `outbox` WARNING (oldest pending > threshold or dead-letter > 0) | WARN→ERROR | Projections/downstream effects silently delayed; a dead-letter is a poisoned event. | Check the worker is running; inspect dead-letter rows; **never** delete or fake-ack an event. |
| **Provider unavailable** | System Doctor provider check; `buildInfraHealth` health DEGRADED/UNAVAILABLE | WARN→ERROR | A real dependency (market data, execution, payout rail) is down — but a *configured* one. | Confirm it is not intentional DISABLED; engage the domain kill switch if customer-facing. |
| **Reconciliation mismatch** | Reconciliation Center `mismatch > 0`; `/system/reconciliation` | WARN | State/timing divergence (not necessarily lost money). | Investigate the specific account/payout; resolve via reconciliation, not manual SQL. |
| **Migration/schema mismatch** | System Doctor `migrations` WARNING/CRITICAL | ERROR | Code and schema disagree — deploy hazard. | Verify migrations applied; roll code or apply migration. |
| **Unexpected worker death** | (future heartbeat) / outbox age climbing with worker down | WARN→ERROR | Background work not progressing. | Restart the process; sweeps re-drive from DB truth on boot. |
| **Payout provider DOWN** | payout `ProviderHealth.state=DOWN`; exception `PROVIDER_UNAVAILABLE` | WARN | Payouts stay PAYABLE (owed), not failed — safe, but delayed. | Wait for recovery; the durable worker resumes; never blind-retry. |
| **Reconciliation never ran (EMPTY)** | Reconciliation Center `EMPTY` | INFO→WARN | A reconciler has produced no data — blind spot. | Schedule/kick the reconciler; confirm it runs. |

## Explicitly NOT alerts (log/metric only)

- Ordinary login failure or 401 (unauthenticated). — normal traffic.
- Normal risk rejection / kill-switch 423 on a customer action. — the rule *working*.
- A single order rejection or a single expected payout ineligibility. — expected.
- A provider intentionally NOT_CONFIGURED / DISABLED (payout rail, S3, email/SMS
  seams). — DISABLED is not broken.
- Validation errors (400). — customer mistakes.

## Incident classification (for grouping alerts into a worked situation)

`TRADING · RISK · PAYOUT · COMMERCE · IDENTITY · SECURITY · DATA INTEGRITY ·
PROVIDER · DATABASE · OUTBOX · PLATFORM` (aligned with `incidents.ts` +
`INCIDENT_RUNBOOK.md`). One incident per correlated situation (deduped on a stable
key), not one per alert instance.
