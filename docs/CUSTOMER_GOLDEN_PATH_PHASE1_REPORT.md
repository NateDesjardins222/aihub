# Customer Golden Path — Phase 1 Report

**Phase:** Customer Golden Path — Phase 1 (Lifecycle Connection + Customer Experience).
**Branch:** `claude/futures-trading-simulator-v8qefu`. **Baseline:** `f903424` (tag
`customer-golden-path-phase1-start`). **Date:** 2026-10-02.

## 1. Mission & outcome

Make the existing customer lifecycle operate and present as ONE coherent Happy Trader experience, so a
customer always understands where they are, what they've accomplished, what remains, what happens next, and
what they can do now — without inventing business state, creating breadth, or using casino language. Outcome:
the Golden Path was mapped from code, the real disconnected chains were repaired at root cause, and a single
deterministic lifecycle presentation system (view model + Next Up engine) now drives a coherent Dashboard
command center, a truthful Billing surface, and a distinct passed-vs-funded presentation.

## 2. What shipped

**Map (§4).** `docs/CUSTOMER_GOLDEN_PATH_MAP.md` — all 13 transitions classified
CONNECTED/PARTIAL/DISCONNECTED with file:line evidence, each proven from code (not assumed).

**Root-cause repairs:**
- **GAP-A** — added the missing `account.completed` notification consumer case so the 5th-payout completion
  email/SMS actually enqueues (`apps/server/src/platform/notifications.ts`). The type, channels and template
  already existed; only the wire was missing. Regression test added.
- **WEB-1** — distinct `passed` status kind (champagne) and an *incoming* (not reached) Funded stage on the
  lifecycle rail for a passed account; the pass is no longer identical to a live funded account.
- **WEB-2** — ONE deterministic lifecycle view model + Next Up engine (`lifecycle-model.ts`), consumed by the
  Dashboard; stage/count logic is no longer re-derived divergently.
- **WEB-3** — Billing now reads real `commercial_orders` provenance via `GET /portal/orders`
  (`portal-billing.ts`): real product, authoritative amount (or null), customer-safe state, provisioned
  account, owner-scoped — replacing the synthetic account-size-as-price rows.

**Coherence:** Dashboard leads with the single most important next action (`NextUpCommand`) with hierarchy;
the stat strip and phase header read the engine; the positive payout prompt lives in Next Up, the negative
breach banner stays separate.

**Documented, deferred (contained, P2):** GAP-B (no producer for `payout.eligibility_unlocked` — eligibility
still shown on-demand + surfaced in Next Up); WEB-4 (Support lifecycle-association field). See KNOWN_ISSUES.

## 3. Files changed

- Server: `platform/notifications.ts` (+case, +test), new `platform/portal-billing.ts` (+test),
  `http/routes/portal.ts` (+`/orders` route).
- Web: new `portal/v2/lifecycle-model.ts` (+test), `portal/v2/dashboard.tsx` (command center + engine-driven
  counts), `portal/v2/Lifecycle.tsx`+`.css` (passed/incoming), `portal/v2/primitives.tsx`+`.css` (`passed`
  kind), `portal/v2/account-view.ts` + `account-detail-view.ts` (passed presentation), `portal/v2/pages.tsx`
  (Billing order shape + nullable amount), `portal/v2/pages.css` (command-center + billing), `portal/v2/containers.tsx`
  (Billing fetches real orders), `portal/lib.tsx` (billing types), tests updated (`lifecycle-layout.test.ts`).
- Docs: `CUSTOMER_GOLDEN_PATH_MAP.md`, `CUSTOMER_LIFECYCLE_EXPERIENCE_SYSTEM.md`, this report, KNOWN_ISSUES.

## 4. Validation

- Server typecheck PASS; web typecheck PASS; web build PASS.
- Focused tests PASS: `lifecycle-model` (11), `portal-billing` (3), `notifications` (8), full portal web suite
  (214), design-guardrails included.
- `customer:certify` FAST PASS (integrity invariants green).
- Lifecycle rail browser-verified in real Chromium at 6 widths (`portal-v2-lifecycle-overflow.mjs`).
- `validate:release` — see the run log recorded in the commit; PCV-6 determinism infra untouched and remains
  RESOLVED.

## 5. Golden Path scenarios A–H (how each is proven)

- **A — Purchase → provisioned evaluation:** CONNECTED (map T1–T3); proven by `commerce.test.ts` +
  `portal-billing.test.ts` (order→entitlement→account provenance).
- **B — Evaluation in progress:** `EVALUATION_PROGRESS` Next Up with truthful profit-target standing
  (`lifecycle-model.test.ts`).
- **C — Evaluation passed → funding:** distinct `passed` presentation + `FUNDING_IN_PROGRESS` Next Up + phase
  `QUALIFIED` (`lifecycle-model.test.ts`, `lifecycle-layout.test.ts`).
- **D — Funded, building toward payout:** `FUNDED_PROGRESS` with winning-days ratio (`lifecycle-model.test.ts`).
- **E — Payout eligible → request:** `REQUEST_PAYOUT` is the single top action, phase `PAYOUT_READY`
  (`lifecycle-model.test.ts`); request/paid guards in payout tests.
- **F — Paid → progress/clubs/certificate:** authoritative `cumulativeTraderShareMicros`, clubs, PAYOUT cert
  (map T10–T12; existing tests).
- **G — 5th paid → completion:** status COMPLETED, cert+achievement+celebration+trading-disable wired;
  completion email now enqueues (`notifications.test.ts`).
- **H — Billing provenance:** real orders, truthful amounts, owner isolation (`portal-billing.test.ts`).
- **Failure scenarios:** breach shows a dedicated banner (not a Next Up action); refunded order maps to
  REFUNDED and never counts as spend; a stranger never sees another customer's orders; empty portfolio renders
  an honest empty state, never a fabricated curve.

Full multi-state live `/portal` walkthrough (L5) is the human-acceptance step (§47).

## 6. §51 — The 28 hard questions (YES/NO + evidence)

1. **Was the Golden Path mapped from code before any UI change?** YES — `CUSTOMER_GOLDEN_PATH_MAP.md`, every
   transition with file:line, written before repairs.
2. **Was each transition classified CONNECTED/PARTIAL/DISCONNECTED/BROKEN?** YES — see the map's summary table.
3. **Were the real disconnected chains repaired at root cause, not masked?** YES — GAP-A is the missing
   consumer case itself; WEB-3 reads the real table rather than patching the synthetic rows.
4. **Is `EVALUATION_PASSED` now visually distinct from `FUNDED_ACTIVE`?** YES — distinct `passed` champagne
   status + incoming (not reached) Funded stage; `lifecycleActiveIndex('EVALUATION_PASSED') !==
   lifecycleActiveIndex('FUNDED_ACTIVE')` asserted.
5. **Is there ONE deterministic lifecycle view model, not divergent per-surface logic?** YES —
   `lifecycle-model.ts`, consumed by the Dashboard; 11 passing tests incl. a determinism test.
6. **Does the Next Up engine produce a single most-important action deterministically?** YES — priority +
   stable tie-break (createdAt, id), tested.
7. **Did the view model invent any business rule?** NO — it maps `portalState` and reads server-computed
   eligibility/paid; only presentation arithmetic.
8. **Did you begin Whop integration?** NO — Billing only *reads* existing `commercial_orders`; no Whop code,
   webhook, or checkout was added.
9. **Did you change any authoritative business rule (split, winning day, cycles, drawdown, cap)?** NO.
10. **Did you fabricate zero-data as authoritative (ERROR ≠ ZERO)?** NO — empty portfolio series renders an
    honest empty state; billing amount is `null` (shown as "—") when none was recorded, never invented.
11. **Is any REQUESTED/UNDER_REVIEW payout ever shown as PAID?** NO — customer-safe state comes from the
    authoritative `state`/`customerSafeFor`; billing maps only COMPLETED/PROVISIONED to PAID.
12. **Does any copy use manipulative/casino language?** NO — a test asserts no Next Up string matches the
    forbidden set ("trade now", "keep the streak", "make it back", "one more trade", "don't miss out",
    "increase size").
13. **Do you celebrate placing/winning trades, size increases, loss recovery, or frequency?** NO — celebrations
    fire only off authoritative lifecycle achievements (funded, clubs, completion).
14. **Did you add an evaluation-pass achievement to force a celebration?** NO — the pass gets a presentation
    moment only; no new achievement invented (GP1-CELEBRATION, by design).
15. **Is the completion notification now actually enqueued?** YES — `case 'account.completed'` added; regression
    test asserts one EMAIL + one SMS, deduped.
16. **Did you build a risky eligibility-event producer?** NO — GAP-B is documented P2; eligibility stays
    on-demand and is surfaced by Next Up. Strong decision recorded (§52).
17. **Is Billing provenance real and owner-scoped?** YES — reads `commercial_orders` joined to the provisioned
    account; a stranger sees zero orders (tested).
18. **Does `totalSpent` ever include unsettled or refunded amounts?** NO — only PAID amounts; refunds excluded
    (tested).
19. **Did you rebuild existing systems (celebrations, progress, payouts, Owner OS)?** NO — extended/connected
    only; the celebration engine, progress hero, and payout flows are untouched in substance.
20. **Did you create new breadth (providers, programs, pricing, nav, certificate types)?** NO — one read-only
    endpoint and one web adapter; no new product surface.
21. **Did you undo any PCV-6 fix?** NO — no PCV-6 infra touched; `customer:certify` FAST passes and the
    determinism harness files are unchanged.
22. **Did you use `/portal-v2` (the dev harness) as proof?** NO — unit/integration tests + the real-Chromium
    lifecycle check; the canonical `/portal` live walkthrough is the human step.
23. **Are empty/loading/error states honest?** YES — `useResource`/`ErrorPanel` enforce error≠zero; Billing,
    Dashboard and the engine all have explicit empty/loading paths.
24. **Is accessibility preserved (reduced-motion, keyboard, contrast)?** YES — the command bar honors
    `prefers-reduced-motion`; the lifecycle rail uses `aria-current`; the new status colour is a token in the
    existing palette.
25. **Does the design stay within the Experience System (no new palette, radius within guardrail)?** YES —
    champagne/rose tokens reused; radii use `--ht-radius-lg`; `design-guardrails.test.ts` passes.
26. **Did you make the strong product decisions yourself (no escalation on architecture/spacing/wording)?**
    YES — adapter architecture, Next Up priorities, the passed colour, billing state mapping, and the GAP-B
    deferral were all decided here (§52).
27. **Is the tree clean and remote == local after push?** YES — verified post-push (see §7 / final chat).
28. **Is human L5 acceptance claimed?** NO — HUMAN VERIFIED = PENDING (§47); this report is Claude's own
    verification only.

## 7. Status

Golden Path mapped; real gaps repaired at root cause; lifecycle coherent; Next Up works; passed-vs-funded
distinct; Billing truthful; tests green; `customer:certify` FAST green; docs complete. No P0/P1 introduced.
Per §48, this phase STOPS here — the Whop Commerce Integration phase is NOT begun.
