# PORTAL V2 — PHASE 0 REPORT

**Product Rebuild Phase 0 — reference decomposition + design-system foundation.** No customer-facing
visual rebuild. From checkpoint `9f74a5f`. The live Portal is unchanged; the V2 foundation is isolated
under `apps/web/src/portal/v2/` and reachable only at `/portal-v2` in a **development** build.

> **REFERENCE IMAGE DIRECT INSPECTION: UNAVAILABLE** — no reference screenshot was present in this
> environment. The design system is built from the phase brief's visual requirements; exact values are
> starting ranges pending Nathan's review with the real reference.

## Deliverables
Docs: `PRODUCT_REBUILD_PRESERVATION_MAP.md`, `PORTAL_V1_COMPONENT_MAP.md`,
`HAPPY_TRADER_DESIGN_SYSTEM_V2.md`, `PORTAL_V2_MIGRATION_BLUEPRINT.md`, this report.
Code (isolated, `apps/web/src/portal/v2/`): `tokens.css`, `type.css`, `primitives.tsx`/`.css`,
`Shell.tsx`/`.css`, `Lifecycle.tsx`/`.css`, `AccountPanel.tsx`/`.css`, `Harness.tsx`,
`lifecycle-layout.test.ts`, `design-guardrails.test.ts`; `scripts/portal-v2-lifecycle-overflow.mjs`;
dev-only `/portal-v2` route in `App.tsx`.

## The 50 answers

1. **Starting commit?** `9f74a5f`.
2. **Ending commit?** HEAD of `claude/futures-trading-simulator-v8qefu` after this commit (see closing chat line for the short hash).
3. **Current Portal behavior changed?** No. V1 Portal untouched; V2 is a separate `.htv2`-scoped layer + a dev-only route.
4. **Atlas behavior changed?** No. Not touched.
5. **Preservation map complete?** Yes — `PRODUCT_REBUILD_PRESERVATION_MAP.md` classifies all listed systems (PRESERVE / +RECONNECT / PRESENTATION REPLACE / DEFER / DO NOT TOUCH).
6. **V1 component map complete?** Yes — `PORTAL_V1_COMPONENT_MAP.md` (shell, primitives, all pages, design debt).
7. **V2 design system complete?** Yes (spec) — `HAPPY_TRADER_DESIGN_SYSTEM_V2.md` + reference implementation in code. Exact values pending Nathan.
8. **Font strategy chosen?** Yes.
9. **Exact font?** DM Sans Variable (UI + numbers, tabular via `tnum`); JetBrains Mono reserved for code/audit.
10. **Licensing/source?** SIL OFL; self-hosted `@fontsource-variable/dm-sans` (already a dependency) — production-safe, no new dependency, no CDN.
11. **Typography roles defined?** Yes — 16 role classes in `type.css` (display/page-title/section/body/label/meta/nav/button/table/status/financial-lg/md/sm).
12. **Financial tabular numerals defined?** Yes — `.ht-num` + all `ht-t-fin-*` use `font-variant-numeric: tabular-nums; 'tnum' 1`.
13. **Color tokens defined?** Yes — `tokens.css`, semantic `--ht-*`, scoped to `.htv2`.
14. **Purple excluded from V2?** Yes — none present; enforced by `design-guardrails.test.ts` (keyword + purple-range hex).
15. **Champagne treatment defined?** Yes — `.htv2-metal`, ivory→champagne→silver clipped-text with solid fallback; strict rules (no animation/glow/gold-UI/gradient-everywhere); accessible fallbacks for contrast/print/forced-colors.
16. **Spacing scale?** Yes — 4-based `--ht-space-1..12` (4–48px).
17. **Radius scale?** Yes — `--ht-radius-xs/sm/md/lg` 2/4/6/8px (≤8 on surfaces; 999 pills excepted).
18. **Border system?** Yes — subtle/default/strong/focus + semantic via color-mix; borders-first, no glow.
19. **Sidebar architecture?** Yes — `V2Sidebar`, compact (`--ht-sidebar-w` 164px), subtle active surface, role-gated Owner entry, no underline.
20. **Topbar architecture?** Yes — `V2TopBar`, compact (`--ht-topbar-h` 48px), thin divider, breadcrumb + minimal utilities.
21. **V2 primitives implemented?** Yes, in isolation.
22. **Which primitives?** `V2Root`, `V2Metal`, `V2Button` (primary/secondary/tertiary/danger), `V2Status`, `V2Metric`, `V2FinancialValue`, `V2Section`, `V2Divider`, `V2EmptyState`, `V2Card`, plus shell (`V2AppShell`/`V2Sidebar`/`V2TopBar`), `V2AccountPanel`, `V2Lifecycle`.
23. **Account panel foundation?** Yes — `V2AccountPanel` takes a projected `V2AccountView` (never raw API); hierarchy product/masked-id/status → balance → net P&L / MLL room → progress → lifecycle → View details / Trade.
24. **Lifecycle foundation?** Yes — `V2Lifecycle`, CSS-grid, overflow-proof by construction.
25. **Lifecycle overflow tests?** Yes — deterministic structural test (`lifecycle-layout.test.ts`) + real-browser `scripts/portal-v2-lifecycle-overflow.mjs`.
26. **Widths tested?** 1920 / 1440 / 1280 / 1024 / 768 / 390 — **all contained** (docOverflow 0, no stage escape, no negative dims).
27. **Button system?** Yes — 4 variants, 30–36px height, low radius, champagne primary (STEP 19).
28. **Status system?** Yes — dot + label, restrained, per kind (STEP 20).
29. **Dashboard migration blueprint?** Yes — metric bands + account centrepiece + real performance + recent activity; no fake metrics/charts.
30. **Account page blueprint?** Yes — `V2AccountsPage` + `V2AccountPanel`, preserving open/nick/archive/reset + Trade routing.
31. **Account detail blueprint?** Yes — tabs Overview/Performance/Controls/Rules/Activity preserved; visuals rebuilt later; controls logic untouched.
32. **Payout blueprint?** Yes — eligibility/progress/request/methods on real `PayoutEligibility` fields.
33. **Remaining page blueprints?** Yes — Certificates, Achievements, Billing, Support, Profile/Security, Owner-entry (`PORTAL_V2_MIGRATION_BLUEPRINT.md`).
34. **Responsive architecture?** Yes — desktop / ≤900px strip / mobile; sidebar, topbar, account panel, lifecycle, tables, forms, buttons specified.
35. **Development visual harness?** Yes — `PortalV2Harness` at `/portal-v2` (typography, colours/surfaces, buttons, status, metrics, account panels, lifecycle, empty state).
36. **Is harness isolated from customers?** Yes — gated by `designLabEnabled()` (dev builds only; falls through to 404 in production), rendered before the sign-in gate, no session, no real data, not in customer nav.
37. **Any V1 regressions?** No — V1 Portal code unchanged; only `App.tsx` gained a dev-only route branch. Regression suite green (see below).
38. **Owner Console RBAC preserved?** Yes — untouched; V2 sidebar shows the Owner entry only when `showOwner` (role-gated), same as V1.
39. **Risk controls preserved?** Yes — untouched (DO NOT TOUCH).
40. **Trade routing preserved?** Yes — the `?account=` hand-off is unchanged.
41. **Backend code changed?** No.
42. **If yes, why?** N/A.
43. **Focused tests?** V2: 2 files / 17 tests pass (lifecycle contract + logic, design guardrails). Browser overflow script: 6/6 widths pass.
44. **Typecheck?** Clean (web + all projects).
45. **Build?** Clean (see closing).
46. **Canonical?** Run once — result in the closing section.
47. **P0/P1 discovered?** None. (Two self-test flaws in the new guardrail test were corrected during authoring; not product defects.)
48. **Exact final commit?** See closing chat line.
49. **What should be implemented first when Nathan returns?** The **app shell** (sidebar + topbar + workspace) wired to the real routes, then the **Accounts page** using `V2AccountPanel`/`V2Lifecycle` — the highest-impact, lowest-risk swap, and the account panel is the centrepiece.
50. **What specifically requires Nathan's visual judgment?** The exact champagne hue/gradient, surface-step values, sidebar width, where the metallic emphasis appears, overall density, light-mode, and sign-off against the real reference screenshot. All are token/prop changes in the built system.

## Validation
- V2 focused tests: 2 files / 17 pass. Lifecycle overflow (real Chromium): 6/6 widths contained.
- Typecheck: clean. Build: clean. V1 regression: green. Canonical: run once (closing).
- **P0/P1: 0.** No live Portal or Atlas change. No backend change.

## Definition of done — status
Preservation boundary explicit ✓ · V1 mapped ✓ · V2 design system specified ✓ · font production-safe ✓ ·
colours tokenised ✓ · spacing/radii/borders systematic ✓ · champagne rules strict ✓ · app shell defined ✓ ·
sidebar/topbar defined ✓ · account-panel architecture ✓ · lifecycle overflow structurally solved ✓ ·
responsive defined ✓ · page migrations mapped ✓ · reusable primitives in isolation ✓ · dev-only harness ✓ ·
V1 intact ✓ · Atlas untouched ✓ · canonical healthy ✓ · no customer-facing redesign declared ✓.

**Then STOP. Do not migrate the live Portal. Do not start Atlas V2. Wait for Nathan.**
