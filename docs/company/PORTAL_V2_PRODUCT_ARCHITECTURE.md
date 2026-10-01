# Portal V2 — Product Architecture

**Portal V2 Full Product Rebuild** (base `298a69c`). This describes the customer
Portal V2 as a *product*: its information architecture, the shell, the component
system, the presentational/container seam, routing, role-gating, and — most
importantly — the boundary between **presenting business truth** and **inventing
it**. It is the companion to `PORTAL_V2_VISUAL_SYSTEM.md` (the look) and
`PORTAL_V2_SCROLL_ARCHITECTURE.md` (the scroll/shell contract).

> **Status:** human-acceptance *candidate*. `/portal-v2` is a **dev-only** review
> surface (production 404s). V2 is **not** migrated into production; V1 remains the
> live customer portal and instant rollback. Nathan reviews this build next.

---

## 1. What Portal V2 is (and is not)

Portal V2 is a coherent rebuild of the **customer-facing** portal — the surface a
funded/evaluation trader opens to answer *"where do I stand, and what needs my
attention?"* It is designed to feel credible as the customer portal of a serious,
premium financial/trading company: a luxury financial terminal, not a SaaS
dashboard template.

It is **not**:
- a backend/identity/auth/authz/lifecycle/ledger/P&L/rules/risk/payout rewrite —
  none of that economics was touched;
- the Atlas trading terminal or the Owner OS/Owner Console — those are separate
  applications and are untouched;
- live in production — it is a dev-only review harness pending human acceptance.

## 2. The cardinal rule — present truth, never invent it

The frontend **presents** authoritative server truth; it never manufactures it.

- **No fake data in the customer product.** The presentational components render
  whatever the authoritative APIs return. Where a value is not yet available, the
  component shows an honest empty/loading/error state — never a plausible-looking
  fabricated number.
- **Dev fixtures are dev-only and labelled.** The `/portal-v2` review harness and
  the `/portal-v2/dev/design-system` showcase drive the *same* presentational
  components with clearly-labelled development fixtures (`fixtures.ts`). This is
  legitimate because `/portal-v2` is gated by `designLabEnabled()` and 404s in a
  production build — a customer can never reach a fixture. The dashboard itself
  carries a visible "development environment — values are representative, not a
  live session" note.
- **Server authorization stays authoritative.** UI role-gating is a presentation
  convenience; it is never the security boundary. The real Owner Console lives at
  `/admin` and is authorized server-side regardless of anything the V2 UI does.

## 3. Isolation — V2 cannot touch V1 or Atlas

Everything V2 is namespaced so importing it can never regress the live product:

| Layer        | V2 namespace                     | Live V1 / Atlas |
|--------------|----------------------------------|-----------------|
| Root scope   | `.htv2`                          | `.pt-*` (V1), terminal root |
| CSS tokens   | `--ht-*` (`tokens.css`)          | `--pt-*`, `--*` |
| Type roles   | `.ht-t-*` (`type.css`)           | separate |
| Components    | `htv2-*` classes                 | separate |
| UI font       | Inter Variable (scoped to `.htv2`) | DM Sans (terminal/V1) |

All V2 CSS selectors are prefixed `.htv2 …`, so the token/type/primitive files
apply **only** inside a `.htv2` root. The live V1 Portal and the Atlas terminal
keep their own faces and themes.

## 4. Information architecture

The customer's mental model is **accounts first**. The navigation shows only
destinations that have a real, usable V2 implementation today — no fake breadth,
no dead links:

- **Dashboard** — "where do I stand?": a summary strip → an attention row (only
  when action is genuinely required) → your accounts (the centerpiece) → recent
  activity.
- **Accounts** — the full account list (all lifecycle states).
- **Account Detail** — a single account with tabs: Overview / Performance /
  Controls / Rules / Activity.
- **Design system** *(dev-only, tagged `DEV`)* — the component showcase harness.

Surfaces that do **not** yet have a V2 implementation — Payouts, Certificates,
Achievements, Billing, Support — are **intentionally omitted** from navigation
rather than shown as dead or "coming soon" links. Honest breadth over fake
breadth.

## 5. The shell

`Shell.tsx` provides the application chrome:

```
V2Root (.htv2)                     viewport-bound; owns no scroll
└ V2AppShell (.htv2-shell)         grid: sidebar | workspace
  ├ V2Sidebar (aside.htv2-side)    brand mark + nav; scrolls independently
  └ .htv2-shell-main               top bar + workspace column
    ├ header.htv2-top              breadcrumb + utilities (fixed height)
    └ main.htv2-workspace          THE SINGLE SCROLL OWNER
```

The scroll contract (one owner: the workspace; document is locked; `min-height:0`
linchpins; no page-level horizontal overflow) is specified in full in
`PORTAL_V2_SCROLL_ARCHITECTURE.md` and locked by regression tests. It is a hard
constraint of the rebuild and was preserved intact.

Responsive model: at ≤900px the sidebar collapses to a horizontal top strip and
the workspace (row 2) still owns vertical scroll; stat strips reflow to a 2×2
grid; account panels stack full-width; the attention row wraps cleanly.

## 6. Component system

Presentational primitives (`primitives.tsx`, `primitives.css`) — small, no data
fetching, take already-projected values:

| Primitive          | Purpose |
|--------------------|---------|
| `V2Root`           | Scopes the `.htv2` token/type layer |
| `V2Metal`          | Restrained champagne/metallic for a short brand/hero string (solid fallback; no glow/animation) |
| `V2Button`         | primary / secondary / tertiary / danger; md / sm — compact, low-radius, never a giant CTA |
| `V2Status`         | dot + label (evaluation/funded/payout/completed/failed/hold/neutral) — never a saturated pill |
| `V2Metric`         | muted label over a tabular value, optional sub |
| `V2FinancialValue` | sign-aware tone, tabular numerals |
| `V2Section`        | section title + optional actions |
| `V2Divider` / `V2Card` / `V2EmptyState` | structural |
| `V2StatStrip`      | horizontal label-over-value stats with thin vertical rules — the deliberate alternative to the four-card cliché |
| `V2Attention`      | a quiet action-required row (positive/warning/negative) — rendered ONLY when something authoritative needs action |
| `V2ActivityList`   | compact time · event · amount rows |

Domain-presentational components (also fixture-agnostic):

- `V2AccountPanel(a: V2AccountView)` — one account: masked id, status, balance,
  net P&L, MLL room, lifecycle stepper, and (state-aware) profit-target progress,
  with `onDetails` / `onTrade` actions.
- `V2AccountsView(state: V2AccountsState)` — the accounts list; a discriminated
  state (loading / ready / empty / error) so every non-happy path is explicit.
- `V2AccountDetail(state: V2DetailState, tab)` — the detail surface and its tabs;
  also discriminated (loading / ready / not-found / error).

## 7. Presentational ↔ container seam (the production path)

The rebuild keeps a strict split so production wiring is a drop-in:

```
Authoritative API ─▶ V2AccountsContainer  ─▶ V2AccountsView   (presentational)
Authoritative API ─▶ V2AccountDetailContainer ─▶ V2AccountDetail (presentational)

Dev fixtures     ─▶ PortalV2Review (dev)  ─▶ same presentational components
```

- **Containers** (`V2AccountsContainer`, `V2AccountDetailContainer`) fetch the
  authoritative APIs and project the response into the view models. This is the
  production seam: migrating V2 means mounting the containers, not rewriting the
  presentation.
- **The dev review** (`Review.tsx`) drives the *same* presentational components
  with fixtures — so what Nathan reviews is pixel-identical to what production
  will render, minus the data source.

View-model projection lives in `account-view.ts` / `format.ts`
(`toAccountView`, `formatMoney`, `moneyTone`, `maskAccountId`) — a single place
that turns authoritative summaries into display shapes, so formatting is never
re-invented per component.

## 8. Routing & role-gating

`/portal-v2` renders the dev review shell, gated by `designLabEnabled()`
(`import.meta.env.MODE !== 'production'`), mounted in `App.tsx` **before** the
sign-in gate with no session (it uses fixtures). It routes its own sub-paths
client-side (pushState + popstate); `parseRoute`/`REVIEW_NAV` are exported and
locked by tests:

- `/portal-v2` → Dashboard
- `/portal-v2/accounts` → Accounts
- `/portal-v2/accounts/:id` → Account Detail (tabs)
- `/portal-v2/dev/design-system` → design-system harness (dev-only)
- `/portal-v2/owner` → reached ONLY via the role-gated Owner entry

**Owner Console is role-gated and OFF by default.** A normal customer never sees
it — it is *not rendered* (not hidden, not greyed, not CSS-hidden — absent from
the DOM). It appears only on an explicit dev opt-in (`?role=owner`), and even then
the `/portal-v2/owner` route is a truthful placeholder that points to the real,
server-authorized Owner Console at `/admin`. No fake owner product is rendered
inside the customer portal.

## 9. What was explicitly NOT changed

- Backend, identity, auth/authz, account lifecycle, ledger, P&L, rules, risk,
  payout accounting, economics — untouched. The rebuild is frontend presentation.
- Atlas trading terminal and Owner OS/Owner Console — untouched.
- V1 Portal — untouched; remains the live product and instant rollback.
- The scroll/shell contract — preserved, still regression-locked.

No genuine contract defect was found during the rebuild that required reopening
Resilience / Security / Ops / Economics / Payout / Risk work.

## 10. Tests that lock this architecture

- `scroll-architecture.test.ts` — scroll CSS ownership + honest nav + routing.
- `visual-system.test.ts` — Inter face, tabular numerals, no purple/violet, no
  default browser-blue link, token-based champagne, no default nav underline.
- `design-guardrails.test.ts` — no purple, no purple-range hex, **no default
  (resting-state) link underline** (hover/focus underline is permitted), radii
  ≤8px, borders-first elevation (no heavy SaaS shadows).
- `scripts/portal-v2-scroll.mjs` — real headless-Chromium proof of workspace
  scroll movement across six viewports.

---

## Human-rejection #1 revision (base `25d7738`)

- **Destinations.** The customer sidebar now carries the real set — Dashboard,
  Accounts, Payouts, Certificates, Billing, Support — each a working page
  (`pages.tsx`: `V2PayoutsPage`, `V2CertificatesPage`, `V2BillingPage`,
  `V2SupportPage`) rendering authoritative-shaped records (dev fixtures in the review,
  authoritative endpoints in production via containers), cross-linking to account
  detail. Achievements is omitted (no fake badges).
- **No dev tooling in the customer product.** The design-system harness and its route
  were **deleted**. No Design system / DEV entry, no component/status/lifecycle
  showcase, no engineering language — enforced by `product-surface.test.ts` and the
  live-DOM check in `scripts/portal-v2-review.mjs`.
- **Brand asset.** `apps/web/src/portal/v2/brand/happy-trader-funding-wordmark.png`
  (derivative, rendered) + `…-wordmark.original.jpg` (preserved original). Imported in
  `Shell.tsx` as the sidebar brand; mobile renders it height-constrained in the top
  strip.
- **Owner entry.** Owner Console is never in customer nav. The shell's `V2AccountMenu`
  (a real keyboard/click-outside menu) carries the owner entry for owners only
  (dev `?role=owner`), pointing at the server-authorized `/admin`.
- **Account menu.** Real menu with Sign out (and owner entry for owners); no fake caret.
