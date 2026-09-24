# Account Lifecycle UX — V1 (states, reset, inactivity, payout semantics)

The authoritative account lifecycle the portal presents, and the precise
semantics for the new transitions this milestone adds: reset, funded inactivity
closure, the five-payout completion, and the payout withdrawal math. Builds on
the existing rule engine, commercial lifecycle, and payout engine — it does not
recreate their math.

---

## 1. Lifecycle states (portal vocabulary → authoritative source)

| Portal state | Source of truth | Consumes an active slot? |
| --- | --- | --- |
| PENDING / PROVISIONING | order/provisioning status | no (until ACTIVE) |
| EVALUATION — ACTIVE | `accounts.status=ACTIVE`, type EVALUATION | **yes** |
| EVALUATION — PASSED (frozen) | `status=PASSED`, `adminHold=QUALIFIED` | transient (becomes funded) |
| FUNDED — ACTIVE | type FUNDED_SIM, `status=ACTIVE` | **yes** |
| FAILED / BREACHED | terminal lifecycle `endReason` breach | no |
| COMPLETED — MAX PAYOUTS | new: 5 approved/paid cycles | no |
| INACTIVE — CLOSED | new: funded inactivity closure | no |
| ARCHIVED (hidden) | presentation-only user flag | no |

"Active" (for the five-account invariant) = ACTIVE evaluation or ACTIVE funded.
Terminal states (FAILED, COMPLETED, INACTIVE-CLOSED, ARCHIVED) never trade and
never consume a slot. A frozen PASSED evaluation is replaced by its funded
account in the same transaction (§invariant in `customer-portal-v1.md` §6).

## 2. Rule status (deterministic, centralized)

Thresholds live in one module (`platform/rule-status.ts`), never scattered:
- **Maximum Loss Limit / floor**, current balance, **headroom** = balance − floor.
- **Contract limit** (from product rules), current exposure (read model).
- **Consistency** = best-day / total, vs the product's threshold.
- Status bands (documented constants): **Safe** (headroom > 25% of MLL distance),
  **Approaching** (10–25%), **At Risk** (< 10%), **Breached** (≤ 0). Consistency
  bands similarly. No arbitrary warnings without a deterministic threshold.
Never communicated by color alone (icon + label + text).

## 3. Reset semantics

Trigger: an evaluation lifecycle ends FAILED (MLL breach; authoritative rule
engine). Portal shows ACCOUNT BREACHED + **Reset ($original)**.

- **Reset price** = the exact original purchase price of that account's immutable
  product version (`config.display.priceMicros`). No discount.
- Reset is a **commerce purchase** (source `RESET`) through the existing commerce
  path: a pending RESET order → verified server-side payment → a new trading
  lifecycle/account provisioned from the **original immutable product version**,
  new immutable id, retaining commercial provenance (linked to the failed
  account). The failed account is **never erased** — it stays in Account History.
- Idempotent + concurrency-safe: a duplicate reset payment event creates exactly
  one replacement (order + entitlement + provisioning idempotency keys, as for a
  normal purchase). Subject to the five-active-account invariant (a reset creates
  a new active account; the failed one is terminal and freed its slot).
- The reset relationship is recorded (`accounts.resetOfAccountId`, net-new
  nullable FK) for History and audit. A reset is **not** a trading loss and does
  not appear on the trading-performance equity curve.

## 4. Funded inactivity closure (calendar-month)

Policy: a funded account must record qualifying trading activity within the
required calendar-month window. Deterministic definition (documented):

- The window is a **calendar month** in the exchange timezone
  (America/Chicago), anchored to the account's `activatedAt`. "Qualifying
  activity" = at least one `trades` row with `tradeDate` in the current calendar
  month (or since activation for the first month).
- **Warnings** (deterministic scheduling, before closure): an in-app + email
  (+ SMS if enabled) warning when the month is N days from ending with no
  qualifying activity. Warnings never change the policy.
- **Closure:** when a calendar month completes with no qualifying activity, the
  account transitions to **INACTIVE — CLOSED** (permanent, no free reactivation),
  preserved in History. Never silently deleted. Implemented as an idempotent
  scheduled sweep (event/audit recorded), reusing the outbox/notification and
  audit infrastructure.

## 5. Payout withdrawal semantics (extends the existing engine)

The existing payout engine (`payout-core.ts`, `payouts.ts`) stays authoritative
for eligibility, the 90/10 split, protected buffer, ledger, and the one-time
balance debit at APPROVED. This milestone adds two constraints at the **request
ceiling** (the max a trader may request), composed with — not layered against —
the existing math:

Let, for a funded account:
- `eligible = grossWithdrawableMicros` (existing: balance − starting − buffer, ≥0).
- `productCap` = the launch cap by size: **25K=$1,000, 50K=$2,000, 100K=$3,500,
  300K Gold=$5,000** (from `payoutRules.requestCaps`, updated to these values).
- `fiftyPct = floor(0.5 × eligible)` — **at most 50% of current eligible profit
  above the funded starting balance**, after the protected buffer.

**Available maximum = min(eligible, productCap, fiftyPct)**, then bounded below by
the product's `minRequestMicros`. This is a ceiling on the **requested gross**;
the existing split then derives trader share (90%) and firm share (10%), and the
existing APPROVED debit moves the balance by the gross. No double counting:
previous payout debits already reduced the balance, so `eligible` (balance-based)
already reflects them; the 50% and cap apply to that same post-buffer eligible
figure. Documented and tested against the existing accounting separation (gross
requested vs trader share vs firm share vs balance debit).

Where the new 50% rule or the new caps conflict with existing defaults, the
product-version `payoutRules` are updated (immutable, new version) with tests —
never contradictory math layered on top.

## 6. Five-payout funded completion

A funded account has a maximum of **five approved/paid payout cycles**. When
payout #5 reaches the authoritative completion point (paid), the account
transitions to **COMPLETED — MAX PAYOUT CYCLES REACHED** (not FAILED), trading
disabled, moved to History, a final completion certificate issued. Exactly-once
(idempotent on the fifth cycle's completion event). The portal shows total
payouts, original purchase cost, `5/5`, and a **multiplier** return metric:

`multiple = total trader share paid / original account purchase cost` — phrased
as "N× your original account cost returned in payouts" (trader share, documented;
not gross, not labelled investment/securities ROI).

## 7. Audit & events

Every lifecycle transition (purchased, provisioned, reset, passed, funded,
breached, inactivity-closed, payout eligible/requested/paid, completed,
certificate issued, achievement issued) is audited and evented via the existing
immutable audit/outbox/events architecture. UI state is never authoritative.

## 8. Remediation

Never a generic admin "edit balance". Incident/remediation remains a controlled,
audited owner action; account history/activity is shaped to carry future
remediation events. No incident-management system built here.
