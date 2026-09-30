# Operational Signal Model

**Operational Readiness Phase 1.** A small, authoritative taxonomy so operational
truth is not dumped into one undifferentiated log stream. It defines the *kinds* of
operational signal, their *severity*, and how they map to the error taxonomy the
resilience and security phases already established.

> Governing rule (Part LX): **observability is never authoritative business state.**
> A metric, log line, health status, or alert is a *view* of the truth in Postgres
> — it never *is* the truth, and nothing in this model may be written to as if it
> were. Money and lifecycle authority live in the database, always.

---

## 1. Signal kinds

These are **not** interchangeable. A payout that failed is an *event*; a position
that disagrees with its execution reconstruction is an *integrity violation*. They
demand different responses and must not be collapsed.

| Kind | Question it answers | Where it lives | Example |
|---|---|---|---|
| **HEALTH** | Is this component able to do its job right now? | `/health`, `/ready`, System Doctor, `outboxHealth`, provider snapshot | "database unavailable"; "outbox worker stalled" |
| **EVENT** | Something happened in the business. | `domain_events` (`platform/events.ts`) | "payout failed"; "account funded" |
| **METRIC / COUNTER** | How much / how often, in bounded aggregate? | `rithmic/metrics.ts`, `payout-ops-metrics.ts` | "orders rejected in last minute"; payout SLA P95 |
| **AUDIT** | Who did what, provably, in order? | `audit_log` (hash chain, `platform/audit.ts`) | "operator engaged a kill switch" |
| **INTEGRITY VIOLATION** | Does authoritative data still make sense? | `integrity.ts` / `resilience/integrity-checks.ts` | "position ≠ execution reconstruction"; "failed payout not reversed" |
| **SECURITY EVENT** | A security-relevant operational condition. | `securityEvent` structured log; SECURITY stream (`ops-events.ts`) | "privileged endpoint denied"; "rate-limit blocked"; "invalid webhook signature" |
| **INCIDENT** | A correlated situation a human is working. | `incidents` (`platform/incidents.ts`) | "provider outage affecting trading" |

An **INTEGRITY VIOLATION** is the most serious kind: it means the database itself
may be wrong. It is always machine-readable (a category + affected entity refs) and
never auto-repaired — detection only.

## 2. Operational severity (independent from engineering bug severity)

Operational severity describes *what is at risk now*, not how hard a bug is to fix.

| Severity | Meaning | Examples | Paging? |
|---|---|---|---|
| **INFO** | Expected operational event. | account funded; provider intentionally NOT_CONFIGURED; normal risk rejection | No |
| **WARN** | Degraded/unusual but the system is still safe. | market data stale; outbox backlog aging; one provider DEGRADED; reconciliation EMPTY | Dashboard/log — page only if sustained |
| **ERROR** | An operation failed or a component is unavailable. | DB unreachable on a request; payout provider DOWN; a job failed | Page if customer-facing or money-blocking |
| **CRITICAL** | Authoritative correctness, money, security, or broad availability is at *immediate* risk. | integrity violation; failed payout missing reversal; DB down; suspected double-pay; credential leak | **Page immediately** |

Anti-fatigue rules (Part III / XLIV): a customer's ordinary validation error is
**never** ERROR; a normal risk/order rejection is **never** an application failure;
an intentionally-unconfigured future provider is **INFO (DISABLED)**, never CRITICAL.

This maps onto the incident runbook's SEV scale: **CRITICAL ≈ SEV-1**,
**ERROR/WARN ≈ SEV-2**, **INFO ≈ SEV-3/none**.

## 3. Error taxonomy (reused, not reinvented)

Operational logging distinguishes these classes so customer mistakes do not pollute
the operational error signal. The classes already exist across the codebase (central
`ApiError` envelope + per-domain codes); this is the operational reading of them:

| Class | Operational severity | HTTP | Counts as an operational error? |
|---|---|---|---|
| VALIDATION | INFO | 400 | No — customer mistake |
| AUTHENTICATION | INFO | 401 | No — ordinary unauthenticated traffic |
| AUTHORIZATION | SECURITY EVENT | 403 | Signalled (privilege-escalation breadcrumb) |
| RATE LIMITED | SECURITY EVENT | 429 | Signalled (abuse/brute-force breadcrumb) |
| CONFLICT / STALE VERSION | INFO/WARN | 409 | No — optimistic-concurrency working as designed |
| BUSINESS RULE (risk/kill-switch) | INFO | 403/423 | No — the rule *working* is not a failure |
| DEPENDENCY FAILURE | ERROR | 503 | Yes |
| INTEGRITY FAILURE | CRITICAL | — (detector) | Yes — authoritative data is wrong |
| INTERNAL FAILURE | ERROR/CRITICAL | 500 | Yes |

## 4. Safe-content rules for every signal

- **Never** log a password, access/refresh token, cookie, `x-stepup-token`, webhook
  secret, provider credential, or raw payment data (enforced by pino `redact`).
- **Metrics never carry a high-cardinality label** (no customerId/accountId/orderId/
  payoutId as a label dimension). Identifiers belong in logs and events, not metric
  labels.
- **Security events carry no attacker payload** — only the event name, the
  server-owned request id, method, matched route pattern, response code, and actor id
  when present. A hostile client cannot forge a log event through them.
- **PII minimization**: prefer stable internal ids over name/email/address/KYC in
  operational signals. (Authorized *list* responses may show contact fields; those
  are not operational signals.)

## 5. Retention classes (classification only — no storage infra built here)

| Class | Example | Retention semantics |
|---|---|---|
| Application logs | request logs, `securityEvent` lines | Disposable; short window |
| Security events | authz-denied, rate-limit, webhook-rejected | Longer than app logs; investigation window |
| Audit records | `audit_log` hash chain | Long-lived, tamper-evident, **never** disposable like a log |
| Financial ledger | `payout_ledger`, balances | Authoritative, permanent |
| Incident evidence | incident + linked entity refs | Kept for the incident's lifetime + review |

Audit/ledger retention is **not** the same as disposable application-log retention;
they must not be conflated when real retention infrastructure is built later.
