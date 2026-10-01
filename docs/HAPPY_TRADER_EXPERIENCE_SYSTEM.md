# Happy Trader Experience System (Experience Layer Phase 2)

The systemic layer that makes the canonical `/portal` feel **premium, fun, fast and
distinctive** without becoming a casino, a video game, or a generic SaaS dashboard. It is a
SYSTEM — reusable tokens and primitives — not per-page styling. Everything is scoped under
`.htv2`, animates only `transform`/`opacity`, and is fully neutralised under
`prefers-reduced-motion`. Future agents must reuse this system rather than scattering values.

Files: `v2/tokens.css` (tokens), `v2/motion.css` (motion + aura, Phase 1), `v2/experience.css`
+ `v2/experience.tsx` (Phase 2 primitives), `v2/experience-celebration.tsx` (celebrations).

## 1. Brand accent — rose gold / champagne

The single LIVING accent, representing progress / success / achievement / important
interaction. **Not** every border, word, or button. The base stays a black / white / chrome
luxury terminal. Tokens (`tokens.css`): `--ht-rose`, `--ht-rose-deep`, `--ht-rose-soft`,
`--ht-rose-line`, `--ht-champagne`, `--ht-champagne-soft`. Metallic text sweeps:
`.htv2-metal-rose` / `-champagne` / `-gold` (`motion.css`), with solid-colour and
forced-colors fallbacks.

## 2. Glow hierarchy (intensity communicates rank)

`--ht-glow-low` (hover / ambient focal) · `--ht-glow-med` (important actionable state) ·
`--ht-glow-high` (achievement / major success) · `--ht-glow-success` (green). Utilities:
`.htv2-glow-low|med|high|success`, `.htv2-glow-hover`. Replace ad-hoc shadows with these so
glow always means the same thing.

## 3. Motion — three tiers

- **Tier 1 · Micro (70–200ms)** — buttons, tabs, sidebar, hover, checkboxes, tooltips.
  Tokens `--motion-instant|fast|standard`. Buttons/`.htv2-lift`/`.htv2-icard` press + lift.
- **Tier 2 · Product (200–320ms+)** — page transitions (`.htv2-page-transition`), progress
  rings, journey, number flow, modal entrances. Tokens `--motion-standard|emphasis`.
- **Tier 3 · Celebration (1–4s max)** — funded / first payout / club / account completion.
  Skippable, non-blocking after dismissal, **once per authoritative event**, reduced-motion
  aware. One engine only (see §8).

Easing: `--motion-ease` (decel), `--motion-ease-out` (soft settle). No bounce/overshoot.

## 4. Living background

`<V2Background>` (one fixed, `aria-hidden`, pointer-none layer behind the workspace): large
blurred rose-gold + champagne radials over near-black, a faint financial grid, and an abstract
upward "smile-arrow" arc. Drifts slowly where motion is allowed; static under reduced motion.
It must be FELT before noticed — content readability always wins. The shell workspace is
transparent so the atmosphere shows through; the sidebar and top bar stay opaque above it.

## 5. Interactive cards

`.htv2-icard` (compose with `.htv2-card`) / `<V2InteractiveCard>`: a 1–2px lift, quiet border
illumination, and an optional cursor-follow rose sheen. Never a dramatic tilt; financial data
stays perfectly readable. Touch devices get a small press-scale instead of hover/tilt. The
Accounts ledger deliberately does NOT use cards (it was rejected as "AI dashboard") — it is a
financial statement; interactivity there is row/hover, not tilt.

## 6. Buttons & focus

Buttons (`.htv2-btn*`, `motion.css`) get hover lift, press depth, and (primary) restrained
champagne illumination; destructive stays distinct. One consistent accessible focus ring
(`--ht-focus-ring`) applies to every interactive element via `:focus-visible`.

## 7. Page transitions, number flow, rings, skeletons

- **Page transition**: `.htv2-page-transition` — a fast rise + fade keyed on route change.
- **Number flow**: `<V2NumberFlow>` counts toward an authoritative target; the FINAL rendered
  value always equals the exact authoritative value (never misrepresents money). Skips the
  animation under reduced motion.
- **Progress ring**: `<V2ProgressRing>` (tracked goals, clubs) — `pct` is authoritative 0..1.
- **Journey**: `<V2Journey>` — horizontal on desktop, vertical spine on mobile; `now` node
  pulses (ambient), past = rose, ahead = dashed.
- **Skeletons**: `<V2Skeleton>` / `<V2PageSkeleton>` — layout-matching, never fake numbers.

## 8. Celebration engine

`CelebrationHost` fetches the authoritative feed, shows the highest-priority unseen moment,
acks it server-side on dismiss, and advances. See `CUSTOMER_EXPERIENCE_EVENT_MAP.md` for the
events, intensities, priority and acknowledgement. Particles are a disposed-on-unmount
Canvas-2D burst (no heavy 3D dependency), skipped under reduced motion.

## 9. Reduced motion (mandatory)

Every file carries a `@media (prefers-reduced-motion: reduce)` block that removes animation
while preserving meaning. Meaningful state changes remain understandable without motion. No
accessibility regression.

## 10. Anti-patterns (do NOT)

- No casino confetti, slot-machine reels, neon, or glass.
- No box explosion — don't wrap every thought in a bordered rounded card; use spacing,
  typography, dividers, tables, progress tracks, panels.
- No bubbly radii — keep the restrained 0–4px geometry (`--ht-radius-*`).
- No animation that blocks navigation or delays an action (Accounts, Trade, Payout, Support,
  Billing, Atlas handoff stay immediate).
- No fabricated data to fill a chart — if there's no authoritative source, show nothing (see
  `CUSTOMER_VISUALIZATION_DATA_MAP.md`).
- No AI-slop copy ("unlock your potential", "level up", "trade smarter"). Concise, confident,
  real-company language.
- No sound effects.
