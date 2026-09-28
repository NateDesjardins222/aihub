# Portal V2 — Account Detail

**Product Rebuild Phase 2** · Complete the Accounts vertical (authoritative progress + Account Detail V2)
**Base checkpoint:** `product-rebuild-phase2-start` (`85b644d`)
**Date:** 2026-09-28

---

## 1. Purpose

The V2 Account Detail surface and the contract that feeds it. Like the rest of V2, it **renders authoritative truth and invents none.** This document records the data flow per field, the tab information architecture, and the state model.

---

## 2. Route & isolation

- **Isolated route:** `/portal-v2/accounts/:accountId` (dev-only; `designLabEnabled()` gate in `App.tsx`, 404 in production). The Accounts list's "View details" navigates here — **no V1 detail detour**.
- The production container `V2AccountDetailContainer` is production-capable but **not mounted** in the live V1 portal. V1's `/portal/accounts/:id` remains production truth. Rollback = do not switch the route.
- All V2 detail code is under `apps/web/src/portal/v2/`, scoped to `.htv2` / `--ht-*`.

---

## 3. Data flow (authoritative → screen)

```
GET /api/v1/portal/accounts/:id            → AccountDetailFull  (detail incl. authoritative rules + priceMicros + lifecycles)
GET /api/v1/portal/accounts/:id/analytics  → Analytics          (real trades / equity / days — Performance + Overview strip)
GET /api/v1/portal/accounts/:id/trades     → { trades }         (not used by V2 detail yet; reserved)
GET /api/v1/portal/accounts/:id/controls   → PersonalRiskProfileView  (Controls tab, read)
PUT /api/v1/portal/accounts/:id/controls/:type                   (Controls tab, mutate — version-guarded)
GET /api/v1/payouts/eligibility/:id        → PayoutEligibility  (Rules tab: winning days, split, programme)
        │
        ▼
toAccountDetailView(AccountDetailFull)   → V2AccountDetailView   (apps/web/src/portal/v2/account-detail-view.ts)
        │  deterministic, presentation-only
        ▼
V2AccountDetail (header + tabs)  ·  V2AccountControls (risk)  ·  useAnalytics hook (perf)
```

Every route is **owner-scoped and server-enforced** (`requireUser` + `assertOwned`); a forged/foreign id returns 404. See `PORTAL_V2_ROUTE_ARCHITECTURE.md`.

### The Phase 2 contract extension (minimal, additive, no migration)

`PortalAccountSummary` gained `profitTargetMicros` and `PortalAccountDetail` gained a full `rules` block, both **read from the account's already-joined pinned version config** (`account_profile_versions.config.rules`). No schema change, no new query, no economics change. Details in `PORTAL_V2_DATA_OWNERSHIP.md §Phase 2`.

---

## 4. Information architecture (tabs)

Each tab is backed by real data or a truthful intentional state — never a fabricated placeholder.

| Tab | Source | Notes |
|---|---|---|
| **Overview** | detail + analytics | Evaluation target progress (authoritative), account money rows, lifecycle strip, a recent-performance strip (silent if analytics unavailable). |
| **Performance** | analytics + (equity points) | Real equity curve **only** with ≥2 closed trades, else a truthful "not enough" note; real metric rows; by-instrument table. No fabricated chart, no fabricated win rate. |
| **Controls** | `PersonalRiskProfileView` | The existing personal-risk system, reused (see §6). |
| **Rules** | `detail.rules` + eligibility | Authoritative target / max loss / drawdown model / consistency / max contracts, plus winning days & split from eligibility when present. |
| **Activity** | detail lifecycles | Business timeline (purchase / reset / lifecycle transitions). Real events only; deliberate empty state otherwise. |

---

## 5. Evaluation progress (PV2-1 resolved)

- **Evaluation (live):** primary progress is **profit toward the authoritative profit target** (`config.rules.profitTargetMicros`) — the same number the rule engine passes on. `achieved = max(0, balance − start)`, `remaining = max(0, target − netPnl)`, `pct = clamp0..100(netPnl / target × 100)`. The **bar clamps** to 0–100; the **displayed money is never clamped** (over-target shows the true figure). Risk room (MLL) is shown separately.
- **Funded:** the authoritative target is `0` (already passed) → **no evaluation target bar** (STEP 4). Funded shows balance / net P&L / MLL and its funded lifecycle stage.
- **Failed / Completed / Closed / Pending / Archived:** terminal/transitional — state truth, no target bar.
- **No authoritative target (null config):** no bar (never inferred from account size or product name).

This is the same `evaluationProgress()` used by the Accounts list adapter, so the list and the detail agree.

---

## 6. Risk controls — reuse, not rebuild (launch-critical)

`V2AccountControls` **uses the existing enforcement system**. It never re-implements risk logic:

- Reads `GET …/controls`, mutates `PUT …/controls/:type` with `expectedVersion` (optimistic concurrency).
- On success it re-reads the authoritative profile and reconciles; **on any rejection it reloads server truth** — no fake "Saved."
- **Locked mode** preserved: a `LOCKED` control is tighten-only until the next trading day; the switch/loosen paths are disabled while locked; the server is the authority.
- **Firm limits** are never compared or weakened in React — the server owns the stricter-only comparison; the client only sends intent.
- States: loading / ready / saving (busy) / saved (notice) / rejected (notice + reload) / blocked (not editable) / locked.

---

## 7. State model (STEP 10)

`V2DetailState = loading | error(+retry) | not-found | ready(detail)`. A 404 maps to **not-found** (the server does not distinguish "missing" from "not yours" — no enumeration). No blank pages; no fake data during loading (skeleton reserves shape).

Secondary data (analytics, eligibility) has its own loading/error/empty handling and never blocks the primary detail (partial-failure tolerance).

---

## 8. Races & retry (STEP 33–35)

A shared, unit-tested `latestGuard()` (`race.ts`) backs both the accounts and detail containers: each load issues a monotonic token; a response whose token is no longer latest is discarded. Rapid **A → B → A** navigation ends on A even if B's response is late; an out-of-order mutation response never overwrites newer state; a retry issues a fresh superseding token.

---

## 9. What the detail must never do

Same red lines as the rest of V2 (`PORTAL_V2_DATA_OWNERSHIP.md §7`): it never decides pass/fail, eligibility, drawdown, provisioning, or lifecycle; never computes a second target/floor; never grants trading (the Trade hand-off re-authorises server-side for the account's own `publicId`); never fabricates a metric, chart, or event.
