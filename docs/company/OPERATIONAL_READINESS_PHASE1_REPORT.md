# Operational Readiness Phase 1 — Report

**Observability / health / diagnostics / incident-evidence / safe-operations.**
Starting commit `3fe1d19` (Security Phase 1 head), checkpoint
`operational-readiness-phase1-start`. Branch
`claude/futures-trading-simulator-v8qefu`.

**Headline:** the operational truth layer was already mature — liveness/readiness,
kill switches, an append-only tamper-evident audit chain, System Doctor, a full
integrity + reconciliation toolset, provider-safety fail-closed, incidents/alerts,
and bounded metrics all existed and were left in place. This phase **inventoried,
proved, and gap-filled**: six low-risk in-scope fixes (OPS-1…OPS-6), a reusable
outbox-health surface, and a read-only `pnpm ops:check` self-check. **No P0 or P1
operational defect was found.** Deep money/state corruption is detectable today
(integrity + reconciliation), and the one launch-critical detection gap — the
console not surfacing RES-P2-1 — is now closed.

Deliverables: this report · `OPERATIONAL_READINESS_MAP.md` ·
`OPERATIONAL_SIGNAL_MODEL.md` · `OPERATIONAL_ALERT_CATALOG.md` ·
`OPERATIONAL_INCIDENT_RUNBOOK.md`. Updated where evidence changed:
`KNOWN_ISSUES.md`, `SECURITY_INVARIANT_LEDGER.md`.

## Findings (all fixed or documented; none P0/P1)

| ID | Sev | Status | Summary |
|---|---|---|---|
| OPS-1 | P2 | FIXED | Log redaction widened (cookies, `set-cookie`, `x-stepup-token`, webhook sig, token/password body fields). |
| OPS-2 | P3 | FIXED | Safe `x-request-id` (client token sanitized or UUID) + response header for support correlation. |
| OPS-3 | P2 | FIXED | RES-P2-1 detector added to the **console** integrity suite (`INV_FAILED_PAYOUT_DEBIT_REVERSED`); was CLI-only. |
| OPS-4 | P3 | FIXED | `outboxStats.oldestPendingAgeMs` + reusable `outboxHealth()` (stall/dead-letter → DEGRADED). |
| OPS-5 | P2 | FIXED | System Doctor gained a first-class `outbox` probe. |
| OPS-6 | P2 | FIXED | 429 / privileged-403 emit a bounded, payload-free `securityEvent` structured log. |
| OPS-7 | P3 | Documented | Two divergent integrity/reconciliation stacks; the launch-critical divergence (RES-P2-1) is closed by OPS-3. |
| OPS-8 | P3 | Documented | Provider-state vocabularies not unified (`ProviderHealthState` name collision); no md/exec health transition suite. |
| OPS-9 | P3 | Documented | No forced-shutdown timeout, no outbox worker heartbeat, login success/failure not audited. |

---

## Final report — answers

### Repository
1. **Starting commit?** `3fe1d19` (Security Phase 1 head), checkpoint `operational-readiness-phase1-start`.
2. **Ending commit?** The commit adding this report on `claude/futures-trading-simulator-v8qefu` (hash in the session/PR).
3. **Clean?** Yes — clean tree at start; all work committed.
4. **Remote == local?** Yes (verified after push).
5. **Checkpoint preserved?** Yes — tag + `checkpoint/operational-readiness-phase1-start`; all prior tags/branches/stashes intact.
6. **Stashes preserved?** Yes — `phase3-wip-product-model` untouched.

### Current state
7. **Existing operational systems reused?** Yes — health/readiness, System Doctor, integrity + reconciliation, kill switches, audit chain, incidents, alerts, provider-safety, metrics were all reused, not rebuilt.
8. **Duplicated systems removed/avoided?** No new duplicate built. The pre-existing CLI-vs-console integrity duplication (OPS-7) is documented; OPS-3 extended the console suite rather than forking a third.
9. **Missing launch-critical observability found?** One: the console integrity suite did not surface RES-P2-1 (failed-payout-missing-reversal). Fixed (OPS-3).

### Health
10. **Liveness implemented/proven?** Yes — `GET /health`, always 200, no dependency probe; proven in `infra-health.test.ts` + `operational-readiness.test.ts`.
11. **Readiness implemented/proven?** Yes — `GET /ready`, DB probe (2s timeout race) → 200/503; proven.
12. **What makes instance unready?** Only PostgreSQL unreachable (the sole source of truth). Providers do not.
13. **Does provider outage incorrectly restart server?** No — liveness ignores providers *and* the DB; a provider/DB blip yields 503 readiness but 200 liveness (no restart loop).
14. **Health responses secret-free?** Yes — asserted (`not /password|secret|jwt|postgres:\/\//i`) for `/health`, `/version`, `/ready`.

### Dependencies
15. **DB state?** System Doctor `database` (connectivity + latency) + `/ready` probe + `ops:check`.
16. **Outbox state?** `outboxStats` (pending/deadLetter/delivered/**oldestPendingAgeMs**) + `outboxHealth` (HEALTHY/DEGRADED) + System Doctor `outbox` probe.
17. **Provider-state model?** `buildInfraHealth` (redacted) + provider-safety summary; `ProviderHealthState`/`ProviderConfigState` in contracts.
18. **DISABLED distinct from FAILED?** Yes — unconfigured future rails report DISABLED/NOT_CONFIGURED/UNAVAILABLE at INFO; never CRITICAL. Proven by provider-safety tests + `ops:check` output.
19. **Multi-instance semantics?** Health is per-instance; dependency/business state is read from Postgres (shared authority), not process memory. No authoritative global health kept in one process.

### Logging
20. **Structured logs?** Yes — pino JSON in prod.
21. **Request IDs?** Yes — every request; `safeRequestId`/`genReqId`; echoed as `x-request-id`.
22. **Correlation strategy?** Entity ids + audit `context.correlationId`/`requestId` + `ops-events.correlationTrace()`; no distributed-tracing system (by design).
23. **Secret redaction?** Widened (OPS-1) to headers (authorization/cookie/step-up/webhook-sig), `set-cookie`, and token/password body fields.
24. **PII minimized?** Operational signals prefer internal ids; security signal carries no body/query/PII. (Authorized list views may show contact fields — not operational signals.)
25. **Log injection safe?** Yes — a client request id is sanitized before it can reach the log/audit stream; security signals never log attacker strings. Proven in `operational-readiness.test.ts`.

### Integrity
26. **Existing integrity checker reused?** Yes — both the CLI (`resilience/integrity-checks.ts`) and console (`integrity.ts`) suites; not rewritten.
27. **Deep check separate from readiness?** Yes — `/ready` is a DB ping; deep integrity is `pnpm integrity:check` / `/system/*`, never run on a health request.
28. **Violations machine-readable?** Yes — CLI `{check, severity, count, sample[]}`; console `{key, status, severity, affectedCount, sampleRefs[]}`.
29. **Entity scope provided safely?** Yes — sample/affected entity refs (ids), no payloads.
30. **False critical signals?** No — INFO for expected states; NOT_CONFIGURED excluded from CRITICAL.

### Reconciliation
31. **CLEAN distinguishable?** Yes — IN_SYNC / matched / empty violation array.
32. **MISMATCH distinguishable?** Yes — RECONCILIATION_REQUIRED / mismatch counts / ReconLine drift.
33. **CHECK FAILED distinguishable?** Yes — venue `UNKNOWN`; Reconciliation Center `EMPTY` (never-run); script exit 1 (run failed) vs 2 (violations).
34. **Payout/ledger mismatch visible?** Yes — `PAYOUT_LEDGER_ARITHMETIC`, `APPROVED_PAYOUT_WITHOUT_DEBIT`, Reconciliation Center PAYOUT_PROVIDER.
35. **Position/execution mismatch visible?** Yes — `PHANTOM_POSITION` + reconcile oracle POSITION_* lines.

### Trading
36. **Order failures observable?** Yes — domain events (order.rejected etc.) + audit.
37. **Execution failures observable?** Yes — domain events + reconciliation UNKNOWN/mismatch.
38. **Risk rejection categories observable?** Yes — reason codes in events/audit; not treated as app failures.
39. **Provider disconnect observable?** Yes — `ConnectionState` → provider health snapshot; System Doctor.
40. **Market ticks excluded from noisy logs?** Yes — no per-tick logging; metrics are bounded counters.

### Payout
41. **Request lifecycle observable?** Yes — payout domain events + `payout-ops-metrics` + audit.
42. **Failed payout observable?** Yes — state FAILED event + integrity detectors.
43. **Reversal observable?** Yes — `payout_ledger` REVERSAL row; `failPayout` audited.
44. **Missing reversal detectable?** Yes — now in **both** CLI and console (OPS-3).
45. **Duplicate callback suppression observable?** Yes — `payout_provider_events` dedup + `commerce.event_rejected`/dedup events.
46. **Unknown external outcome represented distinctly?** Yes — `LOST_ACK`/`TIMEOUT`/`UNKNOWN` / `UNKNOWN_PROVIDER_STATE`, never conflated with FAILED.

### Lifecycle
47. **Provision/reset/pass/funded/complete events traceable?** Yes — domain events + audit subject types + inspectors.
48. **Impossible transition attempts visible?** Yes — guarded transitions raise typed errors + audit; no huge state blobs logged.

### Security
49. **Privileged brute-force signal?** Yes — `securityEvent=rate_limit_blocked` (429) + step-up mint rate-limit (SEC-1).
50. **Invalid webhook signal?** Yes — `commerce.event_rejected` + recorded `commerce_events` REJECTED.
51. **Replay suppression signal?** Yes — dedup no-op on `(provider, eventId)`; idempotent 200.
52. **Diagnostics authorization proven?** Yes — owner diagnostics are `requireUser` + `requirePermission`/role; existing authz suites cover them; unchanged by this phase.
53. **Any observability data leak?** No — redaction widened, metrics bounded, security signal payload-free, health secret-free (all tested).

### Providers
54. **Generic provider model?** Partially — a shared contracts model for md/exec; payout/others use their own. Documented (OPS-8).
55. **Disabled provider honest?** Yes — DISABLED/NOT_CONFIGURED/UNAVAILABLE at INFO.
56. **State transitions tested?** Payout DOWN→HEALTHY proven; md/exec transition suite is a documented gap (OPS-8).
57. **Credentials excluded?** Yes — every health/status surface is redacted; asserted by tests.

### Outbox
58. **Pending count?** Yes — `outboxStats.pending`.
59. **Oldest age?** Yes — `oldestPendingAgeMs` (OPS-4).
60. **Failure/poison state?** Yes — `deadLetter` count.
61. **Stall detectable?** Yes — `outboxHealth` DEGRADED when oldest pending > threshold or dead-letter > 0; System Doctor `outbox` probe. Proven in `ops-signals.test.ts`.
62. **Worker restart behavior visible?** Partially — a stall is inferred from age; there is no worker heartbeat (OPS-9). Restart re-drives via SKIP-LOCKED claim.

### Metrics
63. **Counters added/reused?** Reused — no new metric system built (existing bounded counters suffice).
64. **High-cardinality labels?** No — verified: no customer/account/order/payout label dimension anywhere.
65. **Latency visibility?** Yes — `x-atlas-ms` per response; System Doctor `durationMs`; payout SLA percentiles.
66. **Metrics remain non-authoritative?** Yes — governing rule stated in the signal model; nothing writes to a metric as truth.

### Incidents
67. **Incident categories?** Yes — TRADING/RISK/PAYOUT/COMMERCE/IDENTITY/SECURITY/DATA INTEGRITY/PROVIDER/DATABASE/OUTBOX/PLATFORM.
68. **Alert catalog?** Yes — `OPERATIONAL_ALERT_CATALOG.md` (provider-neutral, no paid stack).
69. **Page-worthy separated from non-page?** Yes — explicit page vs dashboard vs not-an-alert sections.
70. **Runbooks?** Yes — `OPERATIONAL_INCIDENT_RUNBOOK.md` (9 highest-value incidents) + existing detailed runbooks.
71. **Safe retry classification?** Yes — SAFE TO RETRY / DO NOT RETRY / RECONCILE FIRST / MANUAL REVIEW, from the Failure Recovery Matrix.

### Diagnostics
72. **Privileged diagnostics surface?** Yes — `/system/*`, `/command-center`, `/admin/infra`, owner-observability (permission/role-gated).
73. **App version/commit visible?** Yes — `/version`, `/health`, `ops:check`.
74. **DB health visible?** Yes — `/ready`, System Doctor, `ops:check`.
75. **Outbox visible?** Yes — System Doctor `outbox`, `ops:check`, admin `/system`.
76. **Provider state visible?** Yes — `/admin/infra`, System Doctor, `ops:check`.
77. **Integrity status visible?** Yes — `/system/integrity`, `ops:check` (latest persisted), `pnpm integrity:check` (fresh).
78. **Secrets absent?** Yes — every diagnostic surface is redacted/secret-free; tested.

### Evidence
79. **Order incident reconstructable?** Yes — `ops-events.correlationTrace()` + audit + inspectors + reconcile oracle for one account/order.
80. **Payout failure/reversal reconstructable?** Yes — `inspectPayout` + payout events + ledger DEBIT/REVERSAL + integrity detector.
81. **Lifecycle transition reconstructable?** Yes — domain events + audit subject timeline for provision→reset→pass→funded→complete.
82. **Correlation sufficient?** Yes for representative failures — entity ids + correlation trace + audit chain; no separate tracing system needed at this scale.

### Operability
83. **Any critical incident still requires manual SQL mutation?** No normal-incident path requires SQL *mutation* of money — safe recovery uses idempotent domain actions (`failPayout`, `retryPendingProvisioning`, `fundEligibleQualifications`, `reconcilePayout`) and read-only tooling. Rare bespoke corruption is MANUAL REVIEW with an audited operator action, not raw SQL.
84. **Which?** None launch-critical. Read-only SQL for forensics is acceptable; direct money mutation is exceptional and audited.
85. **Safe CLI/read-only tooling?** Yes — `pnpm integrity:check`, `pnpm ops:check` (both read-only), plus `/system/*` read endpoints.
86. **ops:check created?** Yes — `scripts/ops-check.ts` + `pnpm ops:check`.
87. **ops:check result?** Runs clean against a fresh seeded DB (RESULT OK, exit 0); correctly reports DEGRADED outbox / WARNING doctor when the shared test DB carries leftover dead-letter rows (proves the DEGRADED path).

### Faults
88. **DB failure signal?** Yes — `/ready` 503, System Doctor CRITICAL, `ops:check` UNREACHABLE.
89. **Outbox failure signal?** Yes — `outboxHealth` DEGRADED + System Doctor WARNING (proven via injected stall + dead-letter).
90. **Provider timeout signal?** Yes — provider health DEGRADED/UNAVAILABLE; TIMEOUT/LOST_ACK/UNKNOWN outcome states.
91. **Integrity mismatch signal?** Yes — detectors non-zero + machine-readable (proven RES-P2-1 detector present).
92. **Any critical silent failure found?** No — deep money/state corruption is detectable (integrity + reconciliation). The only *silent-to-the-console* case (RES-P2-1) was found and fixed.

### Findings
93. **P0?** None.
94. **P1?** None.
95. **P2?** OPS-1, OPS-3, OPS-5, OPS-6 (all fixed).
96. **P3?** OPS-2 (fixed), OPS-4 (fixed), OPS-7, OPS-8, OPS-9 (documented).
97. **Production defects found?** No correctness/money defect. Visibility gaps only.
98. **Production defects fixed?** The visibility gaps OPS-1..OPS-6 were fixed; RES-P2-1's *write-side* fix already existed (`failPayout`).
99. **Deferred issues?** OPS-7 (integrity-stack unification), OPS-8 (provider-state unification + md/exec transition tests), OPS-9 (shutdown timeout, worker heartbeat, login audit).

### Validation
100. **Focused operational test count?** 36 (operational-readiness + ops-signals + infra-health + projection-outbox + system-doctor).
101. **Diagnostics security tests?** Covered by existing authz suites (unchanged surfaces) + new request-id/redaction/secret-free assertions.
102. **Typecheck?** Pass.
103. **Build?** Pass.
104. **Canonical?** `pnpm validate:release` run once: typecheck ✓, build ✓, tests **3141 passed / 6 skipped / 1 failed (3148)**. The single failure was a `beforeEach` **hook timeout (10s)** in `trading-authz-http.test.ts` (`makeTrader` — trader registration under full-suite load across 238 files), not an assertion failure.
105. **First-run canonical failure?** Yes, honestly reported: the one failure is a load-induced `beforeEach` timeout, **not** a regression — the same suite passes cleanly in isolation (4/4 in ~5s) and inside `pnpm security:check` (17 suites / 207 tests). No blind full rerun was performed; the first failure was diagnosed directly. The `securityEvent` log lines emitted during that run are the OPS-6 signal working as designed, not errors.

### Scope
106. **Economics changed?** No.
107. **Product rules changed?** No.
108. **RES-1 changed?** No.
109. **SEC-2 changed?** No.
110. **SEC-3 falsely marked complete?** No — remains a hard pre-payout-rail launch gate.
111. **Portal V2 migrated?** No.
112. **Portal redesigned?** No.
113. **Atlas redesigned?** No.
114. **Production provider connected?** No.
115. **Paid monitoring product added?** No — provider-neutral seams only.
116. **Real money used?** No.

### Final
117. **Exact final commit?** The commit adding this report (hash in the session/PR).
118. **Most serious operational defect discovered?** The owner console could not surface RES-P2-1 (failed-payout-missing-reversal); a real money-integrity condition was CLI-only. Fixed (OPS-3).
119. **Largest remaining operational risk?** No production alert *delivery* exists — detection is strong, but paging/notification is future work; an operator must run `ops:check` / watch the console until a real alerting stack is wired to the alert catalog.
120. **Largest risk impossible to test before production providers?** Real provider behavior under load/outage (Rithmic, a real payout rail, Whop production, Databento realtime) — reconnection, partial-outage, and true OUTCOME-UNKNOWN handling can only be proven against the live providers.
121. **Is another Operational Readiness phase justified?** Only narrowly — see below. Detection is comprehensive; the remaining work is *delivery* and *unification*, both better done alongside the production infrastructure they depend on.
122. **Or diminishing returns?** Largely yes for *detection*. Further deep observability work here would produce modest new value until (a) a real alerting/monitoring provider is connected (needs prod infra) and (b) the two integrity stacks / provider-state vocabularies are unified (a refactor, not a readiness gap).
123. **What OBJECTIVELY DIFFERENT domain next (while Nathan still cannot visually review)?** **Performance & capacity engineering under realistic load** — backend latency budgets, connection-pool and query behavior at scale, WS fan-out under many concurrent terminals, and load/soak against the read-model + outbox. It is backend-provable without visual review, does not need production providers, and is the one large dimension not yet attacked (resilience proved *correctness under failure*; this would prove *behavior under scale*).

---

## Definition of Done — checklist

Operational capabilities inventoried ✓ · liveness/readiness distinct ✓ · critical
dependencies honest ✓ · disabled ≠ broken ✓ · logs safe + useful ✓ ·
request/correlation strategy ✓ · secrets out of diagnostics ✓ · outbox stalls
detectable ✓ · integrity failures machine-readable ✓ · reconciliation mismatch vs
checker-failure distinguished ✓ · trading/risk/payout failures observable ✓ ·
RES-P2-1 class detectable (console + CLI) ✓ · critical lifecycle transitions
traceable ✓ · security signals without spam ✓ · provider health reusable seam ✓ ·
unknown outcome ≠ failure ✓ · privileged diagnostics authorization-protected ✓ ·
metrics bounded cardinality ✓ · incident evidence reconstructable ✓ · highest-value
runbooks ✓ · operator tooling read-only by default ✓ · observability not
authoritative ✓ · fault injection proves signals fire ✓ · multi-instance semantics
intact ✓ · no unresolved P0/P1 ✓ · no economics/product-rule/RES-1/SEC-2 change ✓ ·
SEC-3 still a launch gate ✓ · Portal V2 unmigrated ✓ · Atlas untouched ✓ · no
provider activated ✓ · no paid monitoring required ✓ · canonical honestly reported ✓.

**STOP.** Operational Readiness Phase 2 is **not** started. Recommendation on
whether further observability work is worthwhile: see Q121–123 — detection has
largely reached diminishing returns; the next material value is a different domain
(performance & capacity under load) or wiring real alert *delivery* alongside
production infrastructure. Awaiting next instruction.
