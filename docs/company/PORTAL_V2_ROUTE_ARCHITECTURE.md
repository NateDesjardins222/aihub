# Portal V2 — Route Architecture

**Product Rebuild Phase 1** · Portal V2 Foundation
**Base checkpoint:** `a4a2d0f`
**Date:** 2026-09-28

---

## 1. Purpose

How routing, authorization, and data dependencies are structured for Portal V2, and the migration path from the live V1 portal to V2 **without ever taking V1 offline**. Phase 1's rule: V1 stays production truth; V2 is built and proven in isolation; rollback = *do not switch the route*.

---

## 2. Route map (today, after Phase 1)

| Route | Surface | Auth | Build gate | Notes |
|---|---|---|---|---|
| `/` | Atlas terminal (live) | session gate | all builds | Untouched by Phase 1. |
| `/portal` (+ subpaths) | **Portal V1 (production)** | session gate | all builds | Unchanged. Remains the customer portal. |
| `/portal/accounts/:id` | Portal V1 account detail | session gate | all builds | V2 container links here for "details" (no V2 detail page in Phase 1). |
| `/onboarding` | Onboarding / purchase | session gate | all builds | V2 empty-state "Get an account" links here. |
| `/portal-v2` | **Portal V2 dev harness** | **none** (no session, no real data) | **dev only** (`designLabEnabled()`) | Fixtures only. 404-equivalent fall-through in production. |
| `/design-lab` | Homepage design lab | none | dev only | Pre-existing; unchanged. |

**Key structural fact:** `/portal-v2` is rendered in `App.tsx` **before the sign-in gate**, guarded by `designLabEnabled() && pathname.startsWith('/portal-v2')`. In a production build `designLabEnabled()` is `false`, so the block is skipped and the path falls through to the normal app (→ 404 for an unknown path). The V2 foundation is therefore **unreachable by customers** and **cannot affect the live V1 portal**.

```
App render order (relevant excerpt, apps/web/src/App.tsx):
  … public routes (affiliates) …
  if (designLabEnabled() && path startsWith '/design-lab')  → LabApp        [dev only]
  if (designLabEnabled() && path startsWith '/portal-v2')   → PortalV2Harness[dev only]
  … icon gallery (dev) …
  → sign-in gate → authenticated app (Atlas + Portal V1)
```

`PortalV2Harness` is a `lazy()` import, so none of the V2 bundle loads in a production session — it is code-split behind a dev-only branch.

---

## 3. Authorization model (traced, not recreated)

Phase 1 **did not invent** any auth. The Accounts vertical inherits the existing server enforcement by calling the same authoritative routes.

### Server (authoritative)
- **Every** `/api/v1/portal/*` route registers `app.addHook('preHandler', requireUser)` (`apps/server/src/http/routes/portal.ts`). No portal route is reachable without a valid session/user.
- **List route** `GET /api/v1/portal/accounts` scopes strictly to the caller: `listPortalAccounts(db, request.user!.id, …)` filters `where(eq(accounts.userId, userId))`. A trader can only ever receive their own accounts.
- **Id-scoped routes** call `assertOwned(db, userId, accountId)`, which returns `notFound` when `row.userId !== userId`. **A forged or another customer's account id yields `ACCOUNT_NOT_FOUND`, never another customer's data** (no cross-customer exposure, no IDOR).
- Ownership is **never** inferred from the request body — always from the session user against the row's `userId`.

### Client (V2)
- `AccountsContainer` calls `api.get<AccountsView>('/api/v1/portal/accounts?includeArchived=false')`. The API client attaches the Bearer token; the server does the rest.
- The client performs **no** authorization decisions. `tradable`/`resettable` are display hints; the trade hand-off (`/?account=publicId`) and reset routes re-authorise server-side.

**Conclusion:** V2 gains authorization for free by reusing the authoritative routes. There is no second auth path to keep in sync, and therefore no new cross-customer exposure surface. (See `PORTAL_V2_DATA_OWNERSHIP.md §8`.)

---

## 4. Routing robustness (deep-link / refresh / back-forward / invalid)

The Accounts vertical was built to survive real navigation, not just the happy path:

| Scenario | Behaviour |
|---|---|
| **Deep link** to accounts | The container fetches on mount (`useEffect(load)`), so a cold load paints loading → data with no dependency on prior navigation. |
| **Refresh** | Same as deep link — fetch on mount; no reliance on in-memory nav state. |
| **Back / forward** | Navigation actions use `window.location.href` (full document nav to authoritative V1 routes), so browser history behaves normally; no SPA state to corrupt. |
| **Invalid account id** (via detail link) | Handled server-side: `assertOwned` → `notFound`. |
| **Slow reload racing a newer one** | `tokenRef` monotonic guard discards the stale response (see §5). |
| **Unknown `/portal-v2/...` subpath in prod** | Falls through to 404 (dev gate false). |

> Phase 1 deliberately keeps V2's navigation as **full-document links to authoritative V1 routes** rather than introducing a parallel SPA router. This is the safest migration seam: V2 surfaces mount inside the real app later without a routing rewrite, and there is no second history/URL model to reconcile.

---

## 5. Data dependencies per surface

| Surface | Reads | Writes | Failure states handled |
|---|---|---|---|
| `V2AccountsContainer` | `GET /api/v1/portal/accounts?includeArchived=false` | none (Phase 1 is read-only) | loading, error (+retry), ready |
| `V2AccountsView` | its `V2AccountsState` prop | none | loading skeleton, error (distinct from empty), empty, degraded (partial failure note), ready-grid |
| `toAccountView` | one `AccountSummary` | none | unknown-state fallback |

- **Loading:** skeleton panels reserve panel shape (no layout jump).
- **Error:** distinct `role="alert"` block with retry (`onRetry = load`), visually and semantically different from empty.
- **Empty:** `role`-neutral empty state with a "Get an account" CTA → `/onboarding`.
- **Partial failure (degraded):** a `role="status"` note rendered above the grid when a secondary source is delayed but accounts still render — **never** conflated with empty.
- **Stale:** monotonic `tokenRef` discards superseded responses.

---

## 6. Migration path (V1 → V2), with rollback

Phase 1 leaves V1 fully live. The migration seam is the **container**, not a route swap:

1. **Now (Phase 1):** V2 Accounts is exercised only at `/portal-v2` (dev harness, fixtures). `V2AccountsContainer` exists and is production-capable but is **not mounted** in any authenticated route.
2. **Later (a future phase, on Nathan's go):** mount `V2AccountsContainer` behind a **flag** at the authenticated accounts route. Because it calls the same authoritative API and enforces the same ownership, no backend change is required to switch.
3. **Rollback:** flip the flag / do not switch the route. V1 is untouched, so rollback is instantaneous and lossless — there is no data migration to reverse, no schema change, no second write path.

**Isolation guarantees that make this safe:**
- CSS scoped to `.htv2` using only `--ht-*` tokens → cannot restyle Atlas (`--*`) or V1 portal (`--pt-*`).
- V2 code lives entirely under `apps/web/src/portal/v2/` and is code-split behind a dev gate.
- No shared mutable state with V1; V2 reads the same API V1 reads.

---

## 7. What Phase 1 did **not** change (route-level)

- No change to `/`, `/portal`, `/portal/accounts/:id`, `/onboarding`, or any authenticated route.
- No new server route, no change to `requireUser`/`assertOwned`.
- No SPA router introduced; no history model change.
- No production reachability of `/portal-v2`.
