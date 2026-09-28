# Portal V2 — Account State Matrix

**Product Rebuild Phase 1** · Accounts vertical
**Base checkpoint:** `a4a2d0f`
**Date:** 2026-09-28
**Authoritative source:** `portalState()` in `apps/server/src/platform/portal-accounts.ts`
**Client mapping:** `STATE_PRESENTATION` + `toAccountView()` in `apps/web/src/portal/v2/account-view.ts`

---

## 1. What this document is

Every supported account state, and exactly how Portal V2 is expected to present it. This is a **presentation contract over authoritative state** — the server owns the state; this table owns only how V2 renders it. It is written so that a reviewer (or a test) can confirm that V2's behaviour matches the intended behaviour for each state, and so that any drift between *documented* and *implemented* behaviour is visible.

There are **8 authoritative portal states**. Phase 1 handles all 8 (verified by `account-view.test.ts`, which drives one fixture per state through the real adapter).

---

## 2. The matrix

Legend for **Status chip**: colour kind from `StatusKind` (`neutral`/`evaluation`/`funded`/`failed`/`completed`). **Progress** = the drawdown-room bar (only shown when live + initial cushion > 0). **Trade** / **Reset** = whether the action *button* is offered (display hint; server re-authorises).

| # | `portalState` | Authoritative trigger | Status chip | Label | Progress bar | Trade btn | Reset btn | Net P&L / MLL room | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `PENDING` | `status = PENDING` | neutral | "Provisioning" | hidden | no | no | shown (usually $0 / full) | Account is being provisioned. No trading yet. Consumes a slot (PENDING ∈ active). |
| 2 | `EVALUATION_ACTIVE` | `status = ACTIVE`, type `EVALUATION` | evaluation | "Evaluation" | **shown** (drawdown room) | **yes** | no | shown | The live evaluation. Progress = cushion remaining, not profit target. |
| 3 | `EVALUATION_PASSED` | `status = PASSED` | funded | "Passed" | hidden | no | no | shown | Evaluation cleared; awaiting funded provisioning. Not yet tradable in the portal view. |
| 4 | `FUNDED_ACTIVE` | `status = ACTIVE`, type `FUNDED_SIM` | funded | "Funded" | **shown** (drawdown room) | **yes** | no | shown | The live funded-sim account. |
| 5 | `FAILED` | `status = FAILED` | failed | "Breached" | hidden | no | **yes (if type EVALUATION)** | net P&L negative-toned; MLL room clamps to $0 | Breached. A failed *evaluation* may offer reset (server authorises). A failed funded account does not. |
| 6 | `COMPLETED_MAX_PAYOUTS` | `status = COMPLETED` | completed | "Completed" | hidden | no | no | shown | Lifecycle complete (max payouts reached). Terminal, archivable. |
| 7 | `INACTIVE_CLOSED` | `status = INACTIVE` | neutral | "Closed" | hidden | no | no | shown | Closed/inactive. Terminal, archivable. |
| 8 | `ARCHIVED` | `archivedAt` set (overlays any status) | neutral | "Archived" | hidden | no | no | shown | Presentation overlay — the trader hid a terminal account. Only in the list when `includeArchived=true`. |

### Unknown / future states
If the server introduces a 9th state, `toAccountView()` falls back to `{ kind: 'neutral', label: <raw state> }` and hides progress/actions. **V2 never guesses behaviour for a state it does not know** — it degrades to a safe read-only chip. This is intentional and tested.

---

## 3. Lifecycle stage mapping (the overflow-proof `V2Lifecycle`)

`lifecycleActiveIndex(portalState)` maps each state to a stage in the 4-stage lifecycle strip (Evaluation → Funded → Payouts → Completed). The strip is data-driven and overflow-proof by construction (verified at 1920/1440/1280/1024/768/390 — see `scripts/portal-v2-lifecycle-overflow.mjs` and `scripts/portal-v2-accounts-overflow.mjs`). The Phase 0 overflow fix remains intact.

| `portalState` | Highest reached stage |
|---|---|
| `PENDING`, `EVALUATION_ACTIVE`, `FAILED` (eval) | Evaluation |
| `EVALUATION_PASSED`, `FUNDED_ACTIVE` | Funded |
| `COMPLETED_MAX_PAYOUTS` | Completed |
| `INACTIVE_CLOSED`, `ARCHIVED` | (rendered per `lifecycleActiveIndex`; terminal) |

> The exact index for each state is asserted in `account-view.test.ts`. This table is the human-readable summary; the test is the source of truth.

---

## 4. Documented-vs-implemented reconciliation

Phase 1 required calling out any mismatch between what product docs describe and what the code does — **without changing economics**.

| Topic | Documented intent | Implemented (Phase 1) | Status |
|---|---|---|---|
| Portal lifecycle vocabulary | `docs/account-lifecycle-ux-v1.md §1` | `portalState()` implements the same 8-state vocabulary | ✅ aligned |
| Five-active-slots invariant | Product rule (5 concurrent active) | `MAX_ACTIVE = 5`, `consumesSlot`/`activeSlotsUsed` server-side | ✅ aligned |
| Progress bar semantics | (Portal V1 shows a progress path per state) | V2 shows **drawdown-room** progress, because the summary payload carries floor/start but **no profit target** | ⚠️ **Documented conflict** — see below |
| Reset availability | Reset applies to failed evaluations | `isResettableForDisplay` = `FAILED && EVALUATION` (display hint); server (`account-reset.ts`) authorises | ✅ aligned (hint mirrors server rule) |
| Archive | Only terminal accounts hideable; never frees a slot | `archiveAccount` refuses slot-consuming accounts | ✅ aligned |

### ⚠️ Documented conflict (unresolved, for Nathan)
The portal historically frames per-account progress toward a **profit target**. The authoritative `PortalAccountSummary` **does not include a profit target** — it includes `startingBalanceMicros`, `balanceMicros`, `highWaterMarkMicros`, `drawdownFloorMicros`. Rather than fabricate a target (which would be inventing product economics), Phase 1 renders **drawdown-room progress** (cushion remaining vs. initial cushion), which is fully authoritative.

**Decision required (not made here):** if the portal should show *profit-target* progress, the server summary projection must expose the authoritative target for the account's product version; V2 will then render it. Until then V2 shows drawdown room. This is logged in `KNOWN_ISSUES.md` and `PORTAL_V2_DATA_OWNERSHIP.md §9`. **No economics were changed.**

---

## 5. Boundary cases proven by tests / fixtures

The dev-only `FIXTURE_ACCOUNTS` (`apps/web/src/portal/v2/fixtures.ts`) includes one account per state plus adversarial shapes, driven through the real adapter in the harness and in unit tests:

- **At-floor account** — `balanceMicros = drawdownFloorMicros` → MLL room renders `$0` (not negative); progress `0%`.
- **Large balance** — `$1,284,500` → money formatting + panel layout hold (browser-verified, no overflow).
- **Long / ugly public id** — masks correctly and ellipsizes in the panel without widening it (browser-verified).
- **`product = null`** — product label falls back to size (`100K`) then name; never blank when a size exists.
- **`startingBalanceMicros = 0` with a name** — size label is empty, so label falls back to the authoritative `name`.
- **Negative net P&L** — negative tone; MLL room still clamps at `$0` when breached.

These boundaries are asserted in `format.test.ts` (20) and `account-view.test.ts` (11) — 31 focused tests, all green.
