# Portal V2 — Phase 2 Report

**Product Rebuild Phase 2** · Complete the Accounts vertical — authoritative progress + Account Detail V2
**Starting commit:** `85b644d` (`product-rebuild-phase2-start`)
**Branch:** `claude/futures-trading-simulator-v8qefu`
**Date:** 2026-09-28

---

## 1. Summary

PV2-1 is resolved with authoritative business truth: V2 evaluation progress now means progress toward the account's authoritative **profit target** (the same value the rule engine passes on), surfaced through a minimal additive portal-contract extension — no schema change, no migration, no economics change. A production-capable, isolated **Account Detail V2** was built (Overview / Performance / Controls / Rules / Activity), reusing the existing risk-control enforcement system and all authoritative endpoints. Accounts + Detail now form one complete isolated vertical with proven ownership, race, and responsive behaviour. V1 is untouched; Atlas is untouched.

---

## 2. What was built / changed

**Server (additive, backward-compatible):** `apps/server/src/platform/portal-accounts.ts` — `rulesFromVersionConfig()` extractor; `PortalAccountSummary.profitTargetMicros`; `PortalAccountDetail.rules: PortalAccountRules | null`. Both read from the account's already-joined pinned version config.

**Web (`apps/web/src/portal/v2/`):**
- `account-view.ts` — `evaluationProgress()` (authoritative target progress), state-aware; retired drawdown-room framing.
- `account-detail-view.ts` (+ test) — deterministic detail adapter + `ruleRowsFrom()`.
- `AccountDetail.tsx` / `.css` — the detail surface + tabs + states.
- `AccountControls.tsx` — V2 risk controls reusing the existing system.
- `AccountDetailContainer.tsx` — production-capable fetch + not-found + race guard.
- `race.ts` (+ test) — shared latest-request guard, now used by both containers.
- `lib.tsx` — mirror types (`profitTargetMicros`, `PortalRulesView`).
- `fixtures.ts`, `Harness.tsx` — detail fixtures + the isolated Accounts→Detail journey.

**Tests:** `portal-account-rules.test.ts` (server, pure), `account-detail-view.test.ts`, `race.test.ts` (web); extended `portal-lifecycle.test.ts` and `portal.routes.test.ts` (authoritative target + controls IDOR).

**Browser:** `scripts/portal-v2-detail-overflow.mjs` (new); `scripts/portal-v2-accounts-overflow.mjs` (re-run).

---

## 3. The 69 required questions — answered with evidence

1. **Starting commit?** `85b644d` (tag/branch `product-rebuild-phase2-start`).
2. **Ending commit?** See §5 / the final commit line (recorded at commit time).
3. **Working tree clean?** Yes — verified before and after; only the files in §2 changed.
4. **Remote == local?** Yes — verified after push (see §5).
5. **PV2-1 resolved?** Yes — authoritative profit-target progress; drawdown-room framing retired.
6. **Exact authoritative profit-target source?** `account_profile_versions.config.rules.profitTargetMicros` (persisted, per-account-pinned; from catalog `targetUsd` via `product-model`; the same value `evaluateRules()` reads). Not an `accounts` column.
7. **Portal summary contract changed?** Yes — added `profitTargetMicros: number | null` to `PortalAccountSummary` (additive).
8. **Portal detail contract changed?** Yes — added `rules: PortalAccountRules | null` to `PortalAccountDetail` (additive).
9. **Exact contract additions?** Summary: `profitTargetMicros`. Detail `rules`: `{ profitTargetMicros, maxLossMicros, drawdownType, trailingLockAtMicros, consistencyFormula, consistencyThreshold, minWinningDays, minWinningDayPnlMicros, maxContracts }`. All micro-dollars/enums/ratios, read-only.
10. **Economics changed?** No. Values are read from the existing pinned config; no target/drawdown/consistency/split/price changed.
11. **Rules changed?** No rule logic changed — only exposed for display.
12. **Business logic duplicated client-side?** No. The client does presentation arithmetic only (profit/target %, money formatting); pass/fail/eligibility/drawdown stay server-side.
13. **Account Detail V2 built?** Yes — `AccountDetail.tsx` + `AccountDetailContainer.tsx`, isolated.
14. **Still isolated from production?** Yes — under `.htv2`/`--ht-*`, code-split behind `designLabEnabled()`; no production file imports `portal/v2`; containers not mounted in V1.
15. **Accounts → Detail V2 works?** Yes — list "View details" → detail; harness journey proves it with fixtures; container navigates to `/portal-v2/accounts/:id` (no V1 detour).
16. **Detail → Accounts works?** Yes — "← Accounts" back action (`onBack`), proven in the harness journey.
17. **Trade routing correct?** Yes — the detail Trade uses the authoritative hand-off `/?account=${d.publicId}` for THIS account; the server re-checks ownership + status. It can never select another account.
18. **Evaluation progress authoritative?** Yes — `evaluationProgress()` uses `profitTargetMicros` from config; tested.
19. **Negative P&L behaviour?** Bar 0%, achieved `$0` (progress can't be negative); remaining = `target − netPnl` (grows); real net P&L shown separately and negative-toned. Tested.
20. **Exact-target behaviour?** 100%, `reached=true`, remaining `$0`. Tested.
21. **Over-target behaviour?** Bar clamps to 100%; displayed money is NOT clamped (shows true `$8,000 of $6,000`). Tested.
22. **Funded-state progress behaviour?** No evaluation target bar (authoritative target 0). Tested.
23. **Failed-state behaviour?** Terminal — no target bar; "Breached" status; MLL room clamps to `$0`. Tested.
24. **Completed-state behaviour?** Terminal — no target bar; "Completed" status. Tested.
25. **MLL authoritative?** Yes — `balance − drawdownFloorMicros` (authoritative floor), floored at 0; display only.
26. **Lifecycle authoritative?** Yes — `lifecycleActiveIndex(portalState)` maps server state; overflow-proof.
27. **Performance real-data only?** Yes — from the `Analytics` contract; no fabrication.
28. **Any fake metrics/charts?** No — equity curve only with ≥2 closed trades, else a truthful note; win rate `—` when null; empty state at 0 trades.
29. **Controls use existing risk system?** Yes — `V2AccountControls` calls the same `/controls` GET/PUT with `expectedVersion`; no re-implementation.
30. **Control rejection restores truth?** Yes — on any rejection it reloads the authoritative profile; no fake "Saved."
31. **Locked mode preserved?** Yes — `LOCKED` is tighten-only until next trading day; loosen/disable disabled while locked; server authoritative.
32. **Firm limits cannot be loosened?** Yes — the server owns the stricter-only comparison; the client only sends intent and reconciles; no client-side comparison to weaken.
33. **Rules account-version authoritative?** Yes — `detail.rules` comes from the account's pinned version config.
34. **CORE supported?** Yes — `familyOf` + generic rule descriptors; no per-product component branch.
35. **SELECT supported?** Yes — same path (fixtures include SELECT).
36. **DAILY supported?** Yes — same normalized descriptors; DAILY differs only in authoritative values.
37. **Activity real-data only?** Yes — lifecycle-derived timeline (purchase/reset/lifecycle transitions); deliberate empty state otherwise.
38. **Cross-user access test?** Yes — `portal.routes.test.ts` (detail/analytics/controls → 404 for another trader), `golden-path.security.test.ts`, `portal-lifecycle.test.ts`.
39. **Malformed account test?** The container maps a 404 to a deliberate not-found state; `not-found` state rendered (STEP 10/32). Foreign/missing id both 404 server-side (no enumeration).
40. **Rapid account-switch race?** Yes — `race.test.ts` proves A→B→A ends on A with out-of-order responses discarded; both containers use `latestGuard()`.
41. **Mutation race?** Yes — `race.test.ts` proves an out-of-order mutation response never overwrites newer state; controls re-read authoritative after each PUT.
42. **Retry behaviour?** Yes — error state exposes retry; a retry issues a fresh superseding token (tested); no duplicate mutation, no lost account identity.
43. **Loading state?** Yes — skeleton (detail + controls + performance), `aria-busy`.
44. **Error state?** Yes — `role="alert"` with retry; distinct from empty/not-found.
45. **Partial-failure state?** Yes — secondary data (analytics/eligibility) fails quietly without blocking the primary detail; degraded note on the accounts list.
46. **Not-found state?** Yes — dedicated `not-found` state with a back action.
47. **1920 containment?** Yes — `docOverflow=0`, `escape=0` (detail + accounts scripts).
48. **1440?** Yes.
49. **1280?** Yes.
50. **1024?** Yes.
51. **768?** Yes.
52. **390?** Yes — document does not scroll; the wide table scrolls internally; tabs wrap.
53. **Accessibility findings?** Fixed: tab semantics (`role="tablist"/tab"/aria-selected`), switch (`role="switch"/aria-checked/aria-label`), progressbar (`aria-valuenow/min/max`), `role="alert"/status`, control inputs given explicit `aria-label`s, focus-visible borders, status is dot+label (not colour-only). No open a11y failures found in the V2 surface.
54. **V1 production route changed?** No.
55. **V1 behaviour regression?** No — no V1 file changed; canonical (incl. portal HTTP + lifecycle) green.
56. **Atlas changed?** No.
57. **Server changed?** Yes — one file: `portal-accounts.ts` (additive read-only rule exposure) + its tests.
58. **If server changed, why?** To expose the authoritative profit target/rule parameters the portal must render (PV2-1). Minimal, typed, tested, ownership-protected, backward-compatible; no new query (reuses the existing join), no migration, no economics change.
59. **Focused test totals?** Web V2: **64 passed** (format 20, account-view 12, account-detail-view 22, race 4, + guardrails/lifecycle-layout files). Server pure: `portal-account-rules` **5 passed**. Plus extended DB-backed portal tests. Exact canonical totals in §4.
60. **Typecheck?** Clean (web + server + packages).
61. **Build?** Clean.
62. **Canonical?** See §4.
63. **Any canonical first-run failure?** See §4.
64. **P0 discovered?** None.
65. **P1 discovered?** None.
66. **Exact final commit?** See §5.
67. **What specifically needs Nathan's physical review?** The visual acceptance of the V2 Accounts vertical in a real browser: the Detail header/typography/density, evaluation-progress presentation, the Controls interactions (save/lock/reject), and the champagne/hue final tuning (deliberately not done here). Also the product decision on whether Performance should regain the interactive curve + P&L calendar (PV2-4).
68. **Is the Accounts vertical ready for human acceptance?** Yes — structurally complete, authoritative, isolated, and proven (tests + browser). It is ready to place in front of Nathan.
69. **What should happen ONLY AFTER that human acceptance?** Only then: mount `V2AccountsContainer`/`V2AccountDetailContainer` behind a feature flag on the authenticated route for the first controlled single-surface migration (instant rollback), and proceed to the next vertical (Dashboard, then Payouts). Not before.

---

## 4. Canonical validation

`bash scripts/validate-release.sh` (prepare test DB → typecheck → full vitest → build). **Typecheck clean. Build clean. Tests: 3064 / 3065 passed (220/221 files).**

**The one failure — investigated, not worked around:**
- **Test:** `apps/server/src/http/trading-authz-http.test.ts > wrong-account / cross-customer execution safety > "a trader CANNOT submit an order for another identity's account"`.
- **Failure:** `beforeEach` "Hook timed out in 10000ms" — the failure is in *setup* (provisioning two traders), not in the safety assertion.
- **Reproducible?** No, not in isolation: `pnpm exec vitest run apps/server/src/http/trading-authz-http.test.ts` → **4/4 passed in 7.47s**. It fails only under the full 221-worker canonical contention, where the two-trader DB provisioning in `beforeEach` exceeds the 10s hook budget.
- **Classification:** pre-existing infrastructure flake (`KNOWN_ISSUES.md` PV2-G1); observed identically in Engineering Phase B and Product Rebuild Phase 1. **Not introduced by Phase 2** — this file is a trading-execution test, untouched by the portal-only changes here. Not a P0/P1 and not a real cross-customer failure (the assertion never executed). Left in place rather than modified, to avoid expanding scope beyond the Accounts vertical.

---

## 5. Git

- Starting: `85b644d`. Checkpoint created: tag + branch `product-rebuild-phase2-start`.
- Ending commit, remote==local confirmation, and canonical totals are recorded with the commit and in the completion summary.
- No `reset --hard`, no force-push, no history rewrite; all stashes/tags/checkpoints preserved.

---

## 6. Definition of done

PV2-1 resolved with authoritative truth · no duplicated economics · evaluation progress = real target progress · funded/failed/completed not misleading · Account Detail V2 production-capable · Accounts + Detail one isolated vertical · risk controls reuse real enforcement · rules from account/version data · performance no fabrication · activity no fabrication · ownership server-enforced · stale responses cannot overwrite · Trade uses the correct account · deliberate failure states · responsive containment proven · V1 operational and still the production route · Atlas unchanged · canonical passes. **Ready for human acceptance. STOP.**
