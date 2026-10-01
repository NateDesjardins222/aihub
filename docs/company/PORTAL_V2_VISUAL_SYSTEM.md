# Portal V2 — Visual System

**Portal V2 Full Product Rebuild** (base `298a69c`). The authoritative description
of *how Portal V2 looks and why*. Everything here is scoped under `.htv2` and
expressed as `--ht-*` tokens / `.ht-t-*` type roles, so it never touches V1 or the
Atlas terminal.

> **North star:** *luxury financial terminal × private banking × professional prop
> trading.* Near-black layered canvas, restrained 1px borders, small radii,
> premium typography, deliberate density, restrained champagne accents. No neon,
> no glass, no glow, no casino shine, no emoji.

---

## 1. Typography — Inter Variable

The V2 UI face is **Inter Variable** (`@fontsource-variable/inter`, SIL OFL,
self-hosted, imported once in `main.tsx`). Inter is the premium financial-UI
standard: superb small-size legibility, true tabular numerals, and tight tracking
for headings. It is scoped to `.htv2` — the Atlas terminal and V1 keep DM Sans.

The old DM Sans "dev-site" look was the single biggest lever on credibility, so it
was replaced for V2. JetBrains Mono is reserved for raw code/audit only.

Features enabled (`type.css`): `font-optical-sizing: auto`,
`font-feature-settings: 'cv09' 1, 'ss03' 1, 'calt' 1`, antialiased smoothing,
`optimizeLegibility`. **Every financial number** uses `.ht-num`
(`font-variant-numeric: tabular-nums; 'tnum' 1`) so columns never jitter.

### Type roles (never ad-hoc `font-size`)

| Role              | Size / weight / tracking                | Use |
|-------------------|-----------------------------------------|-----|
| `ht-t-display`    | 34px / 550 / -0.022em                    | the single hero value on a page |
| `ht-t-page-title` | 19px / 600 / -0.014em                    | page title |
| `ht-t-section`    | 13px / 600                               | section heading |
| `ht-t-body` / `-sm` | 13 / 12px / 400                        | body copy |
| `ht-t-label`      | 10.5px / 600 / 0.06em / uppercase        | micro-labels above values |
| `ht-t-meta`       | 11px / 400 / muted                       | metadata |
| `ht-t-nav` / `-button` | 12.5px / 500–600                    | nav & buttons |
| `ht-t-fin-lg/md/sm` | 26 / 16 / 13px, tabular                 | financial values |

## 2. Colour — semantic tokens, dark-only

Defined once in `tokens.css`, dark-only (a light variant is deferred, not
half-shipped). **No purple primary, no default browser-blue links, no random hex,
no bright gold everywhere** — these are enforced by `design-guardrails.test.ts`
and `visual-system.test.ts`.

### Surfaces (near-black, layered)
`--ht-bg #09090a` → `--ht-bg-elevated #0c0c0e` → `--ht-surface-1 #0f0f11` →
`--ht-surface-2 #121214` → `--ht-surface-hover #161618`.

### Borders (1px does the structural work)
`--ht-border-subtle #19191c`, `--ht-border #222225`,
`--ht-border-strong #2d2d31`, `--ht-border-focus #4a4a52`.

### Text (warm, not pure grey)
`--ht-text-strong #f5f4f1` (headings/hero), `--ht-text #d7d6d2` (body),
`--ht-text-muted #8a8a90` (labels), `--ht-text-faint #56565c` (de-emphasised).

### Semantic
`--ht-positive #46b98a`, `--ht-negative #d96a63`, `--ht-warning #cf9f57` (each with
a 12%-alpha `-bg`). The single interactive accent is `--ht-accent #8fa6bd` — a cool
desaturated steel that recedes; **not** purple, **not** saturated blue.

## 3. Champagne — restrained brand metal

`--ht-champagne #e7dcc4` (pale, warm), `--ht-champagne-muted #b9ae97`, and a
low-contrast ivory→champagne→silver sweep `--ht-champagne-grad` applied via
`background-clip: text` with a **solid-colour fallback** (`.htv2-metal`), plus
accessible fallbacks for `prefers-contrast: more`, print, and `forced-colors`.

Champagne is used **sparingly** and only to signal value or brand:
- the brand mark,
- the active tab underline,
- the evaluation profit-target progress fill,
- the primary action button surface (dark text on champagne),
- a locked risk-control badge, a Gold designation.

It is **never** a glow, an animation, a casino shine, or a wash across the page.

## 4. Geometry & elevation

- **Radii ≤8px** on application surfaces: `--ht-radius-xs 2`, `-sm 4`, `-md 6`,
  `-lg 8`. Fully-round `999px` is permitted only for true pills (progress bars,
  dots, the switch track) — a shape, not a SaaS card corner. Enforced by test.
- **Elevation is borders-first.** `--ht-shadow-1` is a 1px hairline;
  `--ht-shadow-pop` is the only real shadow, reserved for genuine pop-overs. No
  heavy SaaS drop shadows anywhere else (enforced by test).
- **Spacing** is a strict 4-based scale (`--ht-space-1..12`); no arbitrary
  13/27/37px.

## 5. Anti-patterns the rebuild deliberately avoids

- ✗ four giant stat cards → ✓ one quiet `V2StatStrip` (thin vertical rules)
- ✗ giant welcome/hero banner → ✓ a quiet page header line
- ✗ glassmorphism / blur → ✓ opaque near-black surfaces, 1px borders
- ✗ emoji → ✓ none anywhere
- ✗ fake charts → ✓ only real projected data; honest empty/loading states
- ✗ giant CTAs → ✓ compact 32px controls
- ✗ dead controls/links → ✓ nav shows only implemented destinations
- ✗ default blue underlined links → ✓ muted links, underline on hover/focus only
- ✗ purple/violet primary → ✓ steel accent + champagne brand metal

## 6. The dashboard as the thesis

The dashboard proves the direction in one screen: a quiet page header, a
`V2StatStrip` (Active / Evaluation / Funded / Total balance), a conditional
`V2Attention` row (only when an account is breached / payout eligible / on hold),
the **accounts as the centerpiece** (`V2AccountPanel` grid), and a compact
`V2ActivityList`. Hierarchy flows: *where do I stand → what needs attention →
my accounts → recent activity.*

## 7. Scroll & responsive

Scroll ownership (one owner: the workspace) is specified in
`PORTAL_V2_SCROLL_ARCHITECTURE.md`. Responsive: ≤900px the sidebar becomes a top
strip; stat strips reflow 2×2; account panels stack; the workspace still owns
vertical scroll; no page-level horizontal overflow at any width.

## 8. Enforcement (so a future edit can't silently regress this)

- `visual-system.test.ts` — Inter face (not DM Sans); tabular numerals; no
  purple/violet/indigo; no default browser-blue link; `.htv2-link` uses the muted
  token; champagne is token-based (no `#ffd700`/`gold`); nav has no permanent
  underline.
- `design-guardrails.test.ts` — no purple keyword / purple-range hex; **no default
  (resting-state) link underline** (hover/focus underline permitted); radii ≤8px;
  borders-first elevation (no giant shadows).

Both strip CSS comments before scanning, so descriptive prose that *names* a
forbidden thing ("NOT purple") never trips the guard — the guards police what the
code *does*, not how it explains itself.
