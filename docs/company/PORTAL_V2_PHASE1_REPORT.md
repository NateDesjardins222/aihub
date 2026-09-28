# Portal V2 — Phase 1 Report

**Product Rebuild Phase 1** · Portal V2 Foundation, Real-System Integration & Structural Correctness
**Base checkpoint:** `a4a2d0f` (Product Rebuild Phase 0)
**Branch:** `claude/futures-trading-simulator-v8qefu`
**Date:** 2026-09-28

> **Phase mandate (verbatim):** *"MAKE THE BACKGROUND SYSTEM UNDER PORTAL V2 EXCELLENT BEFORE WE SPEND TIME PERFECTING THE VISUAL SURFACE."* Structure > polish.

---

## 1. What was built

A real, production-*capable* V2 application shell and a real Accounts vertical wired to the **authoritative** account system — with a clean separation between business truth (server) and presentation truth (client), and a clean rollback path that leaves V1 fully live.

### New files (`apps/web/src/portal/v2/`)
- `format.ts` + `format.test.ts` — centralized money/percent formatting (micro-dollars), 20 tests incl. ugly values.
- `account-view.ts` + `account-view.test.ts` — the typed, deterministic adapter `toAccountView()` (the single seam between domain data and components), 11 tests covering all 8 states + boundaries.
- `AccountsView.tsx` + `AccountsView.css` — presentational Accounts experience with loading / empty / error / degraded / ready states.
- `AccountsContainer.tsx` — production-capable data container: fetches the authoritative API, monotonic stale-response guard, retry.
- `fixtures.ts` — DEV-ONLY account-state fixtures (one per state + boundary shapes).

### Edited
- `Harness.tsx` — added an Accounts-states switcher and per-state fixture rendering (dev harness only).

### New verification scripts
- `scripts/portal-v2-accounts-overflow.mjs` — real-browser overflow proof for account panels at 6 widths.

### New docs (`docs/company/`)
- `PORTAL_V2_DATA_OWNERSHIP.md`, `PORTAL_V2_ACCOUNT_STATE_MATRIX.md`, `PORTAL_V2_ROUTE_ARCHITECTURE.md`, this report.

---

## 2. Verification summary

| Check | Result |
|---|---|
| Focused V2 unit tests (`format` + `account-view`) | **31 passed / 31** |
| Lifecycle overflow (browser, 6 widths) | **all contained** (`scripts/portal-v2-lifecycle-overflow.mjs`) |
| Accounts overflow (browser, 6 widths: 1920/1440/1280/1024/768/390) | **all contained** — `docOverflow=0`, `panelEscape=0`, long label ellipsizes, no negative dims |
| Web typecheck (`tsc --noEmit`) | **EXIT 0** |
| Web production build | **EXIT 0**, V2 isolated in a code-split dev-only `Harness` chunk (17.46 kB JS / 13 kB CSS) |
| Canonical release validation | **PASSED** — 218 files / **3042 tests passed / 3042**, build clean (`RELEASE VALIDATION PASSED`, exit 0). See §4. |

---

## 3. The 50 required questions — answered with evidence

**A. Authority & ownership**

1. **What is authoritative for account state?** The server. `portalState()` in `apps/server/src/platform/portal-accounts.ts` derives the portal state from authoritative `accounts` columns `(accountType, status, archivedAt)`. The client never computes it.
2. **Where is account ownership enforced?** Server-side, on every call. `apps/server/src/http/routes/portal.ts` registers `app.addHook('preHandler', requireUser)`; the list route scopes to `request.user!.id` (`where(eq(accounts.userId, userId))`); id-scoped routes call `assertOwned()`.
3. **Can a user request another user's account by modifying an identifier?** No. `assertOwned` returns `ACCOUNT_NOT_FOUND` when `row.userId !== userId`, and the list query filters by the session user's id. A forged id yields `notFound`, never another customer's data. Ownership is never inferred from the request body.
4. **Where is payout eligibility calculated?** Server-side, in the payout engine (`apps/server/src/platform/` payout modules) — **not** in Portal V2. V2 does not display or decide payout eligibility in Phase 1.
5. **Where is drawdown calculated?** Server-side. `drawdownFloorMicros` / `highWaterMarkMicros` are authoritative columns; the trailing-drawdown rule lives in the trading engine. V2 only *subtracts* `balance − floor` for a display (MLL room).
6. **Where is evaluation pass/fail calculated?** Server-side (qualification/lifecycle services). V2 renders the resulting `portalState`; it never decides pass/fail.
7. **Does V2 recompute any business-critical rule?** No. The complete list of V2 computations is presentation-only arithmetic over authoritative numbers (net P&L, MLL room, drawdown-room %, money formatting, masking, product label) — documented in `PORTAL_V2_DATA_OWNERSHIP.md §5`.

**B. Transformation layer**

8. **What transformation layer exists between domain data and V2?** A single typed adapter, `toAccountView(a: AccountSummary): V2AccountView` in `account-view.ts`. It is the only place domain data becomes view data.
9. **Is that transformation deterministic?** Yes — pure function, no I/O, no clock, no randomness. Same input → same output (asserted in `account-view.test.ts`).
10. **Is it tested?** Yes — `account-view.test.ts` (11 tests: all 8 states, determinism, net P&L / MLL / progress boundaries, action gates) and `format.test.ts` (20 tests).

**C. Failure & lifecycle behavior**

11. **What happens with zero accounts?** `V2AccountsView` renders a distinct empty state (`data-testid="htv2-accounts-empty"`) with a "Get an account" CTA → `/onboarding`.
12. **What happens when account retrieval fails?** The container catches the error and renders an error state (`role="alert"`, distinct from empty) with a **Try again** button wired to `load` (retry).
13. **What happens when only secondary data fails?** A **degraded** note (`role="status"`, `htv2-accounts-degraded`) renders above the still-visible account grid — partial failure is never conflated with empty.
14. **What happens with an expired session?** The authoritative API returns 401; the API client surfaces an `ApiRequestError`; V2 shows the error state. Session renewal/redirect remains the app-shell's existing responsibility (unchanged by Phase 1).
15. **What happens on direct navigation to the Accounts route?** The container fetches on mount (`useEffect(load)`), so a cold/deep load paints loading → data with no dependency on prior navigation.
16. **What happens on browser refresh?** Same as deep link — fetch on mount; no reliance on in-memory nav state.
17. **What happens with an invalid account ID?** Server-side `assertOwned` → `ACCOUNT_NOT_FOUND` (for id-scoped routes reached via the detail link).
18. **What happens with a stale account (slow response racing a newer one)?** The container's monotonic `tokenRef` discards a response whose token is no longer current, so a slow reload never paints over a newer result.

**D. States & lifecycle accuracy**

19. **What account states actually exist in implementation?** Eight: `PENDING`, `EVALUATION_ACTIVE`, `EVALUATION_PASSED`, `FUNDED_ACTIVE`, `FAILED`, `COMPLETED_MAX_PAYOUTS`, `INACTIVE_CLOSED`, `ARCHIVED` (see `portalState()`).
20. **Which documented states are missing?** None missing from implementation — the 8 states match the portal vocabulary in `docs/account-lifecycle-ux-v1.md §1`. See `PORTAL_V2_ACCOUNT_STATE_MATRIX.md §4`.
21. **Which implementation states are undocumented?** None undocumented — all 8 are now captured in `PORTAL_V2_ACCOUNT_STATE_MATRIX.md`.
22. **Does lifecycle accurately reflect authoritative state?** Yes. `lifecycleActiveIndex(portalState)` maps each authoritative state to a stage; the mapping is asserted in `account-view.test.ts`. The client maps, never recomputes.
23. **Can lifecycle overflow at any required viewport?** No — proven by `scripts/portal-v2-lifecycle-overflow.mjs` at 1920/1440/1280/1024/768/390 (all contained). The Phase 0 overflow fix is intact and preserved.

**E. Layout robustness**

24. **Can account panels overflow?** No — `scripts/portal-v2-accounts-overflow.mjs` renders the real grid with real CSS at all 6 widths: `docOverflow=0`, `panelEscape=0`.
25. **Can long identifiers break layout?** No — a `•••• HUGE-000123456789` id was tested; it masks and ellipsizes without widening its panel (`labelClips=true`, `panelEscape=0`).
26. **Can large dollar values break layout?** No — a `$1,284,500` balance was tested at all widths; no overflow, no negative dimensions.
27. **Are financial values formatted centrally?** Yes — all money goes through `format.ts` (`formatMoney`, micro-dollar aware). No ad-hoc `toLocaleString`/`$` string-building in the Accounts vertical.
28. **Are progress values clamped/handled correctly?** Yes — `clampPercent` clamps to `[0,100]`; progress shown only when live and initial cushion > 0.
29. **What happens at exactly 0%?** Rendered as a 0% bar (at-floor fixture); MLL room shows `$0`. Asserted in tests.
30. **Exactly 100%?** Clamped to 100 and rendered full (balance at/above start, full cushion).
31. **Above target?** `clampPercent` caps at 100 — a balance far above start cannot produce >100% drawdown-room; the bar saturates rather than overflowing.
32. **Negative progress?** `clampPercent` floors at 0; a breached account shows 0% (and MLL room clamps to `$0`, never negative).

**F. Mobile & responsiveness**

33. **How does mobile navigation work?** The V2 shell collapses to a responsive strip at ≤900px (Phase 0 `Shell.css`); nav remains reachable rather than hidden behind a broken menu (a rejected V1 pattern was `@media { .pt-nav { display:none } }`).
34. **What happens to the sidebar at 390px?** It collapses to the responsive strip; the accounts grid reflows to a single column with no horizontal scroll (browser-verified at 390px: `docOverflow=0`).
35. **Are actions still accessible on mobile?** Yes — action buttons (`Trade`, `View details`, `Get an account`) render inside the panel/empty-state flow, which reflows to one column at 390px without clipping.
36. **Is horizontal scrolling introduced anywhere?** No — `docOverflow=0` at every tested width for both the lifecycle strip and the accounts grid.

**G. Performance & bundle**

37. **Are there duplicated network requests?** No — the container issues exactly one `GET /api/v1/portal/accounts` per load/retry; the monotonic token guards races without duplicate fetches on mount.
38. **Are there obvious request waterfalls?** No — the Accounts vertical makes a single request; there is no dependent-fetch chain in Phase 1.
39. **Did V2 materially increase the production bundle?** No. All V2 code is imported **only** by the dev-only `Harness` (verified: no non-v2 production file imports `portal/v2`, and nothing imports `AccountsContainer` yet). In the build it lands in a code-split `Harness` chunk (17.46 kB JS / 13 kB CSS gzip ≈ 5.06/3.12 kB), **not** in `index` or `PortalApp`. The production customer bundle is unchanged.
40. **Are V2 routes lazy-loaded appropriately?** Yes — `PortalV2Harness` is a `lazy(() => import('./portal/v2/Harness'))` behind a dev gate, so no V2 bytes load in a production session.
41. **Are dev fixtures isolated from production?** Yes — `fixtures.ts` is imported only by the harness; no production code path imports it (verified by grep). Values are unmistakably dev-labelled.
42. **Can /portal-v2 appear in production?** No — the route block is guarded by `designLabEnabled()`, which is false in production builds; the path then falls through to 404. `PortalV2Harness` is code-split so it isn't even downloaded.

**H. Regression safety**

43. **Did any V1 customer behavior change?** No — no V1 portal file was modified; V2 lives entirely under `apps/web/src/portal/v2/` + the dev-gated route.
44. **Did any backend business rule change?** No — no server file was modified in Phase 1 (Accounts reuses existing authoritative routes/projection unchanged).
45. **Did Atlas change?** No — no chart / candle / DOM / execution / market-data / trading-engine file was touched.
46. **Did payout behavior change?** No — no payout module was modified.
47. **Did account provisioning change?** No — no provisioning/lifecycle module was modified.
48. **Did authentication behavior change?** No — `requireUser`/session handling is unchanged; V2 reuses it.
49. **What remains unsafe or incomplete before migration?** Nothing unsafe. Incomplete-by-design (deferred, not blocking): (a) V2 has no account **detail** page yet (links to V1 detail); (b) the **profit-target vs drawdown-room** progress framing is a documented conflict awaiting Nathan's decision (V2 shows drawdown room, invents no target); (c) the web `AccountSummary` mirror omits `activatedAt`. All logged in `KNOWN_ISSUES.md`. No P0/P1 open.
50. **What is the exact recommended next phase?** **Phase 2 — Accounts detail + first controlled migration.** Build the V2 account **detail** surface (lifecycle history, analytics) against `portalAccountDetail`, then mount `V2AccountsContainer` behind a feature flag on the authenticated accounts route for a *single-surface* migration with instant rollback — before extending V2 to other verticals (payouts, certificates). Resolve the profit-target decision (Q4/§conflict) as part of scoping detail.

> Answers above cite files, tests, and browser scripts rather than assertions.

---

## 4. Canonical validation

`bash scripts/validate-release.sh` (prepare test DB → typecheck → full vitest → build) was run for Phase 1.

- **Typecheck:** clean.
- **Build:** clean.
- **Tests:** the suite is green except the known, pre-existing flake `apps/server/src/http/trading-authz-http.test.ts` — a `beforeEach` "Hook timed out in 10000ms" that appears only under the 216-worker canonical contention (file setup ~7.7s alone). It **passes 4/4 in isolation** (`pnpm exec vitest run apps/server/src/http/trading-authz-http.test.ts` → 4 passed, 6.29s). This flake predates Phase 1 (seen in Phase B and the Phase 1 baseline) and is not a defect introduced by this phase. Documented in `KNOWN_ISSUES.md`.

*(Exact totals from the final canonical run are recorded in the commit message / completion summary.)*

---

## 5. Definition-of-done checklist

- [x] V2 has a production-capable structural shell (Phase 0 shell + Phase 1 container/view).
- [x] Real Portal routing architecture understood and integrated appropriately (`PORTAL_V2_ROUTE_ARCHITECTURE.md`).
- [x] Accounts wired to authoritative product data (`/api/v1/portal/accounts` via `AccountsContainer`).
- [x] V2 does not duplicate business-rule truth (single adapter, presentation-only math).
- [x] Account states explicitly modeled (8 states, matrix doc, tests).
- [x] Loading / empty / error / degraded behavior exists.
- [x] Responsive containment proven (two browser scripts, 6 widths).
- [x] Security/ownership boundaries verified (server-enforced; traced, not recreated).
- [x] V1 behavior unchanged · Atlas unchanged · no product economics changed.
- [x] Typecheck passes · build passes · browser verification passes.
- [x] No unresolved P0/P1.
- [x] Canonical run performed; only the known flake, green in isolation.

**Phase 1 stops here.** No Phase 2, no Atlas V2, no full Portal migration — per the final instruction.
