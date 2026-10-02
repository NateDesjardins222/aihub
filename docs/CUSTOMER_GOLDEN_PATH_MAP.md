# Customer Golden Path — Connectivity Map

**Phase:** Customer Golden Path — Phase 1 (Lifecycle Connection + Customer Experience).
**Branch:** `claude/futures-trading-simulator-v8qefu`. **Baseline:** `f903424` (tag `customer-golden-path-phase1-start`).
**Method (§4):** every claim below is traced from code, not assumed. File:line anchors are given; where a
transition is less than fully CONNECTED, the exact missing wire is named with its file:line.

## Authoritative spine (what the whole map derives from)

- **Account state is a free `varchar(20)` string, not a pg enum.** The single authoritative stage-derivation
  is the pure function `portalState(account)` at `apps/server/src/platform/portal-accounts.ts:52-69`. It maps
  `(accountType, status, archivedAt)` → one of `PENDING | EVALUATION_ACTIVE | EVALUATION_PASSED | FUNDED_ACTIVE
  | FAILED | COMPLETED_MAX_PAYOUTS | INACTIVE_CLOSED | ARCHIVED`. There is **no stored lifecycle-state column**
  and **no `GET /portal/lifecycle-state` endpoint**. Every surface must derive stage from this one function.
- **Status values** consumed by `portalState`: `PENDING | ACTIVE | PASSED | FAILED | COMPLETED | INACTIVE`
  (+ `archivedAt` overlay). A breach is **`status='FAILED'` + `failedReason`** — there is **no `BREACHED`
  status**. `accountType` ∈ `PRACTICE | EVALUATION | FUNDED_SIM`.
- **Lifetime paid trader-share** has one source: `cumulativeTraderShareMicros(db, userId)` at
  `apps/server/src/platform/achievements.ts:108-114` (SUM `payout_requests.trader_share_micros` WHERE
  `state='PAID'`). Progress hero and clubs both read it from the **same** `progress.ts:69` call. No surface
  recomputes it.
- **Recognition** (certs + achievements) is one bystander subscriber:
  `apps/server/src/platform/recognition.ts` (`registerRecognition` line 200-214), driving off the four
  lifecycle events it filters at lines 203-206.
- **Notifications** are one bystander consumer: `registerNotificationConsumer`
  (`apps/server/src/platform/notifications.ts:300-398`), a `switch (event.type)` at lines 310-394.
- **Celebrations** are authoritative + idempotent, driven entirely off `achievements` rows:
  `apps/server/src/platform/celebrations.ts` → `GET /api/v1/portal/celebrations` + `.../ack`.

Legend: **CONNECTED** = end-to-end wired and exposed to the customer. **PARTIAL** = the lifecycle advances and
the customer can still progress, but one declared side-effect (usually a proactive notification) does not fire.
**DISCONNECTED** = the customer-facing surface shows synthetic/placeholder data instead of the authoritative
record. **BROKEN** = the transition does not occur.

---

## Transition 1 — PURCHASE → ENTITLEMENT · **CONNECTED**

- **Source of truth:** `commercial_orders` + `entitlements` tables.
- **Service:** completed-order → entitlement fulfillment in `apps/server/src/platform/commerce*.ts`
  (unified fulfillment path, Checkpoint E/§99). Idempotent on the commerce event (dedup).
- **Event:** `entitlement.provisioned` (`events.ts`).
- **Notification:** consumer `case 'entitlement.provisioned'` → enqueues `PURCHASE_CONFIRMED` **and**
  `EVAL_READY` (`notifications.ts:324-328`).
- **Failure state:** commerce fail-closed (P4); refund/dispute handled via `commerce.refunded` /
  `commerce.dispute_opened` consumer cases (`notifications.ts:340-348`).
- **Customer surface:** entitlement drives provisioning (Transition 2); the customer sees the resulting account.

## Transition 2 — ENTITLEMENT → ACCOUNT PROVISIONED · **CONNECTED**

- **Service:** gated auto evaluation provisioning (`provisioning.ts`, Checkpoint F/G). Recoverable
  `PROVISIONING_BLOCKED` / `PROVISIONING_FAILED` states exist and are operator-recoverable.
- **DB:** a new `accounts` row, `accountType='EVALUATION'`, `status='PENDING'` then `ACTIVE`.
- **Customer surface:** `portalState` returns `PENDING` (label "Provisioning",
  `account-view.ts:35`) until active.

## Transition 3 — ACCOUNT PROVISIONED → EVALUATION · **CONNECTED**

- An `EVALUATION` account with `status='ACTIVE'` derives `portalState='EVALUATION_ACTIVE'`
  (`portal-accounts.ts:65-67`). Profit-target progress is authoritative
  (`account-view.ts:174-185`, reads `profitTargetMicros`). Trading is gated server-side by the handoff route,
  not by the portal.

## Transition 4 — EVALUATION → QUALIFICATION / PASSED · **CONNECTED** (celebration sub-path PARTIAL — by design)

- **DB/derivation:** `status='PASSED'` → `portalState='EVALUATION_PASSED'` (`portal-accounts.ts:57-58`).
- **Event:** `evaluation.qualified`.
- **Notification:** consumer `case 'evaluation.qualified'` → `EVAL_PASSED` (`notifications.ts:330-333`).
- **Recognition:** issues the `EVALUATION_PASSED` **certificate**, and deliberately issues **no achievement**
  for the pass (`recognition.ts`), so there is **no pass celebration** — the first celebration is deferred to
  FUNDED (Transition 5). This is an intentional product choice, not a break; recorded here as a **PARTIAL
  celebration sub-path** and addressed in Phase-1 experience work by giving the pass its own in-portal
  lifecycle moment without inventing an authoritative achievement.
- **Presentation defect (WEB-1):** `EVALUATION_PASSED` and `FUNDED_ACTIVE` are visually conflated — see
  "Web presentation gaps" below.

## Transition 5 — QUALIFICATION → FUNDED ACCOUNT · **CONNECTED**

- **Service:** `evaluation.qualified` subscriber → `approveFunding`, **exactly-once** (Checkpoint H/§157).
- **DB:** a new `FUNDED_SIM` account linked to the qualification; `status='ACTIVE'` →
  `portalState='FUNDED_ACTIVE'` (`portal-accounts.ts:65-67`).
- **Event:** `account.funded`.
- **Notification:** consumer `case 'account.funded'` → `FUNDED_READY` (EMAIL+SMS)
  (`notifications.ts:335-338`, channels at `:82`).
- **Recognition:** `FUNDED_TRADER` certificate **and** `FUNDED` achievement (`recognition.ts:91-102`) → drives
  the **FUNDED celebration** (`celebrations.ts` CELEBRATION_CONFIG, priority 70).

## Transition 6 — FUNDED → PAYOUT ELIGIBILITY · **PARTIAL** (missing event producer — **GAP-B**)

- **What works:** eligibility is **computed on-demand** from authoritative winning-days / consistency and is
  shown on the Payouts surface and in each funded account's metrics (`account-view.ts:119-124`, enriched from
  `PayoutEligibility`). The customer **can** see eligibility and request a payout. The notification **consumer**
  exists: `case 'payout.eligibility_unlocked'` → `PAYOUT_ELIGIBLE` (`notifications.ts:350-351`), the
  notification type/template/channel all exist (`notifications.ts:37,83,140`).
- **The gap (GAP-B):** **nothing publishes `payout.eligibility_unlocked`.** The event type is declared
  (`events.ts:49`) and consumed (`notifications.ts:350`) but has **no producer** anywhere in
  `apps/server/src` (verified: the only non-test references are the type union and the consumer). So the
  **proactive "you're now eligible" email never fires.** Eligibility is purely pull/compute-on-demand.
- **Decision:** building a transition-detector producer (not-eligible → eligible) is net-new stateful breadth
  with real idempotency risk, and eligibility is already truthfully visible on demand. Phase 1 therefore
  **surfaces eligibility prominently via the Next Up engine** (so the customer is actively guided to it) and
  **records GAP-B as a known issue (P2)** rather than building the producer. No customer is blocked.

## Transition 7 — ELIGIBILITY → PAYOUT REQUEST · **CONNECTED**

- `POST /api/v1/payouts/requests` creates a `payout_requests` row in `REQUESTED`.
- **Event:** `payout.requested` → `PAYOUT_REQUESTED` (`notifications.ts:353-354`).

## Transition 8 — REQUEST → PAYOUT REVIEW · **CONNECTED**

- Economic `PayoutState` (`payouts.ts:64-72`) + operational `OpState` overlay (`payout-operations.ts:40-42`)
  with `customerSafeFor()` projection so operational detail is never leaked. Owner Payouts center drives it.
- Events: `payout.approved` / `payout.submitted` / `payout.exception` / `payout.failed` / `payout.returned`
  each have a consumer case (`notifications.ts:356-373`).

## Transition 9 — REVIEW → PAID · **CONNECTED** (truthfulness guard verified)

- **Service:** `markPaid` (`payouts.ts:586-616`): sets the request `PAID`.
- **Event:** `payout.paid` → `PAYOUT_PAID` (EMAIL+SMS) (`notifications.ts:359-360`).
- **Guard verified:** a `REQUESTED` / `UNDER_REVIEW` payout is **never** presented as `PAID` — customer-facing
  payout state comes from the authoritative `state` and the `customerSafeFor` projection, not from a client
  guess. (No "optimistic PAID" path exists.)

## Transition 10 — PAID → LIFETIME-PAID / PROGRESS · **CONNECTED**

- `cumulativeTraderShareMicros` (`achievements.ts:108-114`) is the single source; Progress hero and clubs read
  it from the same `progress.ts:69` call, exposed at `GET /portal/progress`. No double-counting possible.

## Transition 11 — PAID → CERTIFICATE · **CONNECTED**

- `payout.paid` recognition issues the `PAYOUT` certificate (`recognition.ts:103-172`), visible in the
  Certificate Vault (`GET /portal/certificates`).

## Transition 12 — PAID → CLUB / ACHIEVEMENT · **CONNECTED**

- `CLUB_MILESTONES` (`achievements.ts:47-57`) evaluated against cumulative paid trader-share; `TENK_CLUB` /
  `FIFTYK_CLUB` / `HUNDREDK_CLUB` + `PAID_5K/10K/25K` achievements issued by recognition on `payout.paid`,
  driving tiered celebrations (`celebrations.ts`, priorities 25-100).

## Transition 13 — 5th PAID → ACCOUNT COMPLETION · **PARTIAL** (missing notification case — **GAP-A**)

- **What works:** at the fifth `PAID` cycle, `markPaid` marks the account `status='COMPLETED'` and publishes
  `account.completed` (`payouts.ts:578,599,604,613`). `portalState='COMPLETED_MAX_PAYOUTS'`
  (`portal-accounts.ts:61-62`). Recognition issues the `ACCOUNT_COMPLETED` **certificate**, the
  `ACCOUNT_COMPLETED` **achievement**, and the `FIVE_PAYOUT_CLUB` achievement (`recognition.ts:173-189`) →
  drives the **completion celebration** (priority 90). Trading is correctly disabled for `COMPLETED`
  (`trading/risk.ts:115-134`: only `ACTIVE | GOAL_REACHED` may trade). `COMPLETED` ≠ breach.
- **The gap (GAP-A):** the `ACCOUNT_COMPLETED` **email/SMS never enqueues.** The notification type
  (`notifications.ts:54`), channel policy (`:100`, EMAIL+SMS) and template (`:180-184`) all exist, but the
  consumer `switch` (`notifications.ts:310-394`) has **no `case 'account.completed'`** — so the fully-defined
  completion notification is dead code.
- **Decision:** this is a real disconnected lifecycle chain with a trivial, low-risk root-cause fix — add the
  missing consumer case, mirroring `case 'account.funded'` exactly (identity already resolves from
  `event.accountId` via `identityIdFor`). **Fixed in Phase 1 (task #413).**

---

## Web presentation gaps (customer coherence, not business-rule breaks)

- **WEB-1 — PASSED-vs-FUNDED visual conflation (fix in Phase 1 experience work).**
  `STATE_PRESENTATION` gives both `EVALUATION_PASSED` and `FUNDED_ACTIVE` `kind:'funded'`
  (`account-view.ts:37-38`) — same status colour — and `lifecycleActiveIndex` collapses both to stage index 1
  ("Funded") (`Lifecycle.tsx:26-28`). A just-passed account that is not yet a live funded account reads as
  identical to an active funded account. These are the same adapter facts duplicated in
  `account-detail-view.ts`. Hard-question #4 requires these be distinct.
- **WEB-2 — No single lifecycle view model / Next Up engine.** Stage and metric logic is re-derived
  independently in `dashboard.tsx` (stat strip re-reads raw `a.status`), `AccountsView.tsx` (`FILTERS` /
  `ACTIVE_STATES` diverge from the Dashboard's active list), and `account-view.ts`. There is no single
  "where am I / what's next" model and no deterministic single-next-action engine. Built in task #414.
- **WEB-3 — Billing DISCONNECTED from order provenance.** `CanonicalBilling`
  (`containers.tsx:277-290`) synthesizes one order row per account with `state` hard-coded `'PAID'`,
  `amountMicros = startingBalanceMicros` (the account **size**, not the price paid), and
  `totalSpentMicros: 0`. The authoritative `commercial_orders` / `entitlements` records are not surfaced.
  Showing the account size in an "amount" column is misleading. Addressed in task #415 (connect to real
  order/entitlement provenance where a customer-safe endpoint exists; this also prepares for — but does **not**
  begin — Whop).
- **WEB-4 — Support has no lifecycle context association.** `support.tsx` has no account / payout / order
  association field despite the experience claim of context. Addressed in task #415.
- **WEB-5 — Dashboard portfolio series is empty (NOT a defect).** `containers.tsx:137-138` renders `series: []`
  with an explicit truthful comment ("Never a fabricated curve") because there is no authoritative
  portfolio-level roll-up endpoint; per-account performance lives in Account detail. This is ERROR≠ZERO-correct
  and is an opportunity, not a violation.

## Summary table

| # | Transition | Status | Evidence / missing wire |
|---|------------|--------|-------------------------|
| 1 | Purchase → Entitlement | CONNECTED | `notifications.ts:324-328` |
| 2 | Entitlement → Provisioned | CONNECTED | `provisioning.ts`; recoverable BLOCKED/FAILED |
| 3 | Provisioned → Evaluation | CONNECTED | `portal-accounts.ts:65-67` |
| 4 | Evaluation → Passed | CONNECTED (celebration PARTIAL by design) | `portal-accounts.ts:57-58`; no pass achievement |
| 5 | Qualification → Funded | CONNECTED | `recognition.ts:91-102`; celebration prio 70 |
| 6 | Funded → Eligibility | **PARTIAL (GAP-B)** | consumer `notifications.ts:350`; **no producer** of `payout.eligibility_unlocked` |
| 7 | Eligibility → Request | CONNECTED | `POST /payouts/requests`; `notifications.ts:353-354` |
| 8 | Request → Review | CONNECTED | `payout-operations.ts:40-42`; `customerSafeFor` |
| 9 | Review → Paid | CONNECTED | `payouts.ts:586-616`; REQUESTED≠PAID guarded |
| 10 | Paid → Lifetime/Progress | CONNECTED | `achievements.ts:108-114`; `progress.ts:69` |
| 11 | Paid → Certificate | CONNECTED | `recognition.ts:103-172` |
| 12 | Paid → Clubs | CONNECTED | `achievements.ts:47-57`; celebrations 25-100 |
| 13 | 5th Paid → Completion | **PARTIAL (GAP-A)** | cert+achievement+celebration+trading-disable all wired; **no `case 'account.completed'`** in notification consumer |

## Phase-1 repair plan (what this map authorizes)

1. **GAP-A (root-cause, low-risk):** add `case 'account.completed'` → `ACCOUNT_COMPLETED` to the notification
   consumer (`notifications.ts`), mirroring `account.funded`. (task #413)
2. **GAP-B (documented P2):** surface eligibility via the Next Up engine; do not build a risky event producer.
3. **WEB-1:** give `EVALUATION_PASSED` a distinct colour/label and a distinct lifecycle position from
   `FUNDED_ACTIVE`. (task #416)
4. **WEB-2:** one deterministic lifecycle view model + Next Up engine, consumed by every surface. (task #414)
5. **WEB-3 / WEB-4:** Billing order provenance + Support lifecycle association. (task #415)

**Nothing in this map changes an authoritative business rule.** All repairs connect or present existing
authoritative state.
