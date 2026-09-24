# Happy Trader Design System (Dashboard V2)

The customer portal at `/portal` is built on a small, explicit design system —
private-banking / institutional-finance in tone: dark graphite, restrained
chrome/silver, very restrained gold, tabular numerals, generous whitespace, and
motion that never gets in the way. This document is the reference for the tokens,
primitives and rules the portal is assembled from. It is deliberately narrow: it
governs `/portal` and the public certificate page, not the Atlas terminal (which
has its own chrome) and not the owner console.

Everything here lives in two files:

- `apps/web/src/portal/theme.ts` — the theme hook (`usePortalTheme`), which
  persists the choice to `localStorage['ht.theme']` and sets `data-pt-theme` on
  `<html>`.
- `apps/web/src/portal/Portal.css` — the token definitions and every component
  style, all namespaced under `.pt` / `pt-*`.
- `apps/web/src/portal/lib.tsx` — the shared React primitives and formatters.

## Principles

1. **The server owns every number.** Nothing in the design system computes a
   balance, a P&L, an eligibility, or a risk decision. Money arrives as integer
   micro-dollars and is only *formatted* here. A value that is not yet known
   renders as a skeleton or an empty state — never a zero, never a guess.
2. **Restraint is the aesthetic.** Chrome/silver is the working accent. Gold is
   reserved: it marks the 300K Gold product family and genuine milestones
   (lock-confirm, a certificate), nothing else. Colour is used to carry meaning
   (positive / negative / warning), not decoration.
3. **Numbers line up.** Every figure renders with tabular numerals (DM Sans’
   `font-variant-numeric: tabular-nums`) so columns and metric grids stay
   aligned as values change.
4. **Two real themes.** Light mode is a genuinely designed light theme, not an
   inverted dark one: its own surfaces, lines, and text ramps, tuned for paper.
5. **Accessible by default.** Interactive controls are real buttons/inputs with
   roles and labels; the theme toggle and switches expose `aria-*`; motion
   collapses under `prefers-reduced-motion`.

## Theme + tokens

Tokens are CSS custom properties on `:root[data-pt-theme='dark']` and
`:root[data-pt-theme='light']`. Components never hard-code a colour; they read a
token, so the two themes stay in sync structurally and only the values differ.

### Dark (default)

| Token | Value | Role |
| --- | --- | --- |
| `--pt-bg` | `#0b0b0c` | Page background (near-black graphite) |
| `--pt-surface` | `#111113` | Card / panel surface |
| `--pt-surface-2` | `#161618` | Elevated surface (inputs, menus) |
| `--pt-raised` | `#1b1b1e` | Raised chips / hover |
| `--pt-line` / `--pt-line-strong` | `#232327` / `#2e2e33` | Hairlines / stronger dividers |
| `--pt-text` / `--pt-text-2` | `#f4f5f7` / `#b9bcc4` | Primary / secondary text |
| `--pt-dim` / `--pt-faint` | `#6d7078` / `#45474d` | Tertiary / faint text |
| `--pt-chrome` | `#cfd3da` | Chrome/silver working accent |
| `--pt-gold` / `--pt-gold-dim` | `#c8a24a` / `#8a7231` | Reserved gold |
| `--pt-accent` | `#7aa2d6` | Cool link/accent |
| `--pt-pos` / `--pt-neg` / `--pt-warn` | `#3fb98f` / `#e0645f` / `#d8a84a` | Semantic P&L / warning |
| `--pt-pos-bg` / `--pt-neg-bg` | translucent | Semantic backgrounds |
| `--pt-radius` / `--pt-radius-sm` | `10px` / `7px` | Corner radii |
| `--pt-shadow` | layered | Card elevation |

Light mode redefines the same token names for a paper background, darker text
ramps, and slightly deepened semantic colours so they read on white. Because
the names are identical, no component changes between themes.

### Typography

DM Sans is the portal face (loaded via the app’s font pipeline). Numerals are
tabular everywhere a figure appears — balances, metrics, tables, the equity
tooltip, the calendar. Headings use tight negative letter-spacing; body copy is
comfortable and secondary text steps down through the text ramp rather than
shrinking.

## Primitives (`lib.tsx`)

The portal is assembled from a handful of primitives so that spacing, tone and
number formatting are consistent by construction:

- **Formatters** — `money(micros, {sign})`, `pct(x)`, `tone(micros)` →
  `pos|neg|flat`, plus label helpers (`stateLabel`, `badgeClass`, `familyOf`,
  `achLabel`, `certLabel`) and `msg(err)`. `money` renders `—` for `null`, which
  is how "not known yet" is expressed rather than `$0`.
- **`Card`** — the surface primitive; `pad={false}` for flush tables.
- **`Money`** — a `<span>` that formats micro-dollars and colours by `tone`.
- **`Metric`** — a label / value / optional sub triple used in every metric grid.
- **`Pill`** — a status badge coloured by `badgeClass(portalState)`.
- **`Toggle`** — a real `role="switch"` button with `aria-checked`; the switch is
  the only thing that enables a control (typing a value never does).
- **`Skeleton`** / **`EmptyState`** — the two honest not-yet / nothing-here states.
- **`AccountPath`** — the compact lifecycle path Evaluation → Funded → Payouts →
  Completed, highlighting the account’s current stage (and a distinct failed
  state).

## Components (`Portal.css`)

The stylesheet defines the shell (`.pt-top`, `.pt-nav`, `.pt-trade`,
`.pt-iconbtn`), the account switcher (`.pt-switcher` / `.pt-menu`), the command
center summary, premium account cards, metric grids, status badges, the drawdown
band, the lifecycle path, buttons, inputs, tables, tabs, the interactive equity
chart (`.pt-equity` + tooltip), the P&L calendar (`.pt-cal`), the personal
controls (`.pt-ctl` + the toggle switch and lock state), the payout module
(`.pt-payout-avail` / `.pt-payout-break` / `.pt-reasons`), achievements, and the
empty / error / skeleton / toast states. It is responsive at ~820px and honours
`prefers-reduced-motion`.

### Gold, used sparingly

Gold appears in exactly three places: the 300K Gold product family accent on a
card and detail header, the milestone treatments (a certificate, an
achievement), and the **Lock until next trading day** confirm button — a
deliberately heavyweight action that deserves a heavyweight colour. Everywhere
else the accent is chrome.

## Testids

Stable `data-testid`s exist for acceptance: `portal-app`, `pt-nav-*`,
`pt-switcher` / `pt-switcher-menu`, `pt-trade`, `pt-theme-toggle`, `pt-profile`,
`pt-toast`, `pt-summary`, `pt-account-card`, `pt-nick`, `pt-tab-*`, `pt-range`,
`pt-equity`, `pt-calendar`, `pt-day-trades`, `pt-ctl-*`, `pt-locked`,
`pt-lock-confirm`, `pt-ctl-usage`, `pt-payout-state`, `pt-payout-request`,
`pt-payout-reasons`. These are contract with the browser suite and should not be
renamed casually.

## What the design system deliberately does not do

- It does not theme or restyle the Atlas terminal or the owner console.
- It does not introduce a component library or a runtime CSS-in-JS dependency —
  it is plain CSS tokens plus small React primitives.
- It does not add products, animations-for-their-own-sake, or any surface that
  would compute financial truth in the browser.
