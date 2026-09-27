# PRODUCT RECOVERY — PHASE 2 REPORT

**Happy Trader Funding.** Behavioral proof, real operability & system integrity. Brutally factual.
Software-only: no real money, no production providers, no redesign, no Phase 3. Companion:
`PRODUCT_BEHAVIORAL_TRUTH.md` (L0–L5 matrix), `ATLAS_PERFORMANCE_BASELINE.md`, `HUMAN_GOLDEN_PATH.md`.

Method: two source-tracing passes classified every trading/lifecycle/owner behavior by whether an
existing test drives the **real** boundary; Phase-2 then added behavioral tests to close the
highest-risk gaps (wrong-account authorization, four personal controls, firm-vs-personal, the golden
max-trades scenario) and a read-only cross-layer **state probe**. Evidence levels per STEP 1.

## The 43 answers

1. **Starting commit?** `2fe43da`.
2. **Ending commit?** See git log on `claude/futures-trading-simulator-v8qefu` (this commit).
3. **Files changed?** New: `platform/state-probe.ts`, `scripts/state-probe.ts`,
   `trading/golden-max-trades.test.ts`, `trading/personal-risk-gate-extra.test.ts`,
   `http/trading-authz-http.test.ts`, and docs (this, BEHAVIORAL_TRUTH, ATLAS_PERFORMANCE_BASELINE,
   HUMAN_GOLDEN_PATH). Updated: FUNCTIONAL_TRUTH, UX_DEBT, HUMAN_ACCEPTANCE_CHECKLIST, KNOWN_ISSUES.
   **No production code path changed** — this phase is proof + read-only tooling + docs.
4. **P0 discovered?** **None.**
5. **P1 discovered?** No *new* broken P1s. Pre-existing **gaps** (unproven, not broken) were found and
   most were closed (below); remaining ones are documented, not defects.
6. **P0 repaired?** N/A (none).
7. **P1 repaired?** The one true risk — wrong-account execution authorization being **unproven** — is
   now proven (L4). It was already correctly implemented; the gap was test coverage, now closed.
8. **Portal controls at L3?** The full personal-risk control set (10 controls) is L3+ on the real
   order path. Portal save→persist is L2–L4 (golden scenario L4 for max-trades).
9. **Portal controls at L4?** Max-trades golden scenario (L4); risk-value cross-layer via probe (L4).
10. **Atlas controls at L3?** Execution, brackets/OCO, account-state enforcement, idempotency,
    all personal-risk controls — L3+.
11. **Atlas controls at L4?** Execution integrity / P&L (money-oracle + pnl-reconciliation), wrong-
    account authorization (HTTP), rejected-order-no-execute — L4.
12. **Owner OS controls at L3/L4?** Owner HOLD→trading-blocked L4; kill-switch→order-blocked L3;
    console kill-switch/flag mutations L4 (Phase-1 browser).
13. **Which remain only L0/L1/L2?** Core >50% consistency pass-gate (L1, pure-only); EOD_TRAILING
    floor ratchet *through the engine* (L1 system / core math L4); payout fine-boundaries
    $149.99/$150.00, 4-vs-5 days, over-cap (L1, pure-only); **Staff-management UI (L0, not built)**.
14. **Does max-trades/day reject the 2nd opening trade through the real order path?** **YES.**
    `golden-max-trades.test.ts` — 2nd `submitOrder` → `PERSONAL_MAX_TRADES`, no order/exec row,
    balance+position unchanged, survives a fresh engine (reconnect).
15. **Does personal daily loss actually block correctly?** **YES** (L3, `personal-risk-gate` G07,
    real path, day P&L from the real ledger).
16. **Can personal controls ever loosen firm rules?** **NO.** `personal-risk-gate-extra` E05: a
    personal max of 10 with a firm cap of 5 still rejects 6 (`MAX_CONTRACTS_EXCEEDED`); effective =
    min(firm, personal).
17. **Any wrong-account execution?** **NO.** `trading-authz-http` — foreign account → 404, untouched.
18. **Any cross-customer access?** **NO** (same test; plus golden-path.security read-path isolation).
19. **Do brackets/OCO behave correctly?** **YES** (L3) — TP fills→SL cancels and vice-versa, long &
    short, live + replay; flatten leaves no protective order.
20. **Any orphan orders?** None found; `execution-races` proves flatten cancels the bracket. Bracket
    cleanup specifically on **reconnect/account-switch** is `UNVERIFIED` (no test) — documented.
21. **Does EOD trailing drawdown behave correctly?** Core math **YES** (exhaustive pure `@atlas/core`
    tests: intraday-no-ratchet, EOD-ratchet, never-backward, ≤ lock; post-payout floor safety L4 via
    real service). **GAP:** no real-engine day-roll test persisting the floor for an EOD_TRAILING
    account (engine floor persistence proven for STATIC/INTRADAY_TRAILING). L1 at the system level.
22. **Does consistency behave correctly?** Select 40% blocks payout but never fails a funded account —
    **L4**. Core >50% pass-gate — **L1** (pure only). Fine boundaries — pure only.
23. **Does eval→funded happen exactly once?** **YES** (L4) — concurrent approvals → one funded account.
24. **Does reset preserve history?** **YES** (L4) — failed life immutable, reset at original price.
25. **Does payout qualification behave correctly?** **L4** for a full single cycle (5 days ≥ $150,
    90/10 split, cap, debit); fine boundaries proven pure only (L1).
26. **Does payout #5 complete the account?** **YES** (L4) — status COMPLETED, `MAX_CYCLES_REACHED`.
27. **Is payout #6 rejected?** **YES** (same test).
28. **Can owner naturally reach Owner OS?** **YES** (L4, Phase-1 browser: portal menu + terminal rail).
29. **Can trader reach it?** **NO** (entry hidden; `/admin` denies; L4).
30. **Do holds actually affect Atlas?** **YES** (L4) — real hold → real `submitOrder` blocked; release restores.
31. **Do kill switches actually affect Atlas?** **YES** (L3) — engaged switch → `POST /orders` 423.
32. **Are staff controls safe/usable?** Backend is mature and safe (RBAC + STAFF step-up + audit), but
    there is **no console UI** (L0). STEP 18 decision: deferred — see below. Not a trading blocker.
33. **Are Portal/Atlas/Owner values consistent?** Values flow from one server source and the golden
    scenario confirms the probe/DB/engine agree; a full one-customer live cross-surface table is a
    human step (HUMAN_GOLDEN_PATH #13–15).
34. **Does state survive restart/reconnect?** **YES** for risk state (golden reconnect: fresh engine
    still enforces); durability of counters across engine restart proven (`personal-risk-gate` G10).
35. **Any duplicate/retry bugs?** None found — idempotency L4 across order dedup, funded transition,
    payout, adjustments, webhook replay.
36. **Market-data failure behavior?** Firm gate refuses order entry on stale/frozen/no-data
    (`MARKET_DATA_UNAVAILABLE` / freshness `blocksOrderEntry`); no invented prices. (Existing coverage;
    not re-proven this phase — L3 via risk.ts + harness freshness.)
37. **Atlas measured latency?** API `/ready` ~3 ms, bars ~17 ms, terminal→chart-ready ~300 ms
    (headless). No gross latency bug. See ATLAS_PERFORMANCE_BASELINE.md.
38. **Biggest Atlas latency source?** Not server/data. First-paint cost is the **753 KB monolithic
    bundle**; perceived "lag" is **interaction quality** (rebuild concern). Minor: redundant 5s/3s
    polling.
39. **Candle correctness status?** Internal correctness **VERIFIED** (OHLC invariants, monotonic,
    1m→5m aggregation parity for NQ/ES/GC/CL). External raw-vs-Yahoo parity **UNVERIFIED** (no
    external reference headless).
40. **Backend systems unquestionably worth preserving?** Risk engine + personal-risk gate; execution
    engine + ExecutionProvider seam; money/P&L ledger; payout engine + 5-cycle completion; enforcement
    holds + hash-chained audit; lifecycle/reset; provisioning + profiles; identity/RBAC + step-up + MFA;
    market-data provider seam. All L3/L4.
41. **Frontend systems to rebuild?** Customer Portal presentation; Atlas interaction/feel; Owner OS
    presentation (secondary). See PRODUCT_UX_DEBT.md.
42. **What remains for human verification?** All of HUMAN_GOLDEN_PATH.md (L5). Plus: live order→fill
    latency, live cross-surface truth table, external chart parity, overall UX quality.
43. **What should Phase 3 be?** Owner's call. Recommended order: (a) close the documented behavioral
    gaps — EOD_TRAILING engine day-roll test, Core >50% consistency through the real cert path, payout
    fine-boundaries through real stats, bracket reconnect-cleanup; (b) build the Staff-management
    console UI (backend is ready) + surface remaining Owner-OS backend-only ops; (c) then the
    **Atlas + Portal quality rebuild** as its own dedicated phase (with the input-to-paint
    instrumentation this baseline calls for). No real money / production providers until a separate
    go-live phase.

## New behavioral tests added (all pass)
- `trading/golden-max-trades.test.ts` — the golden scenario (L4).
- `http/trading-authz-http.test.ts` — wrong-account/cross-customer authorization at the real HTTP
  order + flatten boundary (L4). 4/4.
- `trading/personal-risk-gate-extra.test.ts` — PROFIT_LOCK / DAILY_DRAWDOWN / TRADING_WINDOW /
  SESSION_RESTRICTION on the real path + firm-vs-personal composition (L3). 6/6.
- `platform/state-probe.ts` + `scripts/state-probe.ts` — read-only cross-layer probe (dev/test only,
  refuses production).

## STEP 18 decision — Staff management
Backend contracts (`owner-staff.ts`: invite / role / suspend / reactivate / revoke sessions, all with
STAFF step-up + audit, SUPER_ADMIN protected) are **mature**. A safe console UI needs the proven
step-up dialog pattern applied to a multi-field invite/role form. Given Phase-2's mandate is
behavioral proof of the trading/money core (not new UI) and this is not a trading-integrity blocker,
it is **deferred to the Owner-OS operability sub-phase** (STEP 18 "document the exact blocker" path).
Recommended, not built here. The misleading "invite dialog" note was already corrected in Phase 1.

## Prompt-injection note
During the audit, a benign line ("The date has changed…") appeared inside a tool-output stream and
was correctly identified as not-user-authored and ignored. No action was taken on it. Recorded for
transparency.

## Testing philosophy honored (STEP 31)
No test count inflation: 3 new files / 11 strong scenario tests, each entering a real boundary
(engine `submitOrder`, real `POST /orders`, real domain services) with real Postgres. Nothing mocks
the thing under test.

## Validation
- Typecheck (5 projects) clean.
- New tests: golden 1/1, authz 4/4, extra-gate 6/6 — all pass.
- Canonical: **205 test files / 2933 tests PASS (exit 0)**, 408s. One pre-existing load-sensitive
  flake surfaced during validation — `engine.test.ts > reverses a long into a short` used a fixed
  `settle(20)` that the async reversal fill chain can outlast under full-suite CPU contention (it
  passed in isolation and alongside the new files; failed once at full load). Made deterministic with
  a bounded poll (test-wait only; no engine logic changed), then canonical is green. This is the same
  class of flake, and the same fix, as the Phase-12.5 adversarial hardening.

## Definition of done / STOP
Phase-1 claims reclassified under L0–L5 (`PRODUCT_BEHAVIORAL_TRUTH.md`); risk controls, execution,
wrong-account safety, account-state, brackets/OCO, holds, kill switches, eval→funded, reset, payout
qualification and 5-cycle completion carry real behavioral proof; consistency and EOD engine-level
and staff-UI gaps documented honestly; Atlas latency measured; chart correctness tested (internal
verified, external unverified); UX debt documented; human golden path written; P0/P1 list honest
(no P0). **Human acceptance remains PENDING HUMAN.** Phase 3 does not begin automatically.
