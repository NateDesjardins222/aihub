# Happy Trader Funding — public website design plan

Internal plan for the first serious public marketing site (homepage + public-site
design system). Written after inspecting the existing Atlas/Happy Trader codebase.

## What already exists (inspection findings)

- **Web app** is a single Vite/React SPA (`apps/web`), path-routed in `App.tsx`.
  Signed-out `/` currently renders `LoginScreen`; signed-in `/` renders the Atlas
  terminal. Portal, admin (Owner OS), checkout, onboarding, affiliates, verify are
  lazy bundles behind (mostly) the sign-in gate. Public bundles rendered *before*
  the gate: `/verify/:token` and `/affiliates` (a good precedent to mirror).
- **Fonts**: DM Sans Variable (UI/read) + JetBrains Mono Variable (mono), self-hosted
  via fontsource. No animation libraries (no framer/gsap/three) — keep it that way.
- **Terminal theme** (`styles/theme.css`) is a dark blue trading palette — for the
  authenticated product. The public site needs its own black/white/silver identity,
  self-contained (the affiliate page already does this: `.aff` scope, chrome gradient,
  gold used sparingly).
- **Products**: authoritative product terms live in the DB (`account_profiles` +
  immutable versions, `profiles.ts`), but the **seed only ships generic "Atlas
  Evaluation" templates** — the CORE / SELECT / DAILY families and their exact prices
  do **not** exist in the DB yet. So there is no existing authoritative source for the
  10 marketing accounts to read from. Decision below.

## Decisions

1. **Routing** — add a lazy `MarketingApp` rendered *before* the sign-in gate when the
   path is `/` (or `/home`) and the visitor is **not** signed in. Signed-in `/` stays
   the terminal — the authenticated product is untouched. CTAs route into the existing
   gated flows (`/onboarding`, `/portal`), so the login funnel is unchanged.
2. **Product source of truth** — because the CORE/SELECT/DAILY catalog is not yet in
   the DB, create **one** centralized, typed catalog module (`marketing/catalog.ts`)
   as the single source for the public site — not scattered constants. It is the
   documented seam that a future migration should back with a public `/catalog`
   endpoint once the DB carries these families. Numbers come verbatim from the product
   spec; nothing is invented.
3. **Company/legal facts** — a single `marketing/site.ts` config seam. No social URLs,
   counts, testimonials, reviews, or trust badges are fabricated; unknown business
   facts are left as clearly-marked TODO placeholders, not invented.
4. **No new dependencies.** Motion is hand-built: CSS transitions + IntersectionObserver
   reveals + two small canvas engines (candles, particles). Canvas never drives React
   state per frame.

## Design language

Black canvas, silver/white type, **chrome** gradient for the wordmark and key marks,
**gold reserved** for the 300K Gold account only. Large type, generous spacing, thin
hairline separators, sharp alignment, strong contrast, restrained depth. "Quiet until
it moves." One reveal language repeated; motion is subtle and purposeful.

Tokens (`marketing/marketing.css`, `.ht` scope): surfaces, ink, hairline, chrome,
gold, spacing scale, type scale, radii, motion durations/easings, breakpoints.

## Homepage information architecture

1. Sticky minimal **nav** + compact **live candle header band** (wordmark dominant).
2. **Hero** — what Happy Trader is, primary CTAs.
3. **Account families** — interactive CORE/SELECT/DAILY selector over a cursor-reactive
   particle field (the centerpiece); particles bias toward the hovered family.
4. **Accounts matrix** — all 10 accounts, authoritative price/target/drawdown/contracts.
5. **How it works** — evaluate → get funded → get paid.
6. **Atlas** — the platform as a differentiator (real terminal visual language).
7. **Payouts** — 90% split, winning-days, the honest Daily buffer/successive-balance rule.
8. **Rules** — the major rules stated plainly and correctly.
9. **Why Happy Trader** — differentiation.
10. **FAQ**.
11. **Final CTA** + **footer** (company config seam).

## Candle engine (decorative synthetic motion — never labelled live market data)

- Timeline anchored to wall-clock; history already exists on arrival (origin =
  load − N·bucket). Each candle is a 3s bucket; the active candle forms tick-by-tick.
- Every candle's OHLC + tick path is a **pure function of its index** (seeded PRNG),
  so rendering can pause (tab hidden / offscreen) and the state recovers exactly from
  `now` — never a run of flat zero-range candles after returning.
- Varied character: small / medium / displacement / wicky / directional candles.
- **Wick occlusion**: candles are drawn fully opaque on the canvas (body painted over
  the wick), and the whole strip is subdued with element opacity + an edge fade — so a
  body always occludes its own wick, monochrome, with the wordmark dominant.
- Respects `prefers-reduced-motion` (renders a static formed chart, no rAF).

## Accessibility & performance

Semantic landmarks, heading hierarchy, keyboard-reachable controls, visible focus,
`prefers-reduced-motion` honored everywhere, canvas loops paused offscreen/hidden,
cursor tracked by ref (no per-frame React state), DPR-aware canvases, no layout thrash.
