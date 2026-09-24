# Happy Trader Customer Portal — V1 (architecture)

The business/account relationship layer that sits beside Atlas (the trading
terminal). One ecosystem, one set of credentials, one server-authoritative source
of account identity and state. This document is the contract for the Customer
Portal + Trader Analytics + Account Lifecycle UX milestone; it is written before
implementation and builds on the systems the prior milestone shipped (customer
identity, commerce, entitlements, provisioning, funding, notifications, owner
console) — it does not fork them.

> Not a marketing site. Not native copy-trading. Not a market-data or
> live-capital milestone. Provider integrations remain mocked/seams from the
> prior milestone.

---

## 1. Product boundary

- **Portal** (`/portal`, new lazy web bundle): dashboard, accounts, account
  detail + analytics, payouts, achievements, billing, certificates, profile /
  verification / security / notifications, support entry shell. Behind the same
  sign-in as everything else.
- **Atlas** (existing terminal at `/`): charts, order entry, positions,
  execution. Gains a "← Happy Trader" path back to the portal.
- The portal provides a prominent **Trade in Atlas** action that opens Atlas with
  that account selected, server-authorized (never a blindly-trusted URL param).

Both surfaces read account identity/state from the **same server-authoritative
source** (`accounts`, `account_lifecycles`, the read model, and the new
portal read services). Nothing in the portal computes financial truth.

## 2. Reuse map (do not fork)

| Concern | Source |
| --- | --- |
| Auth principal, sessions, RBAC | `users`, `auth-plugin.ts` |
| Customer identity / verification / agreements | `customer_identities`, identity/agreements services (prior milestone) |
| Commerce / products / entitlements / provisioning | `commerce.ts`, `commerce-fulfillment.ts`, `provisioning.ts`, immutable `account_profile_versions` |
| Funding / certification | `commerce-certify.ts`, `approveFunding` |
| Payout engine | `payouts.ts`, `payout-core.ts`, `payout-queries.ts` (REUSE, do not rebuild) |
| Authoritative trade/exec data | `trades`, `executions`, `daily_account_stats`, `accounts` |
| Notifications / outbox / events / audit | `notifications.ts`, `events.ts`, `outbox.ts`, `audit.ts` |
| Owner console | `apps/web/src/admin/*` |

Net-new: account **nicknames**, the **five-active-account invariant**, **reset**
lifecycle, **funded inactivity** lifecycle, the **analytics** service + metric
registry, **certificates**, **achievements**, the portal web app, and the
portal-facing HTTP surface.

## 3. Navigation

Authenticated portal shell: **Dashboard · Accounts · Payouts · Achievements ·
Billing · Support** + a highly visible **TRADE / TRADE IN ATLAS**. Avatar menu:
Profile · Verification · Security · Notifications · Log Out. A consistent
**account switcher** (`N/5 active`, `+ Get Another Account`, "limit reached" at 5)
shared by portal and Atlas via the same server source.

Support is an entry/shell only this milestone (no ticketing backend).

## 4. Dashboard

Answers within seconds: what accounts, what state, how am I performing, how close
to passing / to a payout, what next, what happened recently. Top summary: Active
Accounts (`N/5`), Evaluations, Funded, Total Payouts (trader share), eligible
payout exposure. Then **Active Accounts** cards (nickname, immutable id, product
family, size, lifecycle state, balance, starting balance, net P&L, MLL/drawdown
state, profit-target progress for evals, consistency, winning-day progress,
payout eligibility, cycle count, available payout, **Trade Account** CTA) with a
contextual menu (Rename · View Details · Certificate · Archive/hide). Recent
activity from the audit/event stream. Truthful empty/loading/error states.

## 5. Account nicknames

`accounts.nickname` (net-new, nullable varchar). A per-account human label the
trader edits. **Never** affects accounting, audit, provisioning, entitlements,
trade ownership, or payout ownership — the immutable `publicId` (SIM-/HT-…)
stays authoritative. Renames are audited.

## 6. Five-active-account invariant (server-side)

A verified trader may have **at most five ACTIVE accounts** total (evaluation +
funded combined). "Active" = a `status`/lifecycle that is trade-capable and not
terminal (FAILED, COMPLETED, INACTIVE-closed, ARCHIVED do not consume a slot).
Enforced as a **server invariant**, not a UI convention:

- A single `assertActiveSlotAvailable(db, organizationId, userId)` helper counts
  active accounts under an advisory lock keyed by user, inside the transaction
  that would create the sixth.
- **Purchase/provisioning:** `fulfillPurchaseGated` checks the slot before
  provisioning; at 5 it parks the paid order (a distinct `PROVISION_BLOCKED`
  reason `ACTIVE_LIMIT_REACHED`) rather than creating a sixth — and checkout is
  blocked in the UI at 5 (server still authoritative).
- **Pass → funded:** the funded transition must not create a sixth. The passing
  evaluation is terminal (PASSED/QUALIFIED, frozen) at the moment funding is
  provisioned, so the funded account **replaces** the eval's slot; the transition
  is transactional and the invariant is re-checked under the lock.
- Concurrency: simultaneous purchases at 4, and simultaneous pass/provisioning,
  cannot produce 6 — proven by tests.

The portal shows `4/5 Active Accounts` or `5/5 — Account Limit Reached`.

## 7. Account detail

Per-account page (`/portal/accounts/:id`): header (size + family + nickname,
lifecycle state, immutable id, started date, **Trade in Atlas**), then sections:
Overview · Performance · Rules · Payout Progress · Analytics · Trades · Activity.
Rules use deterministic, centralized thresholds (Safe/Approaching/At Risk/
Breached) — see `account-lifecycle-ux-v1.md`.

## 8. Purchase another account

`+ Get Another Account` selects among the 10 immutable server products (Core
25/50/100/300 Gold, Select 25/50/100, Daily 25/50/100) via the existing commerce
checkout. 300K Gold uses restrained gold accents. Blocked at 5 active. Only a
verified server-side payment event provisions (prior-milestone property).

## 9. Reset / failed account

Terminal FAILED (MLL breach) accounts are never erased. The portal shows
**ACCOUNT BREACHED** with **Reset ($original price)** and **View Account**. Reset
price = the exact original product-version price (no discount). A confirmed reset
payment creates a clean new trading lifecycle/account (new immutable id) retaining
commercial provenance and the original immutable product version; idempotent and
concurrency-safe. Details in `account-lifecycle-ux-v1.md`.

## 10. Refunds

Ordinary purchase refund eligible **only while no trade has executed** on the
account (authoritative `has-traded` = existence of any `trades` row for the
account's lifecycle). Billing states this clearly. Duplicate/erroneous/incident
refunds remain a separate controlled owner remediation path (not this policy).

## 11. Payout center

Reuses the existing payout engine. Adds the portal UX (`payouts` page): total
payouts, paid count, eligible accounts; per account the profit, qualification,
winning days, consistency, the **50%-of-eligible-profit** withdrawal constraint,
product cap, protected buffer, available payout; request flow with CUSTOM and MAX
and a pre-confirmation breakdown (gross, trader share, firm share, resulting
balance, buffer). Statuses map to the engine. The 50% rule and caps interaction
are specified precisely in `account-lifecycle-ux-v1.md` §Payout.

## 12. Certificates & achievements

Event-driven, idempotent, privacy-controlled — see
`certificates-achievements-v1.md`.

## 13. Atlas handoff

`/portal/accounts/:id` "Trade in Atlas" → Atlas at `/?account=<publicId>`; Atlas
verifies ownership + trade-enabled + lifecycle server-side before selecting
(never trusts the param). Atlas shows a "← Happy Trader" link. The account
switcher is shared.

## 14. Analytics / performance

Deep trader analytics from authoritative server data — see
`trader-analytics-v1.md`. Efficient server-side queries (per-account aggregates,
`daily_account_stats`, downsampled time series), no N+1, no client-side financial
truth.

## 15. Responsive / accessibility / states

Portal works desktop/tablet/mobile (Atlas stays desktop-first). Semantic
structure, keyboard nav, focus states, contrast, SR labels, reduced-motion; never
color-only for risk state. Every page has truthful empty/loading/error states and
restrained premium celebration for pass/funded/payout/completed.

## 16. Copy-trading extension point (NOT built)

Native copy trading is the next milestone. Leave a clean boundary: the account
model already has master/follower-capable identity (one owner, many accounts
within the 5-limit); no speculative execution here.

## 17. Testing & acceptance

Unit (analytics formulas, visibility rules, invariant math), property/invariant
(≤5 active, terminal cannot trade, exactly-once certificate/achievement, reset
never mutates history), DB/concurrency (no 6th account under races, duplicate
reset → one replacement, duplicate payout-paid → one certificate), HTTP/authz
(no cross-trader analytics/certificate/billing leakage, public certificate
exposes only allowed data, switcher cannot select foreign account), and a real
browser acceptance with deterministic seed data. Details in each sibling doc.
