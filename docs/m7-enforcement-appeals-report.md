# Milestone 7 — Prohibited Conduct, Enforcement, Holds & Appeals V1

**Status:** complete. Server and web typecheck clean; 88 deterministic enforcement
tests and a 42-check real-browser acceptance suite pass; the full server suite is
green apart from a set of pre-existing, unrelated cross-suite ordering flakes in
the trading tests (documented below).

This milestone builds the machinery that lets Happy Trader **detect aggressively
but accuse conservatively**. It automates the clearly-safe containment actions,
requires strong evidence and the right authority for anything punitive, keeps a
human in the loop, and preserves the customer's right to appeal. It is explicitly
*not* an anti-profit system, and it contains no black-box fraud score.

---

## The philosophy, encoded — not just documented

Every non-negotiable principle is enforced in code and asserted by a test, not
left to operator discipline:

| Principle | Where it lives | Test |
|---|---|---|
| Profitability / a VPN / a new device / travel is **not** a violation | `deriveSeverity` returns `INFO`/`LOW` for these signal kinds; a signal never auto-opens a case unless MEDIUM+ or a customer report | `enforcement-core`, `enforcement-service` |
| A **signal is not a finding** | `ingestSignal` only records an observation; findings are a separate, deliberate act | `enforcement-service` "a new-device INFO signal never opens a case" |
| A **temporary hold is not a conviction** | holds are a separate table from findings; placing one never sets `CONFIRMED_VIOLATION` | `enforcement-service`, `enforcement-integration` |
| A **rule breach is not misconduct** | `recordFinding` rejects every `NON_MISCONDUCT_CODE` (MLL, consistency, daily progression, personal risk…) | `enforcement-core`, `enforcement-service` "reject a rule-breach code" |
| **Risk-reducing trading is never blocked** | the trading-hold gate mirrors the personal-risk gate: it only ever blocks the exposure-**increasing** portion, and skips liquidations | `enforcement-integration` (reduce / close / liquidate all pass while held) |
| **Punitive action needs evidence AND authority** | serious findings and terminations are gated to `SUPER_ADMIN` at the route layer | `enforcement-authz` four-eyes tests |
| **Appeal rights** for eligible serious decisions | `appealEligibility` + `submitAppeal`; independence guard on `decideAppeal` | `enforcement-service`, browser suite |
| **PAID payout history is never rewritten** | enforcement adds a *hold* on request/approval; it never touches a paid ledger row | payout integration (holds are additive to eligibility) |
| **No black-box fraud score** | there is no numeric score column anywhere; severity is an explicit, auditable enum | `enforcement-service` "carry no numeric fraud/risk score field" |
| **Server authority + IDOR protection** | every portal route re-resolves the caller's identity and scopes by ownership | `enforcement-authz` IDOR tests |

---

## What was built

### Domain (server-authoritative, house pattern)

- **`enforcement-core.ts`** — the pure spine: case categories, severities
  (`INFO…CRITICAL`, urgency not guilt), the case state machine
  (`canTransitionCase`, no shortcut to `CONFIRMED_VIOLATION`), signal sources,
  evidence visibilities (`INTERNAL` / `CUSTOMER_SAFE` / `LEGAL_RESTRICTED`), hold
  scopes and capabilities, the finding reason-code taxonomy, the
  misconduct-vs-rule-breach separation, the customer-safe category mapping,
  explicit `deriveSeverity`, and the reduce-only `increasingExposure` rule.
- **`enforcement.ts`** — the service: idempotent signal ingestion, case
  correlation folding, `placeHold` / `releaseHold` (idempotent), `recordFinding`
  (NO_VIOLATION clears holds; adverse confirms and is appealable; rule-breach
  codes rejected), `recordAction` (idempotent, with real effects), information
  requests with an ownership guard, and appeals V1 with a same-reviewer
  independence guard and immutable, append-only decisions.
- **`enforcement-holds.ts`** — the narrow, cycle-free read layer the hot paths
  (execution, payouts, commerce) consult.

### Integrations (all additive, none rewrite existing economics)

- **Trading** — a `TRADING` hold blocks new/added exposure but never a
  reduce / flatten / close / liquidation. A held trader can always de-risk.
- **Payouts** — `PAYOUT_REQUEST` and `PAYOUT_APPROVAL` are independent
  capabilities, surfaced as an `ENFORCEMENT_HOLD` alongside an
  `economicallyEligible` flag so the UI shows "eligible, temporarily under
  review" rather than rewriting eligibility. Paid history is untouched.
- **Copy trading** — no new code: a held leader cannot open (engine gate), so no
  fan-out occurs; each follower is independently gated on its own account.
- **Commerce** — a `PURCHASE` hold blocks checkout before an order is created.
- **Auth** — real session revocation (bulk refresh-token revoke) backs the
  `REVOKE_SESSIONS` / `FORCE_SESSION_REAUTH` / termination actions.

### Surfaces

- **Owner Enforcement workspace** (`/admin/enforcement`) — review queue, cases,
  appeals, holds, signals, and a case workbench whose punitive controls are
  hidden for roles that may not use them (the server still enforces it).
- **Trader Account Review portal** (`/portal/review`) — customer-safe status,
  plain-language holds, information responses, self-reporting, and the appeal
  path. It never shows an internal reason code, severity, or evidence.

### Policy

- The `TRADER_PLEDGE` agreement was reworded to the prohibited-conduct policy V1
  (reusing the existing versioned-agreement machinery — no new acceptance table),
  and the customer-facing policy document was written.

---

## A real bug this milestone found and fixed

The portal appeal route validated its path parameter as a UUID, but the
customer-safe view only ever exposes a case's **public reference** (`HTR-XXXXXX`).
Every appeal submitted from the portal therefore failed with a 400. The route now
resolves a case by reference *or* id, scoped to the caller's identity (keeping the
IDOR guard). Covered by a new deterministic HTTP test and by the browser suite.

Separately, the M7 schema used the `now()` helper (which hard-codes the column
name `created_at`) for semantic timestamp fields whose migration created
`decided_at` / `performed_at` / `requested_at` / `submitted_at` / `captured_at`.
The ORM mapping was corrected to the real columns; field names are unchanged.

---

## Verification

- **Typecheck:** `apps/server` and `apps/web` both clean.
- **Deterministic (88):**
  `enforcement-core` (41), `enforcement-service` (21),
  `enforcement-integration` (11), `enforcement-authz` (15).
- **Browser acceptance (42 checks):** `tests/browser/enforcement-acceptance.spec.mjs`
  drives both surfaces against the real server, web and database.
- **Full server suite:** 985+ passing. The 8 failures observed in a single
  whole-suite run are pre-existing cross-suite ordering flakes in the trading
  tests (`POSITION_FROM_ANOTHER_MARKET`, documented as D-017 in the harness):
  they reproduce with only those trading files loaded and **no** M7 file present,
  every one passes in isolation, and M7 modifies none of them.

## Out of scope (as specified for M7)

Real payout rails, Rithmic/Databento production wiring, a machine-learning fraud
model, browser fingerprinting or any invasive surveillance, new products, and
the final attorney-approved Terms. The policy document is a product policy and is
labelled for counsel review before launch.

---
_Docs in this milestone: `happy-trader-prohibited-conduct-policy-v1.md`,
`enforcement-reason-codes.md`, `enforcement-case-lifecycle.md`,
`enforcement-holds.md`, `enforcement-appeals-v1.md`,
`enforcement-owner-operations.md`,
`prohibited-conduct-enforcement-architecture.md`, and this report._
