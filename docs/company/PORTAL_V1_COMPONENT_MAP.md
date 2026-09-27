# PORTAL V1 — COMPONENT MAP

**Product Rebuild Phase 0 (STEP 3-4).** Inventory of the current customer Portal, with a migration
disposition per piece, and the objective design debt found. Nothing is deleted in Phase 0. Source:
`apps/web/src/portal/`.

## Disposition legend
KEEP BEHAVIOR · KEEP STRUCTURE · REPLACE PRESENTATION · REBUILD · DELETE AFTER MIGRATION · UNKNOWN

## Shell & routing

| Piece | File | Disposition | Notes |
|---|---|---|---|
| Portal app / router | `portal/PortalApp.tsx` | KEEP BEHAVIOR, REBUILD shell | `Route` union + `parseRoute`/`routePath` (pathname+hash) preserved; the `.pt-top` horizontal header + `.pt-nav` become the V2 sidebar+topbar shell. |
| Nav model | `NAV[]` in PortalApp | KEEP | dashboard, accounts, payouts, certificates, achievements, billing, support (+ account, review, profile, verify). Maps 1:1 to `PORTAL_V2_NAV`. |
| Global account switcher / theme / toasts | PortalApp | KEEP BEHAVIOR | Re-presented in the V2 topbar. |
| Portal stylesheet | `portal/Portal.css` (~21 KB, `--pt-*`) | DELETE AFTER MIGRATION | Replaced by the scoped `--ht-*` V2 layer; removed only once every page is migrated. |

## Shared primitives (`portal/lib.tsx`)

| Primitive | Disposition | V2 replacement |
|---|---|---|
| `money`/`pct`/`tone`/`stateLabel`/`badgeClass`/`familyOf` (formatters) | **KEEP BEHAVIOR** | Reused as-is; V2 is presentation only. |
| API view types (`AccountSummary`, `Analytics`, `Cert`, `PayoutEligibility`, …) | **KEEP** | Feed V2 via projections (e.g. `V2AccountView`). |
| `Card` | REPLACE PRESENTATION | `V2Card` |
| `Money` | REPLACE PRESENTATION | `V2FinancialValue` |
| `Metric` | REPLACE PRESENTATION | `V2Metric` |
| `Pill` | REBUILD | `V2Status` (dot + label, not a saturated pill) |
| `Toggle` | REPLACE PRESENTATION | V2 toggle (rebuild pass) |
| `Skeleton` | REPLACE PRESENTATION | V2 loading state |
| `EmptyState` | REPLACE PRESENTATION | `V2EmptyState` |
| `AccountPath` (lifecycle) | **REBUILD** | `V2Lifecycle` — **overflow fixed structurally** (grid, not flex+fixed connectors). |

## Pages (`portal/pages/`)

| Page | Disposition | Preserve | Replace |
|---|---|---|---|
| `DashboardPage` | REPLACE PRESENTATION | data + nav callbacks | layout → reference dashboard |
| `AccountsPage` + `AccountCard` | REBUILD (presentation) | data, actions (open/nick/archive/reset), Trade routing | card → `V2AccountPanel` |
| `AccountDetailPage` | REPLACE PRESENTATION | tabs Overview/Performance/Controls/Rules/Activity | visuals |
| `Performance` | REPLACE PRESENTATION | real analytics (equity curve, breakdowns) | chart styling |
| `ControlsView` | KEEP BEHAVIOR | real risk controls | restyle later (not Phase 0) |
| `PayoutsPage` / `PayoutModule` / `PayoutMethodsPage` | REPLACE PRESENTATION | eligibility/request logic | visuals |
| `CertificatesPage` | REPLACE PRESENTATION | vault/verification/render | visuals |
| `AchievementsPage` | REPLACE PRESENTATION | data + public toggle | visuals |
| `BillingPage` | REPLACE PRESENTATION | data | visuals |
| `SupportPage` | REPLACE PRESENTATION | ticket domain | visuals |
| `ProfilePage` / `MfaPanel` | KEEP BEHAVIOR | security/MFA flows | restyle later |
| `ReviewPage` | KEEP BEHAVIOR | enforcement review/appeal | restyle later |
| `VerifyPage` | KEEP | public cert verification (pre-gate) | out of Portal V2 shell |

## Objective design debt found (STEP 4)

Scanned `portal/Portal.css` + components. Documented, **not** auto-replaced.

- **Radius too large:** `--pt-radius: 10px`, `--pt-radius-sm: 7px`; V2 target ≤8px (mostly 2–6).
- **Heavy shadow:** `--pt-shadow: 0 1px 2px …, 0 8px 30px rgba(0,0,0,.35)` — a SaaS drop shadow; V2 is borders-first.
- **Amber-gold, not champagne:** `--pt-gold: #c8a24a`, `--pt-warn: #d8a84a`, gold emblem `linear-gradient(135deg,var(--pt-chrome),var(--pt-dim))` — reads yellow-gold; V2 uses restrained ivory/champagne.
- **Link underline (rejected):** `.pt-link:hover { text-decoration: underline; }`.
- **Pills:** `.pt-badge { border-radius: 999px }` saturated status pills → V2 dot+label.
- **Lifecycle overflow (known bug):** `.pt-path { display: flex }` + `.pt-path-step::after { width: 26px; margin: 0 9px }` → fixed intrinsic width escapes the card. **Fixed** in `V2Lifecycle`.
- **Mobile nav breaks:** `@media (max-width: …) { .pt-nav { display: none } }` — nav disappears on narrow widths (no replacement). V2 shell collapses the sidebar to a scrollable strip instead.
- **Raw hex scattered:** ~30 distinct raw hex values in `Portal.css` (e.g. `#7aa2d6`, `#e0645f`, gold ramp) rather than a single token source. V2 centralises all colour in `tokens.css`.
- **Inline styles:** several pages use `style={{ marginTop: … }}` ad-hoc spacing (`AccountCard`, others) → V2 uses the spacing scale.
- **Purple:** **none found** in the current `--pt-*` tokens (accent is blue `#7aa2d6`). The owner's "purple doesn't fit" likely referred to an earlier iteration or the terminal's `--link-purple` chart-link colour; V2 excludes purple regardless (enforced by `design-guardrails.test.ts`).

## Not deleted

Every V1 file remains and keeps working. Deletion happens only in the rebuild, page by page, after each
V2 page reaches parity and Nathan approves.
