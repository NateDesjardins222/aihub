# Portal V2 — Human Acceptance Checklist

**Portal V2 Full Product Rebuild** (base `298a69c`). Automated tests are necessary
but **not sufficient**: Nathan's physical review is authoritative. This is the
checklist for that review. Claude's self-assessment is a *candidate* — nothing
stronger.

## How to open the build

1. `pnpm --filter @atlas/web dev` → http://localhost:5173
2. Open **`/portal-v2`** (dev-only; a production build 404s here).
3. Customer view is the default. For the owner variant, append `?role=owner`.

Routes to walk:
- `/portal-v2` — Dashboard
- `/portal-v2/accounts` — Accounts list
- `/portal-v2/accounts/f-eval` (or any card's "View details") — Account Detail + tabs
- `/portal-v2/dev/design-system` — component showcase (dev-only, tagged `DEV`)

---

## A. First impression (the credibility test)

- [ ] Does it feel like the customer portal of a **serious, premium** financial /
      trading company — not a SaaS template or a dev site?
- [ ] Near-black layered canvas, restrained 1px borders, deliberate density?
- [ ] Typography reads premium (Inter), numbers are clean and column-aligned?
- [ ] Champagne is restrained and tasteful — brand mark, active tab, progress,
      primary button — never a glow or a gold wash?

## B. Information architecture & honesty

- [ ] Dashboard answers "where do I stand?" at a glance (summary → attention →
      accounts → activity)?
- [ ] Accounts are the centerpiece, not buried under hero chrome?
- [ ] The attention row appears **only** when something genuinely needs action
      (e.g. a breached account), and is quiet when nothing does?
- [ ] Navigation shows **only** destinations that actually work — no dead links,
      no "coming soon" stubs (Payouts/Certificates/etc. are omitted, not faked)?
- [ ] No fabricated data presented as a live session — the dev note is visible?

## C. Account detail

- [ ] Headline balance + status + Trade reads like a private-banking statement?
- [ ] Tabs (Overview / Performance / Controls / Rules / Activity) switch cleanly,
      active tab marked by the champagne underline?
- [ ] Metric rows (thin separators, right-aligned tabular numbers) — not nested
      cards?
- [ ] Evaluation progress bar is accurate and restrained?
- [ ] P&L / balance tones: positive green, negative red, correct signs?

## D. Owner Console gating (security-adjacent)

- [ ] As a normal customer (`/portal-v2`), is the Owner Console **completely
      absent** from the sidebar — not greyed, not hidden, not present in the DOM?
- [ ] With `?role=owner`, does an owner-appropriate entry appear, and does the
      `/portal-v2/owner` route honestly point to the real `/admin` console rather
      than render a fake owner product?

## E. Scroll & layout (the hotfix must stay fixed)

- [ ] The **workspace** scrolls; the page/body does not. Bottom content is
      reachable at every size.
- [ ] No page-level horizontal scrollbar at any width.
- [ ] No scroll traps; a fresh page starts at the top.
- [ ] Sidebar scrolls independently if it ever overflows.

## F. Responsive

- [ ] At phone width (390px): sidebar → top strip; stat strip → 2×2; account
      panels stack full-width; attention row wraps; still no horizontal overflow.
- [ ] Large money (e.g. $1M+ total balance) renders cleanly without clipping.

## G. Discipline (the "nevers")

- [ ] No purple primary, no default blue underlined links.
- [ ] No glassmorphism, no emoji, no fake charts, no giant CTAs.
- [ ] No four-card SaaS dashboard; no giant welcome banner.
- [ ] Links underline only on hover/focus, never by default.

## H. What must still be true (untouched)

- [ ] Atlas terminal and Owner OS look and behave exactly as before.
- [ ] V1 Portal is untouched and remains the live product (instant rollback).
- [ ] No backend / lifecycle / ledger / rules / risk / payout behaviour changed.

---

## Automated gate (necessary, not sufficient)

| Check | Status |
|-------|--------|
| `apps/web` vitest (incl. visual-system, design-guardrails, scroll-architecture) | 388/388 pass |
| `apps/web` typecheck (`tsc --noEmit`) | clean |
| `apps/web` build | clean |
| `scripts/portal-v2-scroll.mjs` (real headless Chromium, 6 viewports) | pass |
| `pnpm validate:release` (canonical) | see `PORTAL_V2_REBUILD_REPORT.md` |

## Acceptance decision (human)

- [ ] **Accepted** — migrate V2 toward production (separate, authorized change).
- [ ] **Accepted with changes** — list them below.
- [ ] **Not accepted** — list blockers below.

> Until a human marks this accepted, V2 stays dev-only, V1 stays live, and no
> migration happens.

---

## Revision after Human-Acceptance Failure #1 (base `25d7738`)

What to re-check specifically (the rejected items):

- [ ] The supplied **Happy Trader Funding wordmark** renders in the sidebar (and
      mobile top strip); the old fake cream square is gone.
- [ ] The customer product shows **no** Design system / DEV entry, component/status/
      lifecycle showcase, or engineering language anywhere.
- [ ] Every sidebar item works: Dashboard, Accounts, Payouts, Certificates, Billing,
      Support — each a real page; account detail + all tabs work.
- [ ] Design reads **sharp / institutional** (near-square geometry, chrome-white
      buttons, dense authoritative account metrics) — not soft SaaS slop.
- [ ] Account surfaces show materially more authoritative info (eval: target progress
      + Net P&L / MLL / floor / high-water; funded: + winning days / consistency /
      payout available).
- [ ] Owner Console is absent from customer nav; owners get it in the account menu
      (dev `?role=owner`); the account menu is a real menu (Sign out), no fake caret.
- [ ] Chrome/white/black identity dominates; no steel-blue; champagne restrained.

Automated gates (this revision): `apps/web` vitest 410/410; typecheck + build clean;
scroll regression (6 viewports) pass; `scripts/portal-v2-review.mjs` all checks pass
(nav, tabs, no dead controls, no dev DOM content, no horizontal overflow 1920→390,
wordmark present, owner gating). Canonical: green modulo environmental load-flakes
(see rebuild report — proven unrelated, pass in isolation).
