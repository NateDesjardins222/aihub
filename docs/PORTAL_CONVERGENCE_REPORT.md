# Portal Convergence Phase 1 — Report

One customer product. `/portal` now serves the approved **V2 experience** backed by
the **hardened customer core**. The rejected horizontal-nav shell is no longer the
customer runtime; `/portal-v2` remains a DEV-only review harness.

## Before (§70)

- Starting commit: `1a532e3` · Branch: `claude/futures-trading-simulator-v8qefu`
- Checkpoint created: `portal-convergence-phase1-start` (tag at `1a532e3`)
- Working tree: clean · Stash preserved: `stash@{0}: phase3-wip-product-model`
- Old `/portal` root: `portal/PortalApp.tsx` — the REJECTED horizontal top-nav shell,
  each `pages/*Page.tsx` fetching authoritative `/api/v1/*` itself (hardened wiring).
- Old `/portal-v2` root: `portal/v2/Review.tsx` — the approved V2 sidebar experience,
  but fed dev FIXTURES, `designLabEnabled()`-gated, 404 in production.
- Old route behavior: production customers landed on the rejected V1 shell; the
  approved V2 never shipped.
- Old fixture boundary: V2 fixtures lived only behind the dev review route.

## Convergence (§71)

- New canonical `/portal` root: **`portal/PortalV2App.tsx`** (`PortalV2App`) — the
  `V2AppShell` sidebar experience with authoritative data.
- V2 shell/components MIGRATED into production: `V2AppShell`/`V2Sidebar`/`V2AccountMenu`
  (Shell), `V2AccountsView`, `V2AccountDetail`, `V2PayoutsPage`, `V2CertificatesPage`,
  `V2BillingPage`, `V2ProgressPage`, and the Dashboard presentation extracted to the
  shared `portal/v2/dashboard.tsx`.
- V1 hardened wiring REUSED: `V2AccountDetailContainer` (authoritative detail),
  `V2SupportCenter` (live `/api/v1/support`), and the hardened V1 `PayoutModule`
  (payout request), `ProfilePage`, `PayoutMethodsPage` (account utilities) mounted
  inside the V2 shell — so no account/payout/profile business logic was rewritten and
  the richer `ProfileView` the backend does not yet serve is never fabricated.
- REWIRED: new thin containers (`portal/v2/containers.tsx`) feed each V2 page
  authoritative `/api/v1` data with discriminated load states (error ≠ zero).
- App.tsx: `/portal` → `PortalV2App` (the only change to the route table).
- Legacy remaining (unrouted, retained pending a careful delete): `portal/PortalApp.tsx`
  and `pages/{Dashboard,Accounts,AccountDetail,Payouts,Certificates,Achievements,Billing,
  Support,Review}Page.tsx`, `AccountCard`, `Performance`, `ControlsView` — no longer the
  customer runtime.
- Fate of `/portal-v2`: remains the DEV-only review harness (fixtures, 404 in prod) —
  never a second production product.

## Data truth per canonical page (§72)

| Page | Primary source | Business authority | Fixtures | Zero state | Error state | Partial |
|---|---|---|---|---|---|---|
| Dashboard | `/api/v1/portal/accounts` + `/progress` + funded eligibility | server | none | truthful zeros + "Welcome" empty | ErrorPanel (retry), never zeros | progress optional; chart omitted if no authoritative series |
| Accounts | `/api/v1/portal/accounts` (+ eligibility extras) | server | none | "No accounts" empty | discriminated error state | eligibility degrade = no extra, card still truthful |
| Account detail | `/api/v1/portal/accounts/:id` (+ analytics, eligibility) | server | none | — | not-found / error states | tabs self-fetch authoritative |
| Payouts | funded eligibility + `/progress` (lifetime) + PAYOUT certs (history) | server | none | "no payouts" truthful | ErrorPanel | request via hardened PayoutModule |
| Certificates | `/api/v1/portal/certificates` (+ artifact blobs) | server | none | empty vault | ErrorPanel | artifact null → "preview in account", never a fake image |
| Progress | `/api/v1/portal/progress` + goal CRUD | server | none | truthful zero journey | ErrorPanel | goal write failure keeps last authoritative view |
| Billing | `/api/v1/portal/accounts` (orders) | server | none | empty billing | ErrorPanel | payment method = none-on-file (truthful) |
| Support | `/api/v1/support/*` (self-fetching) | server | none | "no tickets" | sign-in / error states | re-reads authoritative after writes |
| Profile / payout-methods | `/api/v1/portal/profile` + MFA (reused V1) | server | none | — | real | — |

Money is integer micro-dollars throughout; the only client arithmetic is presentation
aggregation of server-authoritative values (payout roll-up, gross-from-split, order
rows). Max paid payout cycles remain 5 (server-authoritative); no `3 of 12` or invented
cycle count renders.

## Customer actions (§73)

| Action | Route/flow | Server action | Ownership | Result |
|---|---|---|---|---|
| Add account | account menu / empty states → `/onboarding` | canonical purchase/provision | n/a | one verified purchase → one account |
| Trade | account card/detail → `/?account=<publicId>` | server re-checks ownership + status | §4A | exact account or explicit refuse — never substitute |
| Request payout | Payouts → PayoutModule → `POST /api/v1/payouts/requests` | server eligibility + ledger | owner-scoped | hardened request flow preserved |
| Certificate preview/download | `resolveArtifact` → `GET /certificates/:id/{image,pdf}` (Bearer) | server | owner-scoped | real artifact or truthful "preview in account" |
| Goal create/update/complete/pin/archive | `/api/v1/portal/goals*` | server | caller identity | authoritative; re-fetch after write |
| Support create/reply | `/api/v1/support/*` | server | owner↔customer same ticket | live |
| Billing/order navigation | account rows → account detail | read | owner-scoped | authoritative |
| Profile / sign out | reused V1 ProfilePage / `signOut()` | server | owner-scoped | preserved |

## L5 readiness — exact human workflow (§74)

1. Fresh signup: `/onboarding` (contact → identity → agreements → product → checkout).
2. Login: `/portal` (signed-out → LoginScreen) or the normal login surface.
3. Canonical portal: **`/portal`** (the V2 experience; no `/portal-v2` needed).
4. Add account: Dashboard/Accounts "Add account" → `/onboarding`.
5. Safe dev checkout: `/onboarding` → "Complete mock payment" → server-verified
   provisioning (no real payment; production uses the provider's embedded checkout).
6. Account appears: `/portal` Dashboard + Accounts (authoritative).
7. Atlas handoff: account card/detail → **Trade** → `/?account=<publicId>`.
8–10. Evaluation progression / pass / funded: trade in Atlas; server-authoritative;
    Progress + Accounts reflect it.
11. Payout request: `/portal/payouts` → Request (hardened module).
12. Owner Console: `/admin` (owner/staff login; e.g. seeded `owner@atlasfutures.local`).
13. Payout processing: Owner `/admin/payouts`.
14. Certificate: `/portal/certificates` (preview/download/verify).
15. Support: `/portal/support` (customer) ↔ `/admin/ops/support/inbox` (owner).
16. Affiliate: `/affiliates/apply` → Owner `/admin/ops/affiliates/applications`.
17. Durability: refresh / logout-login / multi-tab — session + authoritative state persist.

OpenClaw/Claude does NOT perform these — Nathan is the L5 tester.

## Validation (§68)

- Web typecheck: PASS. Production web build: PASS (`vite build`, exit 0).
- Web tests incl. convergence + hardening: **189 passed** (12 files).
- Headless browser (logged-in, SPA nav): canonical V2 shell at `/portal`
  (`htv2-shell` present, rejected `pt-top` absent), all 7 sections render,
  **0 console errors**; screenshots in `docs/portal-convergence-screens/`.
- `customer:certify` FAST: PASS (integrity PASS, 8 suites / 78 tests).
- `customer:certify` DEEP: **PASS** (integrity PASS — all 6 customer-provenance invariants;
  FAST 8 suites + DEEP 5 suites, on a freshly-prepared DB).
- Canonical `pnpm validate:release`: **investigated (§69), convergence clean.** The full
  serialized suite (3295 tests, ~575s) surfaced **12 failures across 6 server-side files**
  (`trading/{determinism,adversarial,eod-trailing-engine}`, `http/affiliate-{http,security}`,
  `db/schema`) — all **shared-Postgres + CPU contention / test-isolation** signatures: a
  `deadlock detected` in a harness teardown, another file's `endedAt` leaking into
  `schema.test`, affiliate `409 already-applied` + cascading `undefined` from rows left in
  the shared DB, and replay-determinism drifting when `settle()` wall-clock under-drains on
  a starved CPU. **All 6 files pass in isolation on a fresh DB (48/48 tests green).** The
  diff from baseline `1a532e3` touches **0 server files** (web + docs only), so none of these
  can be caused by the convergence; they are a pre-existing full-run isolation fragility of
  the trading/affiliate test harnesses (tracked as **PCV-6** in `KNOWN_ISSUES.md`). Per §69
  this was stopped-and-investigated rather than blindly re-run. The convergence's own gates
  are all green: web typecheck, 189 web tests (incl. convergence), production build,
  `customer:certify` FAST + DEEP.

## Hard questions (§75) — YES/NO with evidence

1 `/portal` is the one canonical production product — **YES** (App.tsx → PortalV2App; convergence test). 2 `/portal` renders the approved V2 experience — **YES** (V2AppShell; screenshots). 3 `/portal` uses the hardened authoritative core — **YES** (containers hit `/api/v1/*`; no client business logic). 4 PortalV2Review no longer required for customer operation — **YES** (dev-only, 404 in prod). 5 Review fixtures can enter canonical `/portal` — **NO** (fixture-firewall test). 6 Zero-state customer sees demo accounts — **NO** (authoritative accounts only). 7 Demo payouts — **NO**. 8 Demo certificates — **NO**. 9 Fake performance — **NO** (no fabricated series; chart only on authoritative data). 10 Dashboard uses authoritative data — **YES**. 11 Accounts use authoritative ownership — **YES** (owner-scoped `/accounts`). 12 Trade preserves §4A handoff — **YES** (`/?account=<publicId>`, server re-check). 13 Explicit account A silently becomes B — **NO** (§4A `resolveAccountSelection`). 14 Payout Center uses authoritative payout truth — **YES** (eligibility + progress + certs + PayoutModule). 15 Max paid payout cycle still 5 — **YES** (server-authoritative; no client cycle invention). 16 Certificates show real artifacts — **YES** (authenticated blobs; truthful fallback). 17 Progress uses authoritative events/payouts — **YES** (`/progress` + goal CRUD). 18 Billing uses authoritative order data — **YES** (from `/accounts`, as V1). 19 Support uses authoritative tickets — **YES** (`V2SupportCenter`). 20 Normal login reaches canonical product — **YES** (`/portal`). 21 Customer can naturally land on rejected shell — **NO** (route removed). 22 More than one production-capable portal — **NO**. 23 DEV fixtures excluded from production path — **YES** (firewall test + prod build). 24 DEV lifecycle accelerators impossible in production — **N/A** (none added). 25 Owner Console separated/role-gated — **YES** (`canAccessOwnerConsole`, account menu only). 26 Production build passes — **YES**. 27 customer:certify FAST passes — **YES**. 28 customer:certify DEEP passes — **YES** (integrity PASS; FAST 8 + DEEP 5 suites on a fresh DB). 29 Canonical release validation passes — **NO (clean), with cause isolated** — the full serialized run surfaced 12 pre-existing **contention/test-isolation flakes** in 6 **server-side** files (teardown deadlock, cross-file DB-row leakage, wall-clock timing under CPU starvation); **all 6 pass in isolation, 48/48 green**; the convergence diff touches **0 server files**, so none is convergence-caused (tracked as PCV-6). Every convergence-owned gate is green (web typecheck, 189 web tests incl. convergence, production build, certify FAST + DEEP). Investigated per §69, not blindly re-run. 30 Unresolved P0 — **0**. 31 Unresolved P1 — **0**. 32 Ready for Nathan's L5 against the ACTUAL customer app — **YES** (pending ChatGPT's independent convergence review as directed).

## Known limitations (documented, not fabricated; see KNOWN_ISSUES)
- Portal-level cumulative performance chart on the Dashboard is deferred (no
  authoritative portfolio-series endpoint); per-account performance is live in Account
  detail. No fabricated curve is ever drawn.
- Billing `totalSpent` roll-up is not shown (order price micros not exposed
  authoritatively); order rows are truthful. Payment method shows none-on-file
  (provider-hosted).
- Payouts `inReview`/`cyclesText` summary fields are blank where no authoritative
  customer-facing source exists; standing + history + lifetime-paid are authoritative.
- Profile/security/verification use the hardened V1 surfaces inside the V2 shell (the
  richer V2 `ProfileView` has no backend yet) — avoids fabricating identity fields.
