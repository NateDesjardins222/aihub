# OWNER OS — OPERATIONAL CONTROL-PLANE ACCEPTANCE

**Phase 7 — company operations + control-plane acceptance; HTF-21 resolution; kill-switch
enforcement.**

Baseline HEAD at start: `44169e5` (Phase 6) · Compiled 2026-09-26 ·
branch `claude/futures-trading-simulator-v8qefu`.

> **The Phase 7 question, answered up front:** *Can the owner run the company day-to-day from the
> Owner OS console, without raw SQL or an AI assistant?*
>
> **Mostly yes for routine operations; NO for emergency/safety controls and financial exports —
> but the safety controls now actually WORK when engaged.** Routine ops (accounts, customers,
> payouts + STP, enforcement, support, affiliates, audit, product config, provider health) are
> wired end-to-end, RBAC-gated and audited. The **safety/config/incident plane is still view-only
> in the console (HTF-10 open)** — the owner engages a kill switch or feature flag via the API, not
> a button. **What Phase 7 fixed is worse than cosmetics:** 5 of 7 kill switches were engageable but
> *inert* — engaging "disable payouts" did nothing. They now enforce at their server chokepoints.
> And **HTF-21 is resolved**: a trader can no longer weaken the risk rules of a commercially-weighted
> account.

Nothing here is PRODUCTION-VERIFIED. Real payment/payout/KYC rails remain mock/unconfigured.

---

## 1. HTF-21 — trader self-serve risk-weakening (RESOLVED, mandatory)

**The hole.** Three trader self-serve mutations in
`apps/server/src/http/routes/trading.ts`, gated only by ownership (`requireUser` +
`assertOwnership`), worked on **any** account the trader owned:

- `PUT /api/v1/accounts/:id/rules` — rewrite the account's firm risk terms (profit target, max
  loss / drawdown, consistency threshold, contract limit, …).
- `POST /api/v1/accounts/:id/reset` — destructively reset to opening state (revive a **breached**
  evaluation for free, at an arbitrary size).
- `PUT /api/v1/accounts/:id/environment` — set fill model, slippage, latency, and **turn off
  fees / commissions**.

On a paid EVALUATION or a FUNDED account this lets a trader weaken the rules they are judged by,
un-fail a breach, and soften the account they are paid from — destroying product integrity.

**The account model.** `accounts.accountType ∈ { PRACTICE, EVALUATION, FUNDED, FUNDED_SIM }`.
Commercial evaluation products provision `EVALUATION`; funded destinations provision `FUNDED_SIM`;
`PRACTICE` is the free internal simulator (`INTERNAL_PRACTICE_KEY`, excluded from active-slot
accounting). **Commercially-weighted = EVALUATION ∪ FUNDED ∪ FUNDED_SIM; the only self-serve-safe
type is PRACTICE.**

**The fix.** A single chokepoint guard `assertSelfServeMutable(accountType)`
(`trading.ts`) throws **403 `SELF_SERVE_FORBIDDEN`** unless `accountType === 'PRACTICE'`, wired into
all three mutating handlers after the account load and before any write. Ownership is still checked
first (a stranger gets 404, never a hint the account exists). The **read** paths
(`GET .../rules`, `GET .../environment`) stay open so a trader can always see their own terms.
Self-reset/retune/re-environment of the free PRACTICE simulator is unchanged.

**Not touched (correctly):** `personal-risk.ts` personal controls are *tighten-only* (a trader can
only make an account MORE restrictive, order-path enforced), so they are safe on commercial
accounts and need no gate.

**Proof:** `apps/server/src/http/routes/self-serve-boundary.test.ts` (6 tests): PRACTICE allows all
three; EVALUATION refuses all three with `SELF_SERVE_FORBIDDEN`; the override is **never persisted**
and the provisioned $48k floor stands after a refused edit; FUNDED_SIM refused; read paths open;
a non-owner still gets 404.

---

## 2. Kill-switch ENFORCEMENT (the trust-critical Phase 7 fix)

**The hole.** Seven kill switches (`platform/kill-switches.ts`) could be engaged from the API —
writing a CRITICAL audit event + owner alert — but only **two** (`MAINTENANCE_MODE`,
`DISABLE_NEW_ORDERS`) actually stopped anything (`trading.ts`). The other **five had no enforcement
seam at all**: engaging them was theatre. A kill switch you cannot trust is worse than none.

**The fix.** `assertNotEngaged(db, KEY)` (already defined; throws **423 `KILL_SWITCH_ENGAGED`**) is
now wired as the first line of each authoritative chokepoint:

| Switch | Chokepoint (file) | Effect when engaged |
|---|---|---|
| `DISABLE_NEW_PURCHASES` | `platform/commerce.ts` `createPendingOrder` | no new commercial order is created |
| `DISABLE_PROVISIONING` | `platform/provisioning.ts` `provisionAccount` | no account provisions (new eval or funding) |
| `DISABLE_NEW_PAYOUT_REQUESTS` | `platform/payouts.ts` `requestPayout` | no new payout request is accepted |
| `DISABLE_PAYOUT_SUBMISSION` | `platform/payout-operations.ts` `submitPayable` | nothing submits to the settlement rail; APPROVED payouts stay owed + PAYABLE |
| `DISABLE_EXTERNAL_EXECUTION` | `execution/safety-gate.ts` `externalExecutionGate` (`killSwitchEngaged`) | no external order routes; SIMULATION unaffected |
| `DISABLE_NEW_ORDERS` | `trading.ts` (pre-existing) | no new/increasing exposure; risk-reducing routes stay open |
| `MAINTENANCE_MODE` | `trading.ts` (pre-existing) | trading entry blocked |

Notes: the guard defaults to *not-engaged* (no `kill_switches` row → false), so normal operation is
unchanged. `DISABLE_EXTERNAL_EXECUTION` guards a path that is itself **DISCONNECTED** today (external
execution has no production caller — only the safety gate, which only tests reach); the gate is made
switch-aware now so external routing is safe the day it is wired. Engaging `DISABLE_PROVISIONING`
also halts funding provisioning (an emergency freeze is meant to be total); the purchase path already
parks a blocked provision recoverably.

**Proof:** `apps/server/src/platform/kill-switch-enforcement.test.ts` (6 tests): each of the five
money/lifecycle switches rejects its chokepoint with `KILL_SWITCH_ENGAGED` when engaged and stops
blocking when released; SIMULATION passes the external gate even with the switch flagged; engage/
release round-trips for all seven switches.

**Still open (HTF-10):** the **console does not yet surface** engage/release controls — the System
page only GETs the switch/flag/alert state. The owner engages a switch via the API today. Fixing
that is a web-console task (buttons + the existing reauth flow), tracked as HTF-10.

---

## 3. Owner OS operational acceptance matrix

Legend: **PROVEN** (wired button→API→DB→audit, RBAC-gated) · **READ-ONLY** (truthful display, no
mutation intended) · **DISCONNECTED** (mutation exists server-side, no console control — HTF-10) ·
**OWNER-MANUAL** (operable only via API today).

All Owner-OS backend routes are correctly gated by `requirePermission` + `requireReauth`
(`http/owner-plugin.ts`; role re-read from DB — "UI hiding is never authorization"), mounted under
`/api/v1/admin(/ops)`. RBAC is real (demo TRADER is 403 on admin APIs).

| Capability | Server | Web console | Status |
|---|---|---|---|
| **Account ops** (pause/resume/disable/enable/adjust) | `platform/account-ops.ts`, `routes/owner-accounts.ts` | `AccountPage.tsx` | **PROVEN** — audited; adjustments append-only (no raw balance edit) |
| **Customer directory + 360** | `routes/admin.ts` `/customers`, `/customers/:id` | `CustomersPage.tsx` | **PROVEN** — search, detail, hold, review, re-verify, retry-provisioning, resend |
| **Payout ops** (economic + STP) | `routes/payouts.ts`, `routes/payout-ops.ts` | `PayoutsPage.tsx`, `PayoutOperationsPage.tsx` | **PROVEN** — approve/reject/hold + breaker/retry/reconcile/manual-resolution (rail mock/unconfigured — HTF-3) |
| **Enforcement** (cases/holds/appeals) | `routes/enforcement.ts` | `EnforcementPage.tsx` | **PROVEN** |
| **Support** (tickets/disputes/remediation) | support modules | `SupportPages.tsx` | **PROVEN** |
| **Affiliates** | affiliate modules | `AffiliatesPages.tsx` | **PROVEN** (payout provider unconfigured — HTF-9/DR-5) |
| **Product config** (versions/drafts) | `routes/profiles.ts` | Products page | **PROVEN** (authoritative model, immutable versions) |
| **Audit explorer** (search + chain verify) | `routes/admin.ts` `/audit`, `/audit/verify` | `AuditPage.tsx` | **PROVEN** |
| **Provider health / safety posture** | `routes/owner-io.ts` `providerStatuses` | `OwnerOsPages.tsx` "Providers (truthful)" | **READ-ONLY, truthful** (UNCONFIGURED/NOT_VERIFIED shown; a mock never reads "healthy") |
| **System Doctor / integrity / reconciliation** | `routes/owner-system.ts` (GET; `POST /system/full-test`) | `OwnerOsPages.tsx` | **PROVEN (read)** — display wired; `full-test` trigger not surfaced (OWNER-MANUAL) |
| **Kill switches** (engage/release) | `routes/owner-config.ts` → `kill-switches.ts` | `OwnerOsPages.tsx` (table only) | **DISCONNECTED** (HTF-10) — **but now ENFORCED when engaged (§2)** |
| **Feature flags** (toggle) | `routes/owner-config.ts` → `feature-flags.ts` | table only | **DISCONNECTED** (HTF-10) |
| **Alerts / incidents / jobs** (ack/resolve/create/transition/retry) | `routes/owner-alerts.ts`, `owner-io.ts` | read-only tables | **DISCONNECTED** (HTF-10) — OWNER-MANUAL via API |
| **Webhooks** | `routes/owner-io.ts` (GET) | not surfaced | **DISCONNECTED** |
| **Financial ops / money-trace / CSV exports** | `routes/owner-finance.ts` | not surfaced (only EconomicsV2 export is wired) | **DISCONNECTED** — OWNER-MANUAL via API |

**Verdict:** routine trader/money/lifecycle operations are fully console-operable without SQL or an
AI. The **emergency/safety plane and financial exports are operable only via API today** (HTF-10):
the controls exist, are RBAC-gated and audited, and — as of Phase 7 — the safety switches actually
take effect; they are simply not yet fronted by console buttons.

---

## 4. Deterministic evidence run (this acceptance)

All green except the two documented pre-existing failures; `NODE_ENV=test`:

| Suite | Result |
|---|---|
| HTF-21 self-serve boundary (`self-serve-boundary.test.ts`) | **6 passed** |
| Kill-switch enforcement (`kill-switch-enforcement.test.ts`) | **6 passed** |
| Commerce / provisioning / account-limit (chokepoint regression) | **all passed** |
| External safety gate (`production-infra` + torture) | **all passed** |
| **Phase 5 CORE 50K Golden Path regression** | **17 passed** |
| Server typecheck (`tsc --noEmit`) | **clean** |

Two **pre-existing** failures remain, both confirmed failing on a clean tree with this phase's
changes stashed (NOT Phase 7 regressions), tracked separately:
- `admin.test.ts > keeps the audit chain intact under concurrent actions on one account`
- `payout-operations.test.ts > provider events are append-only and idempotent on (provider, event id)`

---

## 5. What Phase 7 deliberately did NOT do

- Did not build the console UI for kill switches / feature flags / alerts / incidents / money-trace /
  exports (HTF-10 web surfacing) — that is a bounded follow-up (buttons + the existing reauth flow).
- Did not wire real payment / payout / KYC rails (Phases C/D/E).
- Did not change product rules, prices, or the account state machine.
- Did not fix the two pre-existing test failures (out of scope; logged).

---

## PROVENANCE

Compiled from a read-only Owner-OS control-plane map (routes under `/api/v1/admin(/ops)`, web
`apps/web/src/admin/**`, `platform/owner-*.ts`, `account-ops.ts`, `kill-switches.ts`,
`feature-flags.ts`), the HTF-21 chokepoint trace in `http/routes/trading.ts`, and the account-type
model in `db/schema.ts` + `@atlas/contracts`. Every capability status was checked against the actual
web call sites. The HTF-21 fix, the five kill-switch enforcement seams, and their tests were written
and executed for this acceptance. No real provider was connected; nothing is PRODUCTION-VERIFIED.
