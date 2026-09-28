# Portal V2 — Data Ownership Map

**Product Rebuild Phase 1** · Portal V2 Foundation, Real-System Integration & Structural Correctness
**Base checkpoint:** `a4a2d0f` (Product Rebuild Phase 0)
**Date:** 2026-09-28
**Scope of this document:** the Accounts vertical only (Phase 1 built the Accounts experience against the authoritative system). Other verticals will extend this map as they are built.

---

## 1. Purpose

This document is the contract that keeps Portal V2 honest. It records, **per field**, where a value is *born* (its authoritative source), what *transforms* touch it on the way to the screen, which *API* carries it, and what the *UI* is permitted to do with it.

The governing principle of Phase 1:

> **Portal V2 RENDERS truth. It never INVENTS truth.**

Business truth is decided **server-side**. The V2 client does not decide pass/fail, payout eligibility, drawdown rules, consistency, provisioning, reset rules, funded eligibility, or lifecycle transitions. Where V2 does arithmetic, it is **presentation arithmetic only** — subtracting or formatting two already-authoritative numbers for display — and every such computation is called out explicitly below.

---

## 2. The ownership boundary (one picture)

```
  ┌────────────────────────── SERVER (authoritative) ───────────────────────────┐
  │                                                                              │
  │  Postgres `accounts` row          apps/server/src/platform/portal-accounts.ts│
  │  (+ account_profiles,             ─────────────────────────────────────────  │
  │   account_profile_versions)   →   portalState()   consumesSlot()   toSummary()│
  │                                        │                                      │
  │                                        ▼                                      │
  │                              PortalAccountSummary  +  PortalAccountsView       │
  │                                        │                                      │
  │  apps/server/src/http/routes/portal.ts │  GET /api/v1/portal/accounts          │
  │  preHandler: requireUser               │  (owner-scoped; assertOwned on :id)   │
  └────────────────────────────────────────┼──────────────────────────────────────┘
                                           │  JSON over HTTPS (Bearer token)
  ┌────────────────────────────────────────┼──────── WEB (presentation) ──────────┐
  │                                        ▼                                      │
  │  apps/web/src/api/client.ts  api.get<AccountsView>(...)                        │
  │                                        │                                      │
  │  apps/web/src/portal/lib.tsx  AccountSummary / AccountsView  (mirror types)    │
  │                                        │                                      │
  │  apps/web/src/portal/v2/AccountsContainer.tsx  (fetch + stale-guard + retry)   │
  │                                        │  V2AccountsState (loading|error|ready)│
  │                                        ▼                                      │
  │  apps/web/src/portal/v2/account-view.ts  toAccountView()   ◄── the typed seam  │
  │                                        │  V2AccountView (presentation-only)    │
  │                                        ▼                                      │
  │  AccountsView.tsx → V2AccountPanel.tsx → primitives (format.ts money strings)  │
  └──────────────────────────────────────────────────────────────────────────────┘
```

**There is exactly one authoritative producer** (`listPortalAccounts`) and exactly one typed adapter (`toAccountView`) between the wire and the components. Phase 1 introduced **no second account model** and **no parallel fetch path**.

---

## 3. Authoritative source of each account field

Source columns live on the `accounts` table (`apps/server/src/db/schema.ts`), joined to `account_profiles` / `account_profile_versions` for product identity. The projection is `toSummary()` in `apps/server/src/platform/portal-accounts.ts`.

| Field (`PortalAccountSummary`) | Authoritative origin | Server transform | Notes on ownership |
|---|---|---|---|
| `id` | `accounts.id` | passthrough | Internal id; used for React keys and detail routing. |
| `publicId` | `accounts.publicId` | passthrough | Customer-visible handle; masked for display (see §5). |
| `name` | `accounts.name` | passthrough | **Authoritative** product name. Never overridden by the client. |
| `nickname` | `accounts.nickname` | `?? null` | **Presentation-only**, set by the trader via `setAccountNickname` (bounded 60 chars). Not business truth. |
| `accountType` | `accounts.accountType` | passthrough | `EVALUATION` \| `FUNDED_SIM` \| `PRACTICE` \| … Drives slot + tradable display. |
| `status` | `accounts.status` | passthrough | `PENDING`\|`ACTIVE`\|`PASSED`\|`FAILED`\|`COMPLETED`\|`INACTIVE`. Raw lifecycle status. |
| `portalState` | derived | `portalState(account)` | **Server-derived** portal vocabulary (see §4). The client maps it to a label/colour; it never recomputes it. |
| `consumesSlot` | derived | `consumesSlot(account)` | Server decides whether the account uses one of the five active slots. |
| `product` | `account_profiles.key/name` + `account_profile_versions.version` | left-join projection | `null` when no profile is linked. Product identity is authoritative. |
| `startingBalanceMicros` | `accounts.startingBalanceMicros` | passthrough | Integer micro-dollars (1e6 = $1). Authoritative. |
| `balanceMicros` | `accounts.balanceMicros` | passthrough | Authoritative current balance. |
| `highWaterMarkMicros` | `accounts.highWaterMarkMicros` | passthrough | Authoritative HWM (drives trailing drawdown on the server). |
| `drawdownFloorMicros` | `accounts.drawdownFloorMicros` | passthrough | **Authoritative Maximum Loss Limit floor.** The client never computes this; it is the server's drawdown truth. |
| `resetOfAccountId` | `accounts.resetOfAccountId` | `?? null` | Links a reset account to the one it replaced. |
| `archivedAt` | `accounts.archivedAt` | `.getTime() ?? null` | Presentation overlay (hide). Not an authoritative lifecycle status. |
| `activatedAt` | `accounts.activatedAt` | `.getTime() ?? null` | Timestamp; **not** present on the web mirror type (see §6). |
| `createdAt` | `accounts.createdAt` | `.getTime()` | Sort key (`orderBy desc`). |

`PortalAccountsView` wraps the list with two server-owned aggregates:

| Field | Origin | Ownership |
|---|---|---|
| `activeSlotsUsed` | counted server-side across **all** non-archived slot-consuming accounts (incl. those filtered from the list) | Server truth. The client displays "N of M active slots used" verbatim. |
| `maxActiveSlots` | constant `MAX_ACTIVE = 5` in `listPortalAccounts` | Server truth. The five-active invariant is not a client rule. |

> **Important:** `activeSlotsUsed` is computed **before** the archived / practice filters remove rows, so the count reflects the real slot usage even when the list the trader sees is shorter. This is a deliberate server-side decision; the client must not re-derive the count from `accounts.length`.

---

## 4. `portalState` — derived on the server, mapped on the client

`portalState()` (server) collapses authoritative `(accountType, status, archivedAt)` into eight portal states. This is **the** lifecycle truth for the portal.

| Authoritative input | → `portalState` |
|---|---|
| `archivedAt` set (any status) | `ARCHIVED` |
| `status = PENDING` | `PENDING` |
| `status = PASSED` | `EVALUATION_PASSED` |
| `status = FAILED` | `FAILED` |
| `status = COMPLETED` | `COMPLETED_MAX_PAYOUTS` |
| `status = INACTIVE` | `INACTIVE_CLOSED` |
| `status = ACTIVE`, `accountType = FUNDED_SIM` | `FUNDED_ACTIVE` |
| `status = ACTIVE`, otherwise | `EVALUATION_ACTIVE` |

The client's only responsibility (`STATE_PRESENTATION` in `account-view.ts`) is to attach a **status colour + label** to each state. It performs **no** state transition and makes **no** eligibility decision. If the server adds a ninth state, the client falls back to `{ kind: 'neutral', label: <raw state> }` rather than guessing — a safe, non-inventive default.

The full behavioural contract for each state is in **`PORTAL_V2_ACCOUNT_STATE_MATRIX.md`**.

---

## 5. Presentation-only computations (the complete list)

Every derivation the V2 client performs is listed here. **None** of these decide business truth; each is arithmetic or formatting over already-authoritative numbers. All live in `account-view.ts` / `format.ts` and are covered by unit tests.

| Derived value | Formula | Why it is presentation-only |
|---|---|---|
| **Net P&L** (`netPnlText`) | `balanceMicros − startingBalanceMicros` | A display subtraction of two authoritative figures. Not a P&L ledger — the authoritative realized P&L lives elsewhere (`account.realizedPnlMicros`, surfaced in detail). |
| **MLL room** (`mllRoomText`) | `max(0, balanceMicros − drawdownFloorMicros)` | Distance from the **authoritative** floor. The floor is server truth; V2 only subtracts. Clamped at 0 so a breached account never shows negative room. |
| **Drawdown-room progress** (`progressPct`) | `clamp0..100((mllRoom / (startingBalanceMicros − drawdownFloorMicros)) × 100)` | A ratio of two authoritative micro-dollar figures, shown **only** while `EVALUATION_ACTIVE`/`FUNDED_ACTIVE` and the initial cushion `> 0`. **Reframed deliberately as "Drawdown room," not "Profit target"** — the profit target is *not* in the summary payload, so V2 does not fabricate one. |
| **Money strings** | `formatMoney(micros)` (Intl, `MICROS_PER_DOLLAR = 1e6`) | Pure formatting; tabular figures via `.ht-num`. |
| **Money tone** | `moneyTone(micros)` → positive/negative/muted | Colour hint only; `0 → muted`. |
| **Product label** | `familyOf(product.key) + accountSizeLabel(startingBalanceMicros)`, e.g. `CORE 100K` | Both inputs authoritative; falls back to `product.name` then `name` when the family/size cannot be formed. Never invents a family. |
| **Masked id** | `maskAccountId(publicId)` → `•••• 1005` | Redaction for display; the real `publicId` is still used for the trade hand-off. |
| **Tradable hint** | `status = ACTIVE && (EVALUATION|FUNDED_SIM)` | **Display hint only.** The authoritative gate is the server hand-off route, which re-checks ownership + status. The portal never grants trading access on its own. |
| **Resettable hint** | `status = FAILED && accountType = EVALUATION` | Display hint only; the server authorises the actual reset (`account-reset.ts`). |

---

## 6. Type mirror discipline (server ↔ web)

The web type `AccountSummary` (`apps/web/src/portal/lib.tsx:72`) is a **hand-maintained mirror** of the server `PortalAccountSummary`. Phase 1 consumes it unchanged.

- Known intentional gap: the web mirror **omits `activatedAt`**. V2 does not use `activatedAt` in the Accounts experience, so this is not a defect for Phase 1, but it is a divergence worth recording. **Recommendation (deferred, non-blocking):** when a vertical needs `activatedAt`, add it to the mirror rather than re-fetching. Logged in `KNOWN_ISSUES.md`.
- `portalState` is typed as `string` on the web mirror; `account-view.ts` narrows it to the local `PortalState` union at the adapter boundary and falls back safely for unknown values. This keeps the mirror permissive (forward-compatible with new server states) while the adapter stays exhaustive.

---

## 7. What Portal V2 must never do (ownership red lines)

1. **Never** compute or store a second `balanceMicros`, `drawdownFloorMicros`, or `portalState`. Read them; do not shadow them.
2. **Never** decide pass/fail, payout eligibility, funded eligibility, reset availability, or provisioning outcome on the client. These are server calls.
3. **Never** free or consume an active slot from the client. `consumesSlot` / `activeSlotsUsed` are server truth.
4. **Never** grant trading access from the client. `tradable` is a hint; the hand-off route re-authorises.
5. **Never** invent a product economic value not present in the payload (e.g. a profit target). If a value is needed and absent, that is a **conflict to document**, not a number to fabricate.

---

## 8. Data freshness & consistency

- **Stale-response discipline:** `AccountsContainer` uses a monotonic `tokenRef`; a slow response whose token is no longer current is discarded, so a fast reload never paints over a newer result.
- **No client cache of business truth:** V2 holds only the last fetched `AccountsView` in component state. There is no local persistence of balances or states (nothing in `localStorage`/IndexedDB), so there is no stale-truth risk across sessions.
- **Ownership is re-enforced on every call:** `requireUser` on the route + `assertOwned` on id-scoped routes means a forged id yields `notFound`, not another customer's data (see `PORTAL_V2_ROUTE_ARCHITECTURE.md` §Authorization).

---

## 9. Open items surfaced by this map (for Nathan's decision — not decided here)

- **`activatedAt` mirror gap** (§6) — cosmetic/forward-looking; deferred.
- **Profit-target absence** — the summary payload has no profit target, so V2 shows *drawdown room* progress instead of *profit* progress. If the product intends a profit-target progress bar in the portal, the summary projection must expose the authoritative target; V2 will not compute one. Logged as a documented conflict, awaiting decision.

Neither item was resolved by changing product behaviour, per the Phase 1 constraint.
