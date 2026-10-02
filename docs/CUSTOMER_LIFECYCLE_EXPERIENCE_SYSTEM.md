# Customer Lifecycle Experience System

**Phase:** Customer Golden Path — Phase 1. **Branch:** `claude/futures-trading-simulator-v8qefu`.

This is the deterministic system that turns authoritative lifecycle state into ONE coherent Happy Trader
customer experience. It answers, on every surface, the five questions: **Where am I? What have I accomplished?
What requirements remain? What happens next? What can I do right now?** — without ever inventing business state
and without a single word of casino/urgency language.

## 1. The authoritative boundary

Two pure, deterministic adapters sit between server-authoritative data and the presentation. Neither decides a
business rule; both only format, derive presentation, and pick what to show.

- **`apps/web/src/portal/v2/account-view.ts` — `toAccountView`.** One account's authoritative
  `(portalState, balances, profit target, eligibility extras)` → a dense, state-aware card view. Maps
  `portalState` (never recomputes pass/fail), subtracts/formats money for display only.
- **`apps/web/src/portal/v2/lifecycle-model.ts` — `buildLifecycleView`.** The customer's whole account set →
  the overall lifecycle phase, per-state counts, accomplishments, and the **Next Up** engine. Pure, no
  `Date.now`, no randomness, fully unit-tested (`lifecycle-model.test.ts`, 11 cases).

Both are the single source every surface reads. Before Phase 1 the Dashboard, Accounts list and account adapter
each re-derived stage independently and diverged; now the Dashboard's command center, stat strip and phase
header all come from `buildLifecycleView`.

## 2. The Next Up engine (the single most important next action)

`buildLifecycleView` produces one `NextUpAction` (`nextUp`) plus a ranked `queue`. Each account contributes at
most one forward-progress candidate; the engine picks the highest priority, breaking ties deterministically by
account `createdAt` then `id`. Priorities (higher = surfaced first):

| kind | priority | tone | when |
|------|----------|------|------|
| `REQUEST_PAYOUT` | 100 | action | a funded account is eligible (available > 0 / ELIGIBLE) |
| `FUNDING_IN_PROGRESS` | 85 | info | an evaluation PASSED, funded account activating |
| `PROVISIONING` | 70 | info | an account is PENDING |
| `FUNDED_PROGRESS` | 60 | progress | funded, building winning days toward payout |
| `EVALUATION_PROGRESS` | 55 | progress | evaluation active, profit-target standing |
| `GET_STARTED` | 40 | action | no accounts, or only terminal ones |
| `VIEW_PROGRESS` | 30 | info | nothing in flight but accomplishments exist |

Every string is truthful and restrained. A test asserts no copy ever matches
`/trade now|keep the streak|make it back|one more trade|don't miss out|increase size/`. Breaches are **not** a
Next Up action — the dashboard's dedicated breach banner owns them, so the forward action and the
attention-needed banner never contradict.

## 3. Overall phase

`derivePhase` returns the customer's single current position:
`PAYOUT_READY > FUNDED > QUALIFIED > EVALUATION > ESTABLISHED > DORMANT > ONBOARDING`. The live forward state
wins; `ESTABLISHED`/`DORMANT`/`ONBOARDING` only apply when nothing is in flight. The Dashboard header shows the
phase label (eyebrow) + a truthful one-line summary.

## 4. The Dashboard as command center

`dashboard.tsx` now leads with `NextUpCommand` — the single next action, rendered with hierarchy (the `action`
tone carries the rose/champagne aura; `progress`/`info` are restrained). The stat strip's counts
(`active`, `evaluations`, `funded`) come from `lifecycle.counts`, not a local re-derivation. The positive
"payout available" prompt moved into Next Up; the negative breach banner stays separate.

## 5. The PASSED-vs-FUNDED distinction (WEB-1)

A just-passed evaluation is no longer visually identical to a live funded account:

- **Status colour:** `EVALUATION_PASSED` now uses a dedicated `passed` status kind in champagne
  (`--ht-champagne`), distinct from `funded`'s positive green. (`primitives.tsx` / `primitives.css`,
  `account-view.ts`, `account-detail-view.ts`.)
- **Lifecycle rail:** `lifecycleActiveIndex('EVALUATION_PASSED')` is `0` (Evaluation fully reached), one short
  of `FUNDED_ACTIVE`'s `1`. `V2Lifecycle` marks the Funded stage as *incoming* (`is-next`, a hollow champagne
  ring) for a passed account — never as reached. (`Lifecycle.tsx` / `Lifecycle.css`.)
- **Next Up:** "Evaluation passed — activating your funded account" (info), distinct from an active funded
  account's payout-progress copy.

## 6. Lifecycle moments (authoritative celebrations)

Celebrations remain entirely authoritative and idempotent, driven off `achievements` rows via
`GET /portal/celebrations` (server `celebrations.ts`, client `experience-celebration.tsx`). Phase 1 did not add
or invent any achievement. The premium pass moment is presentation-only (rose status + incoming rail + Next Up
copy); the first authoritative celebration is still FUNDED (priority 70), then the clubs and completion tiers.
No celebration fires for placing/winning a trade, a contract-size change, or loss recovery.

## 7. Billing provenance (WEB-3)

Billing now reads **real** `commercial_orders` via `GET /portal/orders`
(`apps/server/src/platform/portal-billing.ts`): product name, the authoritative amount (or `null` — never the
account size as a fake price), a customer-safe money state (`PAID | PENDING | REFUNDED | CANCELLED`), and the
account the order's entitlement provisioned. `totalSpent` sums only settled amounts; refunds never count. Strictly
owner-scoped. Tested in `portal-billing.test.ts` (3 cases, incl. owner-isolation and refund mapping).

## 8. Design tokens used

All new surfaces use existing Experience-System tokens — no new palette. Command center and lifecycle-incoming
states use `--ht-champagne` / `--ht-champagne-soft` (the rose-gold champagne family), restrained glow, and the
existing `htv2-aura` for the action tone. Radii use `--ht-radius-lg` (the design-guardrail cap is 8px; verified
by `design-guardrails.test.ts`). Progress bars are fully-round pills. Reduced-motion is respected
(`prefers-reduced-motion` disables the command bar transition).

## 9. What this system does NOT do

It never invents business rules, never fabricates zero-as-authoritative (empty portfolio series renders an
honest empty state, never a drawn curve), never shows REQUESTED as PAID, and never uses manipulative language.
It presents authoritative truth, coherently.
