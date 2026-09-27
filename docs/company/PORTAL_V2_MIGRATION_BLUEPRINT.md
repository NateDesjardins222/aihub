# PORTAL V2 — MIGRATION BLUEPRINT

**Product Rebuild Phase 0 (STEP 21-24).** The page-by-page plan for the reference-driven Portal V2, when
Nathan returns. Each page keeps its DATA SOURCE and BEHAVIOR and replaces only PRESENTATION, re-bound to
the same server view models. No backend changes. **NO fake metrics, NO placeholder financial charts
masquerading as real data.**

## Order of implementation (recommended)

1. **App shell** (sidebar + topbar + workspace) — everything hangs off it. Foundation built in Phase 0.
2. **Account panel + lifecycle** — the centrepiece; overflow already solved (`V2AccountPanel`/`V2Lifecycle`).
3. **Accounts page**, then **Dashboard**, then **Account detail**, then Payouts / Certificates /
   Achievements / Billing / Support, then Profile/Security.

## Per-page plan

| Page | Data source (existing) | Current component | V2 component | Behavior to preserve | Presentation to replace | Dependencies | Risk |
|---|---|---|---|---|---|---|---|
| **Shell** | session/account switcher | `.pt-top`+`.pt-nav` | `V2AppShell`/`V2Sidebar`/`V2TopBar` | routes, account switch, theme, toasts, RBAC owner entry | horizontal nav → sidebar+topbar; kill underlines | routing in `PortalApp` | Low — presentation only |
| **Dashboard** | `/portal` accounts + analytics | `DashboardPage` | `V2Dashboard` (blueprint below) | data, nav callbacks | 4-giant-card layout → metric bands + account centrepiece | account panel | Low |
| **Accounts** | accounts view | `AccountsPage`+`AccountCard` | `V2AccountsPage` + `V2AccountPanel` | open/nick/archive/reset, Trade routing, slot counts | card visuals, lifecycle overflow | account panel | Low |
| **Account detail** | account detail + analytics | `AccountDetailPage` | `V2AccountDetail` | tabs Overview/Performance/Controls/Rules/Activity | header, tab chrome | performance, controls | Med — many tabs |
| **Performance** | `Analytics` (equity curve, breakdowns) | `Performance` | `V2Performance` | **real** analytics only | chart styling (use existing real series) | dataviz styling | Med — must stay real data |
| **Controls** | personal risk profile | `ControlsView` | restyle later | **all risk controls real** (DO NOT TOUCH logic) | surface styling | risk gate | High-care — safety logic |
| **Payouts** | `PayoutEligibility` + methods | `PayoutsPage`/`PayoutModule`/`PayoutMethodsPage` | `V2Payouts` | eligibility, request, methods | visuals | account panel | Med |
| **Certificates** | cert vault | `CertificatesPage` | `V2Certificates` | vault, verification, render/download | gallery visuals | — | Low |
| **Achievements** | achievements view | `AchievementsPage` | `V2Achievements` | data, public toggle | emblem/grid visuals | — | Low |
| **Billing** | billing view | `BillingPage` | `V2Billing` | data | visuals | — | Low |
| **Support** | ticket domain | `SupportPage` | `V2Support` | tickets, messaging, disputes | visuals | — | Med |
| **Profile / Security / Notifications** | profile + MFA | `ProfilePage`/`MfaPanel` | restyle later | auth/MFA flows | visuals | — | High-care — auth |
| **Owner Console entry** | RBAC | nav link | sidebar item (role-gated) | RBAC visibility | link styling | — | Low |

## Dashboard V2 blueprint (STEP 22)

Avoid the generic "four giant stat cards". Structure, using only data that already exists:

1. **Context band** — greeting + active account switcher (topbar), thin divider.
2. **Account centrepiece** — the active `V2AccountPanel` (balance, net P&L, MLL room, progress,
   lifecycle) — the thing a trader opens the portal to see.
3. **Metric band** — a thin row of `V2Metric`s from real projections (funded count, total net P&L,
   next payout eligibility) with 1px dividers, not boxes.
4. **Performance** — the existing **real** equity/analytics summary (no fabricated chart).
5. **Recent activity** — real recent lifecycle/payout/certificate events.

Every figure cites an existing `/portal` field; anything without a real source is omitted, not faked.

## Account detail blueprint (STEP 23)

Preserve the tabs **Overview / Performance / Controls / Rules / Activity**. Overview = `V2AccountPanel`
enlarged + key metrics; Performance = existing real analytics restyled; **Controls = existing real risk
controls, logic untouched, restyle deferred**; Rules = canonical rule copy (derive from config, no
duplication); Activity = real lifecycle/trade history.

## Payout blueprint

`V2Payouts`: eligibility state (`V2Status`), progress (winning days / consistency / buffer / daily
qualifying balance — all real fields), request form (min/max/split from `PayoutEligibility`), and payout
methods. Request/approval logic unchanged.

## Responsive (STEP 24)

Per `HAPPY_TRADER_DESIGN_SYSTEM_V2.md`: desktop shell; ≤900px sidebar → scrollable strip; mobile single
column; account panels auto-fill; lifecycle grid stays contained; tables stack; forms single-column.

## Guardrails during migration

Each migrated page renders inside `.htv2`, imports only `--ht-*`, passes `design-guardrails.test.ts`, and
adds a layout/overflow check where a component has a known risk (as the lifecycle already does). V1 stays
live until each page reaches parity and Nathan approves; then the V1 page + its `--pt-*` CSS is deleted.
