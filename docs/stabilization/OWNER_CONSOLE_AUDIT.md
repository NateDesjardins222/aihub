# Owner Console Audit & Stabilization — Phase 1

**Standard for this milestone:** not "tests pass" but "an actual owner can open the
application and use it." Verified in a real browser (Chromium via Playwright) against
the full local stack (web :5173 → API :4000 → PostgreSQL 16), signed in as the seeded
owner (`owner@atlasfutures.local`, SUPER_ADMIN). Viewports checked: 1440×900,
1920×1080, 1366×768.

Starting HEAD: `2d0f703` · Branch: `claude/futures-trading-simulator-v8qefu`.

## Environment note (how the browser audit was made possible)

The cloud container has no Docker, but ships the PostgreSQL 16 binaries. A local
cluster was initialised and started as an unprivileged user (`initdb`/`pg_ctl` under
`ubuntu`), the `atlas` role/DB created, migrations applied, and both seeds run
(`db:seed` + `seed-htf-products`). The full API then booted normally, so the console
was audited with **real backend data**, not by reading React files.

---

## 1. Scrolling — ROOT CAUSE AND FIX (the headline complaint)

**Reported:** "I cannot properly scroll down the console."

**Root cause (found in the browser + code):** `apps/web/src/styles/theme.css` locks the
whole app to the viewport for the trading terminal —
`html, body, #root { height: 100% }` and `body { overflow: hidden }`. The Owner
Console shell `.adm` used `min-height: 100vh` and its content region `.adm-main` was
**not a scroll container** (`overflow-y: visible`). So any console page taller than the
viewport grew the shell past the screen, where the viewport-locked body clipped it with
**nowhere to scroll**. Measured: `body` height 900, `overflow-y:hidden`; `.adm-main`
`overflow-y:visible`, `scrollHeight === clientHeight`, window scroll pinned at 0.

**Fix (`apps/web/src/admin/Admin.css`), root cause not a workaround:**
- `.adm` → `height: 100vh; overflow: hidden` (was `min-height: 100vh`): the shell is
  exactly the viewport, a proper app-shell frame.
- `.adm-main` → `min-height: 0; overflow-y: auto; overflow-x: hidden`: the content
  region is the single scroll container; `min-height:0` lets the flex child shrink so
  it scrolls internally instead of growing the shell.

**Verified in browser:** Economics (M13) after running a model is 3,962px tall in an
854px content area and now scrolls fully top→bottom (`reachedBottom: true`); Command
Center scrolls at 1366×768 and correctly does not when content fits at 1920×1080. The
header stays fixed while the body scrolls. No page is trapped.

---

## 2. Header collapse / content overlap on tall pages — FIXED

While fixing the nav (see §3) the header became a wrapping two-row bar. On very tall
pages (e.g. Products, ~5,600px) the header then **collapsed from 115px to 46px** and
its wrapped nav rows overflowed on top of the page content. Root cause: `.adm-top` had
default `flex-shrink: 1`, so the flex column squeezed it to `min-height` under the
space pressure of tall `.adm-main` content. **Fix:** `.adm-top { flex-shrink: 0 }`.
Verified: `.adm-top` stays 115px and `.adm-main` starts at 115px on both a short page
(Command) and a tall page (Products); no overlap.

---

## 3. Navigation — 6 destinations were unreachable — FIXED

**Found in browser:** the top bar rendered 22 nav items in a single non-wrapping row
(`.adm-nav { flex-wrap: nowrap }`, `.adm-top { overflow-x: visible }`). At 1440px the
last **6 items overflowed off the right edge and were unreachable from the nav**:
**Products, Ops System, System, Infrastructure, Staff & Access, Certificate Store** —
i.e. product configuration, System Doctor, provider/infra health, staff/RBAC, and the
certificate store were all invisible to the owner. This directly matches "major systems
that were supposedly implemented do not appear clearly in the console."

**Fix:** the header now wraps — brand + account controls on row 1, the full nav on a
wrapping second row (`.adm-top { flex-wrap: wrap }`, `.adm-nav { flex-basis: 100%;
flex-wrap: wrap }`). Verified: `offscreenCount: 0` — all 22 destinations visible and
clickable. No JSX change; CSS only.

---

## 4. Owner route inventory (browser-observed)

All 22 routes were opened in the browser signed in as owner. **Every route loads and
renders real, backend-connected data.** Most figures are zero because the database was
freshly seeded (2 users, 4 demo accounts, 0 payouts/customers/tickets) — these are
**correct empty states, not placeholders or fake data.**

| # | Page | Route | Status | Data | Notes |
|---|------|-------|--------|------|-------|
| 1 | Command Center | /admin/command | WORKING | real | KPIs, System Doctor HEALTHY, Integrity OK; "Nothing needs you right now" empty state correct |
| 2 | Overview | /admin | WORKING | real | users/accounts/positions/fills/P&L stats + recent activity |
| 3 | Traders | /admin/traders | WORKING | real | 2 traders listed, filters present |
| 4 | Accounts | /admin/accounts | WORKING | real | 4 demo accounts, status filters |
| 5 | Customers & commerce | /admin/customers | WORKING | real | reconciliation counters (all 0), find-a-customer |
| 6 | Trading | /admin/trading | WORKING | real | firm positions/orders/fills (empty), exposure |
| 7 | Risk | /admin/risk | WORKING | real | nearest-limit / largest-loss / holds / failures tables |
| 8 | Funding | /admin/funding | WORKING | real | funding decision queue (empty) |
| 9 | Payouts | /admin/payouts | WORKING | real | firm exposure stats + queue |
| 10 | Affiliates | /admin/affiliates | WORKING | real | program overview, applications, directory, config, jobs |
| 11 | Support | /admin/support | WORKING | real | SLA/inbox counters, inbox |
| 12 | Enforcement | /admin/enforcement | WORKING | real | cases/holds/appeals + workspace |
| 13 | Payout Ops | /admin/payout-operations | WORKING | real | fast-lane/exceptions/reconciliation/treasury tabs |
| 14 | Economics | /admin/economics | WORKING (legacy) | simulation | v1 simulator; **duplicated by #15** — see §6 |
| 15 | Economics (M13) | /admin/economics/v2 | WORKING | simulation | M13.0 engine; clearly labelled MODELED/SIMULATION |
| 16 | Audit | /admin/audit | WORKING | real | audit log with entries, filters |
| 17 | Products | /admin/products | WORKING | real | **shows stale + intended products mixed** — see §5 |
| 18 | Ops System | /admin/ops-system | WORKING | real | System Doctor, integrity, reconciliation, providers, jobs |
| 19 | System | /admin/system | WORKING | real | API/DB/market-data/audit-chain health |
| 20 | Infrastructure | /admin/infrastructure | WORKING | real | provider health, read-only |
| 21 | Staff & Access | /admin/staff | WORKING | real | staff/RBAC + invitations |
| 22 | Certificate Store | /admin/certificate-store | WORKING | real | physical-cert orders + fulfilment |

No dead pages, no broken layouts, no clipped content (horizontal-overflow scan: **NONE**
at 1366/1440/1920 across all pages), no crashes. Console errors: exactly two per initial
load, both a benign `401 /api/v1/auth/me` (see §7).

---

## 5. Product source-of-truth matrix (REPORTED — not changed)

Per the milestone, product/business rules were **not** modified. The disagreements
found:

**What the owner's Products page shows (27 profiles in the DB):**
- **Intended commercial catalog (correct):** 10 HTF evaluations — `htf-core-25k/50k/100k/300k`,
  `htf-select-25k/50k/100k`, `htf-daily-25k/50k/100k` — plus their 10 funded destinations.
- **Stale legacy Atlas templates (should not be customer-facing):** `evaluation-50k`,
  `evaluation-100k`, `evaluation-150k`, `intraday-trailing-50k`, `static-100k`,
  `practice-100k`, `practice-150k` — generic names, **wrong sizes (50/100/150K)**, not
  part of the intended CORE/SELECT/DAILY line-up.

| Location | What it believes the products are |
|----------|-----------------------------------|
| Shared catalog `@atlas/contracts/product-catalog.ts` | The intended 10 (CORE/SELECT/DAILY, 25/50/100/300K), EOD-trailing drawdown |
| DB `db:seed` (`seed.ts`) | 7 generic "Atlas" templates (Evaluation/Intraday/Static/Practice) at 50/100/150K — legacy |
| DB `seed-htf-products.ts` | The 10 HTF products, **STATIC drawdown at 4%** |
| Owner Console → Products | The union of both (27 profiles) — stale + intended mixed |
| Checkout / provisioning | Resolve products by key from the DB profiles (so they can pick either set) |

**Drawdown divergence (confirmed on screen):** the marketing catalog and the HTF
"funded" cards use different drawdown models than the legacy templates —
`htf-core-100k` shows **STATIC** ($4,000) while `evaluation-100k` shows **EOD_TRAILING**
($3,000); the shared catalog documents EOD-trailing. This is the same divergence flagged
in M13.0. **Recommendation (owner decision, later milestone):** retire the 7 legacy
templates (set status RETIRED) and reconcile the HTF drawdown model to the intended
EOD-trailing. Not done here because it changes product rules and requires an owner
decision.

---

## 6. Duplicate concept: two Economics pages

The nav exposes both **Economics** (legacy v1 simulator, scenarios like
GOOD_FOR_FIRM/HIGH_FRAUD) and **Economics (M13)** (the M13.0 engine that supersedes it).
Both work; both are clearly labelled synthetic/modeled. Left in place (removing a working
feature is out of scope for a stabilization audit); flagged for consolidation in a later
pass.

---

## 7. Data-connection audit

Every visible metric traces to a real source. Classification:
- **Real database data:** Command Center KPIs, Overview, Traders, Accounts, Customers,
  Risk, Funding, Payouts, Affiliates, Support, Enforcement, Audit, Products, Staff,
  Certificate Store.
- **Real provider/health data:** System, Ops System (System Doctor, integrity,
  reconciliation), Infrastructure (provider health; market data shows `yahoo-delayed`).
- **Simulation (clearly labelled):** Economics and Economics (M13) — both explicitly
  MODELED/SIMULATION, never presented as operating data. Confirmed unchanged.
- **Placeholder / hardcoded / fake:** none found presented as real operating data.

`401 /api/v1/auth/me` (2 per initial page load): **benign, low severity.** On a fresh
page load `session.ts boot()` calls `/auth/me` before the in-memory access token is
re-obtained; the API client (`api/client.ts`) transparently refreshes once on 401 and
retries, so authentication succeeds and all data loads. In normal SPA use (client-side
nav, no reload) this happens once per session. Left as-is: pre-refreshing to remove the
intermediate 401 would touch the auth boot path used by the entire app (terminal,
portal, checkout) — disproportionate risk for a cosmetic console log during boot.

---

## 8. Fixes applied this milestone (all CSS in `apps/web/src/admin/Admin.css`)

1. `.adm` → viewport-height frame (`height: 100vh; overflow: hidden`).
2. `.adm-main` → single scroll container (`min-height: 0; overflow-y: auto`).
3. `.adm-top` → non-shrinking (`flex-shrink: 0`), wrapping two-row header.
4. `.adm-nav` → full-width wrapping row so all 22 destinations are reachable.

No JSX, no backend, no business rules changed. No features deleted. No data faked.

---

## 9. Remaining Owner Console issues (documented, not fixed here)

- **Product reconciliation (owner decision):** retire the 7 legacy Atlas templates and
  reconcile HTF drawdown model (STATIC vs EOD-trailing). §5.
- **Consolidate the two Economics pages.** §6.
- **Nav scale:** 22 items on two wrapping rows is functional but busy; a grouped nav
  (e.g. Overview / Customers / Money / Trust & Safety / System) would improve coherence.
  Deferred (grouping is a design decision, milestone says clean up only where obvious).
- **`/auth/me` boot 401:** cosmetic; optional future cleanup by pre-refreshing at boot.
- Deeper per-control interaction testing (drawers, filters, detail drill-downs) was
  limited by the freshly-seeded dataset having few rows to act on; the surfaces render
  and their controls are present and wired.
