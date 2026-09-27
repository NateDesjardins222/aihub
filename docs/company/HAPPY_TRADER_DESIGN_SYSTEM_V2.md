# HAPPY TRADER — DESIGN SYSTEM V2

**Product Rebuild Phase 0 (STEP 5-10, 19-20, 24-25).** The authoritative visual specification for Portal
V2 (and later informing Atlas V2). Implemented as isolated, tested tokens/primitives under
`apps/web/src/portal/v2/` — this doc is the spec; the code is the reference implementation.

> **REFERENCE IMAGE DIRECT INSPECTION: UNAVAILABLE.** No reference screenshot is present in this
> environment. This spec is built from the visual requirements in the phase brief; the real reference
> will be used with Nathan during implementation. Exact values below are STARTING RANGES pending his
> visual judgment — the point is that they are tokenised in one place.

## Visual philosophy

Luxury financial terminal + private banking + professional prop trading. It must read as: **precision,
money, trust, control, professionalism, restraint.** NOT crypto casino, generic SaaS, AI dashboard,
gaming UI, neon terminal, or a marketing website. Restraint over decoration; borders and typography do
the work, not shadows and colour.

## Color tokens (`tokens.css`, scoped `.htv2`, `--ht-*`)

Dark-only for now (light deferred to the rebuild with Nathan). No purple anywhere
(`design-guardrails.test.ts` enforces it).

| Token | Value | Role |
|---|---|---|
| `--ht-bg` | `#09090a` | app background |
| `--ht-bg-elevated` | `#0c0c0e` | sidebar / raised chrome |
| `--ht-surface-1` | `#0f0f11` | cards |
| `--ht-surface-2` | `#121214` | inputs / active nav / status |
| `--ht-surface-hover` | `#161618` | hover |
| `--ht-border-subtle` | `#19191c` | hairline separators |
| `--ht-border` | `#222225` | default border |
| `--ht-border-strong` | `#2d2d31` | emphasised border |
| `--ht-text-strong` | `#f5f4f1` | warm near-white — headings, hero values |
| `--ht-text` | `#d7d6d2` | body |
| `--ht-text-muted` | `#8a8a90` | labels / metadata |
| `--ht-text-faint` | `#56565c` | de-emphasised / disabled |
| `--ht-champagne` | `#e7dcc4` | champagne solid (metallic fallback) |
| `--ht-champagne-muted` | `#b9ae97` | quieter champagne |
| `--ht-positive` / `--ht-negative` / `--ht-warning` | `#46b98a` / `#d96a63` / `#cf9f57` | semantic |
| `--ht-accent` | `#8fa6bd` | single quiet steel accent (not blue-saturated, not purple) |

Everything renders inside a `.htv2` root, so importing the V2 layer **cannot** affect the Atlas terminal
(`--*`) or the live V1 Portal (`--pt-*`).

## Typography (`type.css`)

**Font strategy:** keep **DM Sans Variable** — already bundled and self-hosted
(`@fontsource-variable/dm-sans`, SIL OFL, production-safe), the current UI face, with excellent
small-size legibility and true tabular numerals (`tnum`). No new font dependency is added; "high-quality
number typography" comes from tabular figures + a tightened financial scale. JetBrains Mono (bundled) is
reserved for raw code/audit only. Fallback stack: `ui-sans-serif, system-ui, -apple-system, 'Segoe UI',
sans-serif`.

**Roles** (class → size/weight/lh): `ht-t-display` 34/500, `ht-t-page-title` 20/600, `ht-t-section`
13/600, `ht-t-body` 13/400, `ht-t-body-sm` 12/400, `ht-t-label` 10.5/600 uppercase muted, `ht-t-meta`
11/400 muted, `ht-t-nav` 12.5/500, `ht-t-button` 12.5/600, `ht-t-th` 10.5/600 uppercase, `ht-t-td`
12.5/400, `ht-t-status` 11/600, and financial `ht-t-fin-lg` 26 / `-md` 16 / `-sm` 13 — all with
`font-variant-numeric: tabular-nums`. `.ht-num` turns on `tnum` for any value.

## Spacing (STEP 7)

4-based scale, tokens `--ht-space-1..12` = 4/8/12/16/20/24/32/40/48px. No arbitrary 13/27/37.

## Radii (STEP 8)

`--ht-radius-xs/sm/md/lg` = 2/4/6/8px. 8px is the ceiling for surfaces; fully-round (999px) is allowed
only for pills/dots/progress bars (a shape, not a card corner). Enforced by the guardrail test.

## Borders (STEP 9)

1px separators do the structural work: `--ht-border-subtle` (hairline), `--ht-border` (default),
`--ht-border-strong` (emphasis), `--ht-border-focus` (`#4a4a52`, a calm focus ring — no glow). Semantic
borders use `color-mix` of the semantic token. No glowing outlines.

## Champagne / metallic (STEP 10)

One reusable treatment, `.htv2-metal`: an ivory→champagne→silver `background-clip: text` gradient over a
**solid `--ht-champagne` fallback**. Rules: **no animation, no gold glow, no yellow-gold UI, no gradient
paragraphs, no gradient buttons everywhere, no gold borders.** It reads as metal only up close. Accessible
fallbacks: `prefers-contrast: more`, `print`, and `forced-colors: active` all drop to a solid warm tone.
Used sparingly — brand wordmark, a hero value, the primary button surface, the sidebar mark.

## Application shell (STEP 11-12)

Compact left **sidebar** (`--ht-sidebar-w` 164px, tunable 150–180) + compact **topbar**
(`--ht-topbar-h` 48px, thin divider, breadcrumb + minimal utilities) + a **workspace** capped at
`--ht-workspace-max` 1440px with `--ht-gutter` 24px — an application layout, not a centred marketing
container. Sidebar nav: Dashboard, Accounts, Payouts, Certificates, Achievements, Billing, Support;
Owner Console appended only when role-gated. **Active state = subtle surface, never an underline, purple
bar, or giant pill.** Official Happy Trader branding stays; no new logo invented.

## Buttons (STEP 19)

`--ht-control-h` 32px (30–36 range). **Primary:** champagne surface, dark text, small radius — not a giant
CTA. **Secondary:** dark surface + thin border, warm-white text. **Tertiary:** minimal text action.
**Danger:** semantic, transparent with a tinted border. All in `primitives.css`.

## Status (STEP 20)

`V2Status`: a small dot + label on a restrained surface/border, per kind (evaluation/funded/payout/
completed/failed/hold/neutral) — **not** a saturated pill. Semantic colour is on the dot + text so the
distinction survives colour-vision differences.

## Responsive (STEP 24)

- **Desktop (>900px):** sidebar + topbar + workspace as above.
- **Compact/tablet (≤900px):** sidebar collapses to a horizontal scrollable strip (nav never disappears —
  the V1 `.pt-nav { display:none }` bug is gone); workspace gutter drops to 16px.
- **Mobile:** same strip; account panels reflow to one column (`minmax(280px,1fr)` auto-fill grid);
  lifecycle stays contained by its grid and hides labels below a container width of 320px.
- Tables → stacked rows, forms → single column, buttons keep 32px targets (spec; built in the rebuild).

## Guardrails (STEP 25)

`design-guardrails.test.ts` enforces, for the V2 layer: no purple keyword or purple-range hex; no
`text-decoration: underline`; radii tokenised and ≤8px (pills excepted); no heavy ad-hoc drop shadows.
Lightweight and enforceable — not a new lint system.

## What requires Nathan's visual judgment

Exact champagne hue and gradient stops; final surface steps; sidebar width; the hero/emphasis placement
of the metallic treatment; density fine-tuning; and light-mode. The system is built so each is a token or
prop change, not a rewrite.
