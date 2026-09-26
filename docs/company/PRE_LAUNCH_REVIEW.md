# PRE-LAUNCH REVIEW (GO / NO-GO)

**Happy Trader Funding — the decision document.** Phase 12 (2026-09-26). Reviewed at HEAD `feda768`
(+ Phase 12 docs). Companion to `LAUNCH_GATES.md`. This lets Nate make an informed launch decision; it
also hard-classifies any safety failure as NO-GO regardless of preference.

## The one-sentence picture
The **internal software product is strong and safe in simulation** (money integrity, security, recovery
all proven); everything separating it from customers is **business, legal, provider, infrastructure, and
human acceptance** — not core software.

---

## Hard NO-GO conditions (PART 147) — none may be overridden
| Condition | Current state |
|---|---|
| Unresolved P0 | **NONE** — no open P0 |
| Known cross-customer access | **NONE** (tenant isolation proven, Phase 10) |
| Known double-pay | **NONE** (unique ledger key, Phase 9) |
| Known financial mismatch | **NONE** ($0 delta, Phase 9/11) |
| Known risk bypass | **NONE** (server-authoritative; copy-trading re-validates) |
| Backup not restorable | **FALSE** — restore proven (Phase 11) |
| Production mock provider success | **IMPOSSIBLE** — fail-closed (Phase 4) |
| Untrusted payment provisioning | **FALSE** — signed server event only |
| Owner auth critically insecure | **CONDITIONAL** — dev seed can't run in prod, but **no prod owner
  bootstrap + no MFA exists yet**; this is a NO-GO **for any real-infra/real-money mode** until built |
| Unknown order state that can duplicate execution | **NONE** (ack≠fill; lost-ack → SUBMISSION_UNKNOWN) |

**Active hard NO-GO right now:** only for real-infra/real-money modes — production owner bootstrap + MFA
(G6). Internal-only simulation modes are not blocked by it.

---

## Beta-mode verdicts (PART 150)
| Mode | Verdict | Why |
|---|---|---|
| **A — Internal only** (Nate/team, mock/test money, Rithmic Test) | **READY** | Core software PASS; DR proven; production-like boot safe; needs only Nate's manual acceptance |
| **B — Invite-only, NO real money** (test users, controlled accounts) | **READY once B-gates met** | Needs: production owner bootstrap + MFA, human acceptance, alert delivery, and (if on real infra) hosting/DB/backups/domain. No provider/legal money gates required because no money moves |
| **C — Invite-only, REAL purchases, no real payout** | **NOT READY** | Requires `REAL_MONEY_BOUNDARY.md` Boundary A: entity, bank, counsel docs, Whop prod creds, prod infra, secret manager, monitoring |
| **D — Controlled real-money closed beta** (purchase + payout) | **NOT READY** | Requires Boundary A + B: production KYC, real payout provider + funding, tax/legal review |
| **Public launch** | **NOT READY** | Requires all of the above + commercial market-data rights + external pentest + object storage + fully-green validation + accessibility/404 |

## Recommended next mode (PART 151) — evidence-based, NOT authorization
**Mode A (internal only) is supportable today**, and **Mode B (invite-only, no real money) is the highest
mode Phase 13 should prepare for** — reachable with software + human-acceptance + (optional) infra work,
no legal/provider money gates. Do **not** prepare for C/D/public until their external gates advance.

## Beta operational guardrails (PARTS 73-75)
- **User cap:** start ≤ ~10 invited users (small enough for Nate to personally observe every failure).
- **Kill criteria (stop beta immediately):** cross-customer access; money mismatch; double payout;
  duplicate provisioning; risk bypass; lost order state; unrecoverable DB issue; audit verification
  failure; provider ambiguity affecting money; critical security issue.
- **Success criteria:** Golden Path completes; no P0; financial reconciliation clean; support manageable;
  stable provider connection; correct account/risk state; a successful restore drill; human UX accepted.
  (Revenue is **not** a software beta success criterion.)

---

## Action lists

### NATE (human-owner only) — prioritized
1. Form the legal entity (name, state, EIN); open a business bank account; designate signatory.
2. Engage legal counsel with `LEGAL_COUNSEL_REVIEW_PACKAGE.md`; approve customer documents.
3. Open/verify provider accounts as each mode requires: Whop (commerce), Stripe Identity (KYC), a payout
   provider, Resend (email); confirm domain ownership.
4. Confirm Rithmic **commercial/production** rights + exchange data entitlements.
5. Choose + provision production hosting/DB/backups/secret-manager/object-storage (or approve infra spend).
6. Perform manual UX acceptance (`HUMAN_ACCEPTANCE_CHECKLIST.md`), including the Owner-OS mouse-wheel scroll.
7. Engage a CPA (accounting/tax) and, before public launch, an external security reviewer.

### CLAUDE (software/docs only, no external commitment) — prioritized
1. Production owner bootstrap + MFA (G6) — required before Mode B.
2. Wire an alert-delivery channel to the critical conditions in `OBSERVABILITY.md`.
3. Small launch-quality fixes: React error boundary + 404 surface (HTF-30); marketing prose-bullet
   derivation (HTF-31); resolve HTF-29 test isolation.
4. Object storage adapter for certificates (HTF-27) — before public launch.
5. Payout-provider adapter once Nate selects one; Whop/Stripe prod wiring once creds exist.
6. Bind or expose the inactivity sweep (HTF-18) when an external scheduler exists, or soften the disclosure.
7. Keep canonical validation green; maintain runbooks.

### EXTERNAL (owner: the named party)
- **COUNSEL:** entity/structure, Terms/Privacy/Trader-Agreement/Risk/Refund, marketing/payout language,
  privacy/retention/deletion, money-transmission review.
- **CPA:** bookkeeping, revenue recognition, refund/payout expense, 1099/vendor reporting.
- **PROVIDERS:** Whop, Stripe Identity, payout provider, Rithmic + exchange, Resend, hosting, object storage.
- **SECURITY REVIEWER:** external pentest before public launch (Phase 10 scope package ready).

---

## Dependency graph (PART 156) — what blocks what
```
ENTITY (Nate) ──► BUSINESS BANK ──► COMMERCE (Whop) ──► REAL PURCHASE
                              └────► PAYOUT PROVIDER ──► REAL PAYOUT
COUNSEL ──► TERMS / TRADER AGREEMENT / DISCLOSURES ──► REAL PURCHASE
        └─► PAYOUT / TAX LANGUAGE ──► REAL PAYOUT
KYC (Stripe Identity) ──► REAL PAYOUT (gate)
RITHMIC COMMERCIAL + EXCHANGE RIGHTS ──► LIVE CUSTOMER TRADING ENV ──► PUBLIC LAUNCH
PROD OWNER BOOTSTRAP + MFA (Claude) ──► MODE B and beyond
PROD INFRA (host/DB/backups/secrets/domain) ──► any real-infra beta ──► REAL MONEY
EXTERNAL PENTEST + OBJECT STORAGE + GREEN VALIDATION ──► PUBLIC LAUNCH
HUMAN ACCEPTANCE (Nate) ──► every mode
```

## Recommended dependency order (PART 152)
1. Human acceptance (Nate) + Mode-A internal use → confirms the product is right.
2. Prod owner bootstrap + MFA + alert delivery (Claude) → Mode B readiness.
3. Entity → bank (Nate) — unblocks all money.
4. Counsel package/review → customer documents.
5. Production infrastructure (host/DB/backups/secrets/domain/object-storage).
6. Commerce (Whop) prod → Mode C (real purchase).
7. KYC (Stripe) + payout provider + funding + tax review → Mode D (real payout).
8. Rithmic commercial + exchange rights → live trading environment.
9. External security review → public launch.

## Claude-dependency audit (PART 84-86) — normal operation must not need Claude
- Owner OS operates accounts/payouts/enforcement/support/config **without** SQL or Claude — **PASS**.
- Remaining dependencies to remove before real operation: production owner bootstrap (must not be a seed);
  production must not run from a laptop/local Postgres/local cert dir/local `.env`/a Claude session
  (all are `PRODUCTION_ENVIRONMENT_PLAN.md` items). No routine task requires Claude editing the DB.

## Owner operations cadence (PARTS 141-143)
- **Daily:** check `/health`+`/ready`+release; provider health; payout queue; reconciliation; support inbox;
  incidents; enforcement queue; confirm backup ran.
- **Weekly:** financial reconciliation review; provider issues; support trends; security alerts; backup
  verification; product anomalies.
- **Monthly:** restore drill; staff access review; provider access review; open-issue review; legal/provider
  changes; inactivity review; accounting handoff.
- **Beta daily report template (PART 144):** active users, accounts, trades, errors, provider disconnects,
  money mismatches, payout state, support tickets, incidents, open P0/P1.

## RC1 definition (PART 100)
RC1 = no P0; launch-blocking P1 for the chosen mode resolved; canonical validation trustworthy; typecheck
+ build pass; Golden Path + 10 products + money + security + recovery green; human acceptance appropriate to
the mode; external gates appropriate to the mode. On RC1 → code freeze (`PRE_LAUNCH_FEATURE_FREEZE.md`).

## Go / No-Go call (this review)
- **Mode A internal beta:** GO for internal use once Nate completes human acceptance. No hard NO-GO active.
- **Everything beyond Mode B:** NO-GO until the named external/human/legal/infra gates advance.
- **This document is not authorization to invite users, accept money, or send payouts.**
