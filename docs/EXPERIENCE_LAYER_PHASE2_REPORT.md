# Customer Experience Layer — Phase 2 — Report

**Starting commit:** `a7c9a07` · **Ending commit:** see `git log` head on
`claude/futures-trading-simulator-v8qefu` · **Checkpoint:** `customer-experience-phase2-start`.

The canonical `/portal` is made **premium, fun, fast and distinctive** while keeping the
hardened authoritative customer core. This phase is **presentation-only** — it changed **no**
business rule (risk, drawdown, consistency, payout eligibility/caps/cycles, ownership,
identity, execution, lifecycle, certificates, clubs, provisioning are all untouched). `/portal`
remains the one canonical product; `/portal-v2` remains the DEV-only review harness.

## Files / components changed

**New (web, `apps/web/src/portal/v2`):** `experience.css`, `experience.tsx` (background, ring,
journey, number-flow, interactive card, skeletons, reduced-motion hook), `experience-celebration.tsx`
(celebration engine), `analytics-page.tsx` + `analytics-page.css` (new Analytics), `experience.test.ts`.
**Rebuilt:** `progress-page.tsx` (+CSS) — new IA. **Edited:** `tokens.css` (accent + glow + focus),
`Shell.tsx`/`Shell.css` (background mount, Analytics nav, transparent workspace), `containers.tsx`
(Analytics + payout-history wiring, goal rollback), `PortalV2App.tsx` (Analytics route, page
transition, celebration host).
**New (server):** `platform/celebrations.ts`, `platform/portal-payouts.ts`, `celebrations.test.ts`,
`db` table `celebration_acks` + migration `0038_celebration_acks.sql`; `routes/portal.ts` adds
`/payouts/history`, `/celebrations`, `/celebrations/ack`.
**Docs:** `HAPPY_TRADER_EXPERIENCE_SYSTEM.md`, `CUSTOMER_EXPERIENCE_EVENT_MAP.md`,
`CUSTOMER_VISUALIZATION_DATA_MAP.md`; `company/KNOWN_ISSUES.md` Phase-2 section.
**Screenshots:** `docs/experience-phase2-screens/` (9 canonical `/portal` views).

## New experience primitives / tokens / glow+background system

- Accent tokens: `--ht-rose(-deep/-soft/-line)`, `--ht-champagne-soft`; glow hierarchy
  `--ht-glow-low/med/high/success`; `--ht-focus-ring`; `--ht-elevate-hover`.
- Motion tiers (micro/product/celebration) built on the Phase-1 `--motion-*` tokens.
- Living background (`V2Background`): fixed rose-gold + champagne radials + faint grid +
  abstract smile-arc, slow drift, reduced-motion static; shell workspace made transparent.
- Primitives: `V2InteractiveCard` (cursor sheen), `V2ProgressRing`, `V2Journey`, `V2NumberFlow`
  (final value == authoritative), `V2Skeleton`/`V2PageSkeleton`, `.htv2-page-transition`.

## Celebration system

One engine (`CelebrationHost`/`V2Celebration`) driven only by `GET /api/v1/portal/celebrations`
(derived from authoritative achievements). Idempotent via `celebration_acks` (migration `0038`) —
ack on dismiss, never replays. Priority queue + "you also earned" summary; lightweight disposed
Canvas burst; reduced-motion safe. Sources/intensity/priority in `CUSTOMER_EXPERIENCE_EVENT_MAP.md`.

## Progress — before → after

Before: Goals low on the page; "Current focus" duplicated pinned goals; text-list timeline.
After: **My Goals first** (real persistent checkboxes, optimistic + rollback; quick-add; tracked
goals show a progress ring and can't be hand-checked), **The Journey** (visual path), **Where You
Stand** (authoritative snapshot preserved), **The Clubs** (connected rings + rail),
**Accomplishments**. Current-Focus duplication removed (pinned sort first in one list).

## Goal persistence & tracked-goal protection

Personal-goal completion persists server-side (`POST /goals/:id/complete`) and survives refresh /
re-login / device (owner-scoped `personal_goals`). Tracked goals complete only from authoritative
data; manual completion is refused server-side (`TRACKED_AUTO_ONLY`) — proven in
`personal-goals.test.ts` and asserted structurally in `experience.test.ts`.

## Journey / Clubs / Dashboard / Accounts / Payouts / Certificates / Billing / Support / Analytics

- **Journey**: visual past→now→ahead rail (horizontal desktop / vertical mobile), now-node pulse.
- **Clubs**: one connected progression (rings + shared rail), authoritative PAID trader-share.
- **Payouts**: now backed by the authoritative payout-history projection (real history + in-review),
  not certificate reconstruction. **Analytics (new tab)**: portfolio summary, daily realized-P&L
  heatmap, account comparison + equity sparklines, payout history — authoritative, distinct from
  Account Detail.
- **Dashboard / Accounts / Certificates / Billing / Support**: unchanged in data, enriched by the
  system-wide experience layer (background, glow, focus ring, page transitions, tactile buttons).
  Accounts keeps its deliberate ledger (cards were previously rejected as "AI dashboard").

## Visualization data sources & celebration event sources

See `CUSTOMER_VISUALIZATION_DATA_MAP.md` (every visualization → authoritative source; absent ones
listed) and `CUSTOMER_EXPERIENCE_EVENT_MAP.md` (event → source → intensity → ack → actions).

## Performance / accessibility

GPU-friendly transform/opacity only; navigation never waits on animation; celebration particles are
capped + disposed; no heavy 3D dependency. `prefers-reduced-motion` neutralises all motion with full
functionality retained; one consistent focus ring. Production build passes; bundle unchanged in shape.

## Tests / browser evidence

- web typecheck PASS; server typecheck PASS; production build PASS.
- **518 web tests PASS** (incl. `experience.test.ts`, `portal-convergence.test.ts`).
- **server `celebrations.test.ts` PASS (4)** — authoritative sourcing, ack idempotency/no-replay,
  cross-customer isolation, malformed-key rejection.
- **`customer:certify` FAST PASS** (integrity + 8 suites / 78 tests) — hardened customer core intact.
- migration `0038` applies cleanly on a fresh DB.
- headless browser (logged-in, SPA nav): canonical V2 shell at `/portal`, rejected shell absent,
  **0 console errors**; 9 screenshots in `docs/experience-phase2-screens/`.

## Known issues / PCV-6 / P-levels

No new **P0** and no new **P1**. Documented scope items (all truthful, none fabricated):
EXP2-1 no merged cross-account equity time-series; EXP2-2 no consistency time-series; EXP2-3 stale
pre-rebuild Progress CSS classes remain (harmless). **PCV-6 (unchanged):** the full
`validate:release` run still exhibits pre-existing server-side shared-Postgres/CPU contention flakes
(all pass in isolation); this phase changed **0 server business files** and did not run that suite to
green (per §93/§94). Not derailed into a test-runner redesign.

## Hard questions (§97) — YES/NO with evidence

1 `/portal` still canonical — **YES** (App.tsx → PortalV2App; convergence test).
2 Hardened business core still authoritative — **YES** (all figures from `/api/v1/*`; certify FAST PASS; 0 business-rule changes).
3 Materially more interactive — **YES** (interactive cards, journey, rings, checkboxes, celebrations, page transitions).
4 Materially more visually distinctive — **YES** (living rose-gold/champagne atmosphere, glow hierarchy, metallic accents; screenshots).
5 Rose-gold/champagne used consistently, not randomly — **YES** (central tokens + glow system; accent reserved for progress/success/interaction).
6 Normal navigation still fast — **YES** (transforms/opacity only; nav never waits on animation; fast page transition).
7 Animations communicate state, not just decorate — **YES** (now-node pulse, number-flow to authoritative value, goal-done pop, celebration on real events).
8 Reduced motion works — **YES** (every file has a reduce block; `experience.test.ts` asserts it).
9 Goals prominent at top of Progress — **YES** (My Goals is the first section).
10 Personal goal checkboxes persist server-side — **YES** (`/goals/:id/complete`; `personal_goals`; survives refresh/login/device).
11 Tracked goals can be manually forged — **NO** (`TRACKED_AUTO_ONLY`; structural + server tests).
12 Current Focus duplication removed — **YES** (pinned sort first in one list).
13 Journey now visually interactive — **YES** (`V2Journey` rail; nodes support detail).
14 Lifetime paid still authoritative — **YES** (`progress.hero.lifetimePaidTraderShareMicros`).
15 Club milestones authoritative — **YES** (PAID trader-share vs thresholds).
16 Funded celebration only on a real funded event — **YES** (achievement-sourced; `celebrations.test.ts`).
17 Does it auto-replay after refresh — **NO** (ack idempotency; `celebrations.test.ts`).
18 Payout celebrations tied to PAID — **YES** (FIRST_PAYOUT/PAID_* achievements issued on PAID).
19 Can customer A see customer B's experience event — **NO** (owner-scoped; isolation test).
20 Visualizations based on authoritative data — **YES** (data map; empty states where absent).
21 Fixture values present in production — **NO** (fixture firewall tests; prod build).
22 Did this phase alter risk/payout business rules — **NO** (presentation-only; 0 server business files changed; certify FAST PASS).
23 New P0 defects — **NO**.
24 New P1 defects — **NO**.

## Human review

Nathan opens the canonical portal at `/portal` (web preview on 5174 with the server on 4000, demo
`demo@atlasfutures.local`), inspects the new Experience Layer, and sends screenshots/feedback to
ChatGPT. Claude did not perform the human acceptance. No L5 DB seeding; auth not bypassed.
