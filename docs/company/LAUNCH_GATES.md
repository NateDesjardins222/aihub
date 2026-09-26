# LAUNCH GATES

**Happy Trader Funding — the authoritative launch-readiness matrix.** Phase 12 (2026-09-26).
Reviewed at HEAD `feda768` (+ Phase 12 docs). Supersedes the Phase 2 gate table.

Status vocabulary (exact): **PASS** · **PARTIAL** · **BLOCKED — SOFTWARE** · **BLOCKED — HUMAN** ·
**BLOCKED — EXTERNAL** · **NOT APPLICABLE**. Every PASS has evidence; every non-PASS has an owner + next
action. "PASS (simulation/internal)" means proven in the internal build, **not** that the real-world
boundary is open.

> Two truths held apart throughout: **internal software** can PASS while the **real-world boundary**
> (provider account, credentials, rights, entity, infra, human acceptance) remains BLOCKED. Neither hides
> the other.

| Gate | Status | Evidence | Owner | Blocker | Next action |
|---|---|---|---|---|---|
| **G1 Commerce / payments** | PARTIAL (software PASS; real money BLOCKED) | Fail-closed selector (Phase 4), signed webhook is sole provisioning trigger, idempotent + `commerce_events` dedup, refund path (Phase 8/9) | NATE + PROVIDER + CLAUDE | No Whop production account/credentials; entity + bank | Open/verify Whop business account; product/plan IDs; prod webhook + `WHOP_*` creds (`EXTERNAL_DEPENDENCIES.md` #1) |
| **G2 Financial integrity** | PASS (internal engine) | Phase 9: single debit, unique `(request,entry_type)`, 90/10 round-half-even, cycle-count-once, 5-PAID, lost-ack no-blind-repay, CORE 50K → $0.00; `financial-invariants.test.ts` | CLAUDE | — (real rails are G1/G3/G4) | Keep green; re-run in Phase 12 regression |
| **G3 Identity / KYC** | PARTIAL (software PASS; real KYC BLOCKED) | Fail-closed seam (Phase 4); versioned identity model; provisioning gate | NATE + PROVIDER | Stripe Identity account + prod keys + webhook | Enable Stripe Identity; wire prod creds (`EXTERNAL_DEPENDENCIES.md` #2) |
| **G4 Payouts** | PARTIAL (engine PASS; provider BLOCKED) | Phase 9 payout engine; Phase 11 payout-ops worker wired; fail-closed (no mock PAID in prod) | NATE + PROVIDER + CLAUDE | No real payout provider selected/adapter; funding source; recipient verification | Select payout provider; build adapter; verify recipients (`REAL_MONEY_BOUNDARY.md` B) |
| **G5 Market data** | PARTIAL (deterministic PASS; commercial rights BLOCKED) | Phase 6: Rithmic Test proven deterministically, honest freshness, no fallback masking | NATE + PROVIDER + COUNSEL | Rithmic commercial/production rights; CME/exchange data agreement unknown; dev Yahoo feed is dev-only | Confirm Rithmic commercial + exchange entitlements (display/redistribution) (`EXTERNAL_DEPENDENCIES.md` #4/#5) |
| **G6 Security** | PARTIAL | Phase 10 (RBAC/IDOR/webhooks/secrets/audit clean; 0 bundle secrets); Phase 11 (fail-safe) | CLAUDE + NATE + REVIEWER | **Owner MFA not implemented** (only a `mfaEnrolled` flag); **no production owner bootstrap** (seed refuses prod, no replacement); external pentest not done | Build prod owner bootstrap + MFA before beta; engage external review before public launch (PART 20-21) |
| **G7 Trading engine** | PASS (simulation) | Phases 5/6/8/10/11: orders/fills/positions/P&L/risk/brackets/OCO; restart reconstructs from Postgres; provider outage safe; ownership enforced; version-pinned | CLAUDE | — (live feed is G5) | Human acceptance (G-HA) |
| **G8 Customer Portal** | PARTIAL (software PASS; human acceptance pending) | Phase 5/CP: dashboard, accounts, evaluation/funded, payouts, certs, billing, support, risk controls, Atlas hand-off | CLAUDE + NATE | Nate manual acceptance not done | `HUMAN_ACCEPTANCE_CHECKLIST.md` §C |
| **G9 Owner OS** | PARTIAL (software PASS; human acceptance pending incl. scroll) | Phase 7: routine ops console-operable; kill switches enforce; reconciliation/audit | CLAUDE + NATE | Manual mouse-wheel scroll + full operate not confirmed by Nate | `HUMAN_ACCEPTANCE_CHECKLIST.md` §E (PART 78) |
| **G10 Product / rule consistency** | PASS (with minor drift note) | Exactly 10 commercial products, single-sourced from `product-catalog.ts`; marketing reads it directly; runtime reads DB reconciled from same source; no legacy purchasable; public products endpoint returns only the 10 | CLAUDE | Marketing prose rule-bullets are hand-authored (drift risk; numbers are single-sourced) — HTF-31 | Derive/verify prose bullets against numeric config (post-beta polish) |
| **G11 Observability / incidents** | PARTIAL | Phase 11: `/health` `/ready` `/version`, System Doctor, runbooks; alert conditions defined | CLAUDE + INFRASTRUCTURE | No alert-delivery channel wired; metrics/tracing export (HTF-19) | Wire an alert channel before real money (`EXTERNAL_DEPENDENCIES.md` #12) |
| **G12 Production infrastructure** | BLOCKED — EXTERNAL | Phase 11: DR proven, deploy/rollback/DR runbooks; canonical validation | NATE + INFRASTRUCTURE | No production hosting/DB/backup/PITR/secret-manager/object-storage/domain provisioned | `PRODUCTION_ENVIRONMENT_PLAN.md`; provision infra |
| **G13 Business / legal** | BLOCKED — HUMAN / EXTERNAL | Agreement mechanism READY (versioned, immutable, audited acceptance); content is DEV placeholder | NATE + COUNSEL | Entity/EIN/bank/signatory absent; legal content not counsel-approved | `LEGAL_COUNSEL_REVIEW_PACKAGE.md`; form entity; engage counsel |
| **G14 Domain / communications** | PARTIAL (software seam; external BLOCKED) | Resend seam (suppress-not-fake); 40 transactional notification types; outbox worker | NATE + PROVIDER | No domain/DNS/TLS confirmed; Resend account + SPF/DKIM/DMARC; no standalone legal pages served | Confirm domain; Resend prod + sender verification (`EXTERNAL_DEPENDENCIES.md` #6/#13) |
| **G15 Support** | PASS (software) / PARTIAL (human) | Phase 12/M12: tickets, account context, remediation/refund, escalation, audit, attachments | CLAUDE + NATE | Support operating model is human-run; acceptance pending | Adopt beta support workflow (`PRE_LAUNCH_REVIEW.md`) |
| **G16 Data / privacy** | PARTIAL | PII is references/decisions only — no raw SSN/ID images/card numbers (schema-verified); data minimization by design | CLAUDE + COUNSEL | Privacy policy + retention + deletion-request policy are counsel decisions | Counsel privacy/retention review (G13) |
| **G17 Accounting / tax** | BLOCKED — EXTERNAL | Simulated balances are separate from corporate ledger (never conflated) | NATE + CPA | No bookkeeping/tax/1099 setup | Engage CPA; define revenue/payout/refund/affiliate tracking |
| **G18 Fraud / enforcement** | PASS (software) | M7: hold engine, reason codes, four-eyes, appeals, versioned pledge; conservative-accusation philosophy | CLAUDE + COUNSEL | Enforceability/disclosure is counsel review | Counsel review conduct rules (G13) |
| **G19 Certificates** | PASS (software) w/ storage gap | Deterministic generation, exactly-once triggers, verification, immutable history | CLAUDE | Artifact bytes local-FS only (HTF-27) — beta-tolerable, launch-blocking | Wire object storage before public launch |
| **G20 Affiliates** | PASS (software) / disable-for-beta | M11: attribution, exactly-once commission, owner visibility; payout provider unconfigured | CLAUDE + NATE + COUNSEL/CPA | Affiliate payout provider + tax; not needed for closed beta | Keep disabled for closed beta; revisit before enabling |

## Cross-cutting human-acceptance gate (G-HA)
**BLOCKED — HUMAN.** Atlas, Portal, Owner OS, public site, checkout, failure states, and the manual
Owner-OS scroll require Nate's physical sign-off (`HUMAN_ACCEPTANCE_CHECKLIST.md`). Claude cannot self-certify.

## Software gaps found in Phase 12 (new HTF issues)
- **HTF-30 (P2, software):** no catch-all 404 page and no React error boundary in `apps/web` — a render
  error blanks the page. Beta-acceptable (known users); **fix before public launch** (PART 125).
- **HTF-31 (P3, docs/software):** marketing family rule-bullets are hand-authored prose, not derived from
  the numeric config; drift risk. Numbers themselves are single-sourced.
- **HTF-18 (carried, P3→beta-relevant):** funded inactivity sweep implemented + tested but **not wired to
  any scheduler and no on-demand route** — inactivity closure will not happen. If the policy is disclosed
  to customers, it must be wired (external cron) or the disclosure softened before relying on it.
- **HTF-27 (P2):** certificate object storage local-FS only.
- **HTF-29 (P4, test-only):** shared-org audit-verify artifact in the full monolithic run.

## Gate summary
- **PASS (internal/software):** G2, G7, G10, G15(sw), G18, G19(sw), G20(sw) — the internal product core.
- **PARTIAL:** G1, G3, G4, G5, G6, G8, G9, G11, G14, G16.
- **BLOCKED — HUMAN/EXTERNAL:** G12 (infra), G13 (business/legal), G17 (accounting).
- **BLOCKED — HUMAN (cross-cutting):** G-HA acceptance.
- **NO gate is VERIFIED for real money** — correct for this stage.
