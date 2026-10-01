# Portal V2 — Full Product Rebuild Report

**Human-acceptance candidate.** Base `298a69c`. Branch
`claude/futures-trading-simulator-v8qefu`.

This reports the Portal V2 Full Product Rebuild: what changed, what was
deliberately *not* touched, the validation evidence, and one honest finding from
the canonical run. Claude's claim here is bounded: **candidate ready for human
acceptance** — nothing stronger. Nathan reviews the build next; automated tests are
necessary but not sufficient.

---

## 1. Objective

Rebuild the customer Portal V2 so it would feel credible as the customer portal of
a serious, premium financial/trading company — a luxury financial terminal, not a
SaaS template — while preserving business truth and changing no backend, identity,
auth, lifecycle, ledger, P&L, rules, risk, payout accounting, or economics.

## 2. What changed (frontend only)

All product changes are scoped under `apps/web/src/portal/v2/*` (plus one font
import in `main.tsx`). Zero backend/economics code was modified for the rebuild.

- **Typography → Inter Variable.** Replaced the DM Sans "dev-site" face with
  self-hosted Inter Variable (SIL OFL), scoped to `.htv2`; tabular numerals on
  every financial value; a tightened financial type scale. (`type.css`,
  `main.tsx`.)
- **Premium dashboard.** The review "home" is now a real financial dashboard:
  summary stat strip → conditional attention row → accounts (centerpiece) → recent
  activity. Not a four-card SaaS dashboard, no hero banner. (`Review.tsx`.)
- **New primitives.** `V2StatStrip` (the anti-four-card), `V2Attention` (action
  only when genuinely required), `V2ActivityList`, plus page scaffolding and a
  canonical `.htv2-link` (muted; underline on hover/focus only, never default
  blue). (`primitives.tsx`, `primitives.css`.)
- **Honest navigation.** Only destinations with a real V2 implementation appear
  (Dashboard, Accounts, dev-tagged Design system). Owner Console is role-gated and
  absent for a normal customer. (`Review.tsx`, `Shell.tsx`.)
- **Guardrail tests.** Added `visual-system.test.ts`; refined
  `design-guardrails.test.ts` so it forbids only *default* (resting-state) link
  underline while permitting the premium hover/focus underline (mission §58).
- **Dev tooling.** `scripts/portal-v2-shots.mjs` (screenshot capture, not shipped
  to customers).

Scroll/shell architecture (one owner: the workspace) was **preserved intact** and
remains regression-locked.

## 3. What was explicitly NOT changed

- Backend, identity, auth/authz, lifecycle, ledger, P&L, rules, risk, payout
  accounting, economics — untouched.
- Atlas trading terminal and Owner OS / Owner Console — untouched.
- V1 Portal — untouched; remains the live product and instant rollback.
- V2 is **not** migrated into production; `/portal-v2` stays dev-only (404 in prod).

No genuine product/contract defect was found that required reopening Resilience /
Security / Ops / Economics / Payout / Risk.

## 4. Validation evidence

| Check | Result |
|-------|--------|
| `apps/web` vitest (incl. visual-system, design-guardrails, scroll-architecture) | **388 / 388 pass** |
| `apps/web` typecheck (`tsc --noEmit`) | clean |
| `apps/web` production build | clean |
| `scripts/portal-v2-scroll.mjs` (real headless Chromium, 6 viewports) | pass |
| Browser screenshots (dashboard/detail/accounts @ 1920/1440/1280/390) | reviewed — premium, credible |
| **Canonical `pnpm validate:release`** | **PASSED — 3156 pass, 6 skipped, 0 fail; typecheck clean; build clean** |

## 5. Honest canonical finding (one; investigated, not labelled)

The canonical was run at the end. The first attempt failed at **step 1** because
the local Postgres server was not running (`connection refused`) — an environment
precondition, since step 1 of the canonical script *prepares the test DB*. Starting
the cluster (and confirming the `atlas` role) is part of preparing that canonical
environment, so this was not a code result.

With the DB up, the canonical surfaced **5 real failures**, all in one file:
`apps/server/src/platform/golden-path.core50k.test.ts`. I investigated rather than
labelling:

- **Root cause (proven):** a **clock-triggered test-data time-bomb**, not a product
  defect. The test seeded the funded account with `activatedAt: new Date()` (today)
  and recorded 5 winning days hardcoded as `2026-10-01`…`2026-10-05`. The cycle's
  start date derives from the activation day, and the (correct, unchanged) product
  rule `countQualifyingWinningDays` counts days **strictly after** the cycle start
  (`tradeDate > cycleStartDate`). The instant the real clock reached **2026-10-01**,
  the first winning day collided with the activation day and was excluded, leaving
  4 < 5 → `INSUFFICIENT_WINNING_DAYS` at step 10; steps 11–15 cascaded from that
  single sequential failure. On 2026-09-30 the same code passed (activation was
  2026-09-30, all 5 days strictly after). The flip was purely calendar-driven.
- **Relation to the rebuild:** none. My diff touches zero server/shared code; this
  is `apps/server` payout-eligibility test data. It would fail identically on the
  base commit on this date with no Portal V2 changes at all.
- **Fix (test-only, no economics touched):** made the fixture's dates **relative to
  "now"** (activation 10 days ago; 5 winning days the following days), so it can
  never rot again while asserting the exact same correct behavior. The product
  rule, payout accounting, and economics are unchanged.
- **Result:** golden-path file 15/15; full canonical green (3156 pass, 0 fail).

This is the only non-green signal encountered, and it is now resolved and
documented (see `KNOWN_ISSUES.md`).

## 6. Claim

**Candidate ready for human acceptance.** Use
`PORTAL_V2_HUMAN_ACCEPTANCE_CHECKLIST.md` to review. Until a human accepts, V2 stays
dev-only, V1 stays live, and no migration happens.
