# PRODUCT RECOVERY — PHASE 3 REPORT

**Happy Trader Funding.** Close the remaining core behavioral gaps left by Phase 2, before any
Product Rebuild. Brutally factual. Software-only: no real money, no production providers, no redesign,
no Phase 13. Companions: `PRODUCT_BEHAVIORAL_TRUTH.md` (L0–L5 matrix, updated),
`OWNER_OS_BACKEND_ONLY_TRIAGE.md` (new), `HUMAN_GOLDEN_PATH.md` (extended).

Scope was deliberately narrow: the six behavioral gaps Phase 2 documented, nothing else. No
re-audit; no repeat of L3/L4-proven tests; no redesign of Portal/Atlas/Owner OS; no production
providers or real money touched. Evidence model L0–L5 (**Claude never assigns L5** — that is Nate's
physical run).

## What was closed (the six gaps → now proven)

1. **EOD_TRAILING drawdown through a REAL engine day rollover (STEP 2).** New
   `apps/server/src/trading/eod-trailing-engine.test.ts`. Core-50K (start 50,000 / initial floor
   48,000 / lock 50,000 / EOD trailing 2,000). Day boundaries are driven deterministically by
   stamping quotes on successive CME business dates and calling the engine's real mark path
   (`enforceRules` → `applyRules` → `rollTradingDay` → `persistRuleState`) — **no wall-clock sleeps,
   no clock weakening.** Proven: intraday unrealized profit does NOT ratchet the floor; the EOD roll
   ratchets it correctly; the floor never moves backward; it locks at 50,000 and never exceeds it; it
   **persists across a brand-new engine (restart)**; and a trailing breach fires when equity reaches
   the floor. **≥L3 (L4 on the restart/persistence cross-system leg).**

2. **Core >50% consistency exact boundaries (STEP 3).** New
   `apps/server/src/trading/consistency-gate-engine.test.ts`. Canonical rule read from
   `packages/contracts/src/product-catalog.ts` (CORE `evalConsistencyPct = 50` → threshold 0.5,
   formula BEST_DAY_OVER_TOTAL, min trading/winning days 0). Intended boundary documented: passing ⇔
   bestDay / totalNet ≤ threshold — the best single day may **equal** 50% but not exceed it, and a
   ratio above 50% **delays** the pass (GOAL_REACHED), it never fails the account. Proven through the
   real engine day-roll: **>50% (0.833) → GOAL_REACHED** (delayed, not FAILED); **=50% → PASSED**
   (inclusive boundary); later profit on other days **restores** eligibility; a well-distributed
   **<50%** account passes cleanly; reaching PASSED is idempotent. **L3/L4.** (The eval→funded
   exactly-once transition itself is already L4 from Phase 2 — not duplicated.)

3. **Payout exact boundaries + accounting invariant (STEP 4/5).** New
   `apps/server/src/platform/payout-boundaries-service.test.ts`, driven through the **real payout
   service + Postgres ledger** (was pure-only L1). All numbers imported from `@atlas/contracts` so the
   test asserts the shipping catalog, not invented values. Proven (L3/L4): winning-day threshold
   inclusive at **exactly $150.00** ($149.99 fails, $150.00 and $150.01 qualify); **4 days ineligible,
   5 eligible**; the request ceiling composes **exactly 50% of withdrawable** (approve at the ceiling,
   reject one micro above); **per-size caps 25K=$1,000 / 50K=$2,000 / 100K=$3,500 / 300K=$5,000**;
   **Daily buffers 25K=$1,000 / 50K=$2,000 / 100K=$4,000** protected from the withdrawable; the
   **90/10 split** and the **money invariant** — *pre − debit = post* and *trader + firm = gross* to
   the micro, with the firm absorbing any rounding remainder, verified on both the approval result and
   the append-only ledger DEBIT row, on amounts whose 90% is not a whole micro. Integer micros
   throughout, **no penny/rounding drift.**

4. **Bracket/OCO reconnect safety + account-switch isolation (STEP 6/7/8).** New
   `apps/server/src/trading/bracket-reconnect-isolation.test.ts`. Reconnect: after a full engine
   restart on the same DB the bracket's OCO pair survives — **exactly one WORKING stop-loss and one
   WORKING take-profit, no duplicate, no orphan** — and still fires (TP fills → SL cancels → flat, no
   working protective leg left). Isolation: with one engine operating two accounts, every order
   addressed to A belongs to A and every order to B belongs to B; flattening A cancels only A's
   protective legs and leaves B's position and orders **byte-for-byte untouched**. **Any cross-account
   mutation would be a P0 — none occurred.** L3/L4. (STEP 8 partial/changing state: the engine's
   bracket legs are full-size protective orders tied to the position; partial-fill re-sizing of
   protective legs beyond OCO cancel-on-fill is not a separate supported behavior in V1 — documented
   as N/A rather than invented.)

5. **Staff-management UI + RBAC adversarial (STEP 9/10).** The sole LAUNCH-CRITICAL UI gap Phase 2
   named is now **built**: `apps/web/src/admin/pages/OwnerOsPages.tsx` `StaffPage` runs the full
   lifecycle from the console — invite (email/role + STAFF step-up), change role, disable/reactivate,
   revoke sessions, resend/revoke invitations — reusing the proven step-up dialog pattern
   (`lib/stepup.ts`) and the exact reauth the server enforces. Owner-only controls are gated on
   SUPER_ADMIN in the UI to match the server's owner-only permission tier; lower operators see a
   read-only roster. New **RBAC adversarial** test `apps/server/src/http/staff-rbac-adversarial.test.ts`
   (L4) proves the one edge not already covered: a valid STAFF step-up **never substitutes for the
   owner-only permission**, so no non-owner — not even an ADMIN acting on itself — can escalate; the
   owner path remains usable. Last-owner protection, no-self-service-grant, trader denial, step-up
   enforcement and role-smuggling are already L3/L4 (`staff.test.ts`, `owner-staff-http.test.ts`,
   `m10-1-rbac-redteam.test.ts`) and were **not duplicated**. UI typechecks and builds; the
   `owner-os-acceptance` browser suite now asserts the owner's staff controls render.

6. **Owner OS backend-only triage + wire launch-critical (STEP 11/12).** New
   `OWNER_OS_BACKEND_ONLY_TRIAGE.md` classifies every backend-only family. **Finding: after Staff, no
   LAUNCH-CRITICAL family lacks a UI.** The remaining ~13 backend-only families are observability,
   ops-productivity, or diagnostics (full-test, inactivity-sweep [runs automatically], config-changes,
   alert channels/subscriptions, daily-brief, global event search/correlation [audit explorer already
   covers operator search], object inspectors, finance exports/views/notes/tasks, webhook monitor,
   execution-quality, agreements) — all **POST-LAUNCH or INTERNAL**, none blocking a beta launch, none
   DEAD. Owner core operations (customers, accounts, funding, payouts, products/config, kill switches,
   holds, support, affiliates, risk/trading surveillance, audit, economics, provider health,
   certificates, staff) are all reachable from the console without dev tools.

## P0 / P1 findings

- **P0 discovered:** **None.** The account-switch isolation test specifically hunted the P0 hard-stop
  condition (cross-account bracket mutation / wrong-account execution) and found none.
- **P1 discovered:** **None new.** The gaps Phase 2 documented were *unproven*, not broken — each is
  now proven with the behavior already correct. No production risk-engine or money-path logic was
  changed to make a test pass.
- **Self-escalation check:** confirmed structurally safe — `roles.manage` / `staff.manage` are the
  owner-only tier (`rbac.ts`), so the only role that can change roles is already SUPER_ADMIN; a valid
  step-up does not bypass the permission (new adversarial test). No escalation path exists.

## Determinism (STEP 15)

Every new test is deterministic. Day rollovers are driven by dated quotes + `enforceRules`, never by
`sleep`; fills settle on the harness's real async drain, not fixed timeouts for correctness.

## Files changed

New tests: `trading/eod-trailing-engine.test.ts`, `trading/consistency-gate-engine.test.ts`,
`trading/bracket-reconnect-isolation.test.ts`, `platform/payout-boundaries-service.test.ts`,
`http/staff-rbac-adversarial.test.ts`. New UI: `StaffPage` + staff mutation API in
`admin/pages/OwnerOsPages.tsx`; `AdminApp.tsx` passes `maySuper`. New docs:
`OWNER_OS_BACKEND_ONLY_TRIAGE.md`, this report. Updated: `PRODUCT_BEHAVIORAL_TRUTH.md`,
`HUMAN_GOLDEN_PATH.md`, `tests/browser/owner-os-acceptance.spec.mjs`. **No production risk/money/engine
logic changed** — this phase is proof + one launch-critical UI + docs.

## Answers to the Phase 3 questions

1. **Starting commit?** `27af650`.
2. **Ending commit?** This commit on `claude/futures-trading-simulator-v8qefu` (see git log).
3. **Which behavioral gaps were in scope?** The six from Phase 2 §43(a): EOD engine day-roll, Core
   >50% consistency through the real path, payout fine-boundaries through real stats, bracket
   reconnect/isolation cleanup, staff-management UI, Owner-OS backend-only surfacing.
4. **EOD trailing through a real day rollover — proven?** Yes. `eod-trailing-engine.test.ts`, ≥L3.
5. **Does intraday unrealized profit ratchet the EOD floor?** No — proven frozen intraday.
6. **Does the EOD roll ratchet the floor correctly?** Yes — `floor' = max(prevFloor, min(close −
   maxLoss, start + lockAt))`, trailing the day's equity high-water at the roll.
7. **Does the floor ever move backward?** No.
8. **Does it lock at 50,000 and stop?** Yes — never exceeds the lock level.
9. **Does the floor survive a restart?** Yes — a fresh engine on the same DB reads the persisted floor.
10. **Does a trailing breach fire at the floor?** Yes — status → FAILED when equity ≤ floor.
11. **Core >50% consistency — where does the boundary sit?** Inclusive at 50%: best/total ≤ 0.5 passes;
    > 0.5 delays. Documented from `consistencyStatus` in `@atlas/core`.
12. **<50% behavior?** Eligible — passes cleanly (proven).
13. **=50% behavior?** Eligible — the boundary is inclusive (proven through the engine).
14. **>50% behavior?** Delayed — GOAL_REACHED, **never FAILED** (proven).
15. **Does later profit restore eligibility?** Yes — profit on other days drops the ratio to ≤ 50% →
    PASSED (proven).
16. **Any duplicate funded?** No — reaching PASSED is idempotent here; eval→funded exactly-once is L4
    from Phase 2 (not re-run).
17. **Payout $149.99 vs $150.00 vs $150.01?** $149.99 does not qualify; $150.00 and $150.01 do
    (inclusive at exactly $150.00). Proven through the real service.
18. **4 days vs 5 days?** 4 ineligible (INSUFFICIENT_WINNING_DAYS), 5 eligible. Proven.
19. **The exact 50% constraint?** Request ceiling = min(withdrawable, product cap, floor(50% ×
    withdrawable)); approves at the ceiling, rejects one micro above (ABOVE_MAXIMUM). Proven.
20. **Per-size caps?** 25K=$1,000 / 50K=$2,000 / 100K=$3,500 / 300K=$5,000 — asserted against the
    canonical catalog and enforced by the service.
21. **Daily buffers?** 25K=$1,000 / 50K=$2,000 / 100K=$4,000 — protected from the withdrawable. Proven.
22. **90/10 split?** Yes — trader 90%, firm 10%; the firm share is the exact complement.
23. **Penny / rounding drift?** None — trader + firm = gross to the micro; firm absorbs the rounding
    remainder; all money integer micros. Proven on values whose 90% is fractional.
24. **Accounting invariant (pre − debit = post; trader + firm = gross)?** Holds on both the approval
    result and the append-only ledger DEBIT row. Proven.
25. **Bracket/OCO durable across reconnect?** Yes — survives a full engine restart, exactly one WORKING
    SL + one WORKING TP, no duplicate/orphan, still fires. Proven.
26. **Account-switch isolation?** Yes — operating account A never mutates B; flatten A cancels only A's
    legs; B untouched. Proven.
27. **Any cross-account mutation (P0)?** No.
28. **Partial / changing state (STEP 8)?** OCO cancel-on-fill is proven; partial-fill re-sizing of
    protective legs is not a separate V1 behavior — documented N/A, not invented.
29. **Staff-management UI built?** Yes — invite / role / disable / reactivate / revoke sessions /
    resend-revoke invitations, with STAFF step-up, on existing Owner OS patterns.
30. **Does it reuse the step-up dialog pattern?** Yes — `lib/stepup.ts`, the same reauth the server
    enforces; the UI never makes an authorization decision of its own.
31. **Is the last SUPER_ADMIN protected?** Yes — enforced server-side (`assertNotLastOwner`), surfaced
    verbatim in the UI.
32. **Can a trader see staff management?** No — the console denies traders entirely (L4, existing);
    non-owner operators see a read-only roster.
33. **Can an operator self-escalate?** No — role/staff management is the owner-only permission tier; a
    valid step-up does not bypass it (new adversarial test, L4).
34. **Audit on staff changes?** Yes — every mutation is audited server-side (`recordAudit`).
35. **RBAC adversarial coverage added without duplication?** Yes — one new file for the step-up-vs-
    permission edge; last-owner / no-self-grant / trader-denial / role-smuggling left to their existing
    L3/L4 tests.
36. **Owner OS backend-only families triaged?** Yes — `OWNER_OS_BACKEND_ONLY_TRIAGE.md`.
37. **Any LAUNCH-CRITICAL family still lacking UI?** No — Staff was the last; nothing else is launch-
    blocking.
38. **Any DEAD families?** None — every route group is still referenced and purposeful.
39. **Can the owner operate core functions without dev tools?** Yes — enumerated in the triage;
    exercised by `owner-os-acceptance` and `HUMAN_GOLDEN_PATH.md`.
40. **Were any production providers or real money touched?** No.
41. **Were deterministic tests used throughout (no sleep-based correctness)?** Yes (STEP 15).
42. **Was PRODUCT_BEHAVIORAL_TRUTH.md updated?** Yes — the six gaps moved up to their proven levels;
    the closed gaps marked closed.
43. **Was HUMAN_GOLDEN_PATH.md kept practical?** Yes — added a short staff-management walkthrough
    (invite, last-owner refusal, non-owner read-only) as the L5 human step.
44. **Validation run?** Focused tests (28/28 across 5 new files) → typecheck (5 projects clean) →
    build (packages + server + web clean) → canonical suite once. See Validation below.
45. **What remains for the human / what should come next?** Human acceptance stays **PENDING HUMAN**
    (`HUMAN_ACCEPTANCE_CHECKLIST.md` + the extended golden path, incl. the staff walkthrough). With
    these gaps closed, the recommended next phase is the **Atlas + Portal quality rebuild** as its own
    dedicated effort — not started here. **STOP after Phase 3 and wait for owner review.**

## Validation

- Focused new tests: **28/28 pass** across the 5 new files (EOD, consistency, brackets, payout
  boundaries, staff RBAC).
- Typecheck: **5 projects clean** (contracts, instruments, core, web, server).
- Build: packages + server clean; web builds (AdminApp chunk grew with the staff UI).
- Canonical suite (`pnpm test`), run ONCE: **210 test files / 2961 tests PASS (exit 0)**, 428s. No
  flake this run; nothing skipped or masked.

## Definition of done / STOP

The six documented behavioral gaps are closed with real, deterministic proof at ≥L3 (L4 where
cross-system); no P0, no new P1; the one launch-critical UI gap (staff management) is built and
guarded; the Owner-OS backend-only surface is triaged with no launch-critical omissions; docs updated
honestly; the human golden path extended. **Human acceptance remains PENDING HUMAN. The Product
Rebuild does not begin automatically — Phase 3 stops here for owner review.**
