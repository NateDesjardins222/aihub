# PRODUCT BEHAVIORAL TRUTH

**Happy Trader Funding — Product Recovery Phase 2.** Evidence-graded truth for the behaviors that
make this a coherent trading business. From `2fe43da`. Software-only; no real money/providers.

## Evidence levels (STEP 1)
`L0` exists · `L1` wired · `L2` persisted (saves + reloads) · `L3` behaviorally verified (the
configured/saved state changes real system behavior through the real path) · `L4` cross-system
verified (DB / API / engine / probe agree) · `L5` HUMAN VERIFIED — **only Nathan may assign L5; it
is PENDING HUMAN for everything below.** "E2E VERIFIED" requires ≥ L4.

Method: two source-tracing passes over the whole test suite classified each behavior by whether an
existing test drives the **real** boundary (engine `submitOrder` / HTTP route / domain service) or
only a pure function; then Phase-2 added behavioral tests to close the highest-risk gaps. A test
that mocks the thing it purports to prove is capped at the level it actually reaches.

> Phase-1 said "56/61 Portal E2E, 33/33 Atlas, all risk controls wired, no P0." Under this stricter
> bar those numbers described **wiring (L1/L2)**, not behavior. This document supersedes them for
> the trading-integrity core. Where a Phase-1 claim outran its evidence it is downgraded here and in
> PRODUCT_FUNCTIONAL_TRUTH.md (STEP 28).

---

## Deterministic test subject (STEP 2)
The engine harness (`trading/harness.ts::createFixture`) provisions a real Postgres account: a
**Core-50K-shaped evaluation** — start 50,000 / profit target 3,000 / EOD-trailing drawdown 2,000 /
initial floor 48,000 / 5 minis / simulation only, trading date fixed to 2026-09-15 so session gates
are deterministic. IDs are per-test (isolated), printed by the state probe. The **state probe**
(`platform/state-probe.ts`, read-only; CLI `scripts/state-probe.ts`) resolves an account by
UUID / `SIM-000123` / owner email and dumps the authoritative cross-layer snapshot
(identity, balance, realized P&L, MLL/floor, status, personal controls, holds, payouts, positions,
recent orders, risk events, audit) used by the behavioral tests to compare truth across layers.

---

## Trading & risk (the order path)

| Behavior | Level | Evidence (test · it) | Notes |
|---|---|---|---|
| **GOLDEN: MAX_TRADES/day = 1** — save→persist→enforce→no-execute-on-reject→reconnect→reduce-allowed | **L4** | `trading/golden-max-trades.test.ts` (NEW) | Saved via Portal domain svc `upsertPersonalControl`; confirmed via probe; 2nd order rejected `PERSONAL_MAX_TRADES`; **no order/execution row, balance+position unchanged**; risk event recorded; **fresh engine still rejects**; flatten allowed |
| MAX_TRADES / DAILY_LOSS_LIMIT / MAX_POSITION / DAILY_CONTRACT_LIMIT / CONSEC_LOSS+COOLDOWN | **L3** | `personal-risk-gate.test.ts` G02–G07 | real `submitOrder`; DB day-state asserted |
| PROFIT_LOCK / DAILY_DRAWDOWN / TRADING_WINDOW / SESSION_RESTRICTION | **L3** | `personal-risk-gate-extra.test.ts` E01–E04 (NEW) | were L1 (pure evaluator only); now driven through `submitOrder` |
| Firm vs personal — personal can only TIGHTEN; effective = min(firm, personal) | **L3** | `personal-risk-gate-extra.test.ts` E05–E06 (NEW) | looser personal (10) still hits firm cap 5 → `MAX_CONTRACTS_EXCEEDED`; tighter personal (2) → `PERSONAL_MAX_POSITION` |
| Rejected order does not execute; balance/position unchanged | **L4** | golden-max-trades (NEW) + `idempotency.test.ts` | engine is the matcher; "provider receives nothing" = no DB mutation |
| Execution integrity / P&L / fees / no double / phantom / drift | **L4** | `money-oracle.test.ts`, `pnl-reconciliation.test.ts` | independent oracle vs engine; accounts+trades+journal agree, 8 instruments |
| Brackets / OCO both sides; flatten cancels protective; no orphan | **L3** | `brackets.test.ts`, `execution-races.test.ts` | live + replay; flatten "leaves no protective order behind" |
| **Bracket/OCO durable across engine restart (reconnect) + account-switch isolation** | **L4** | `trading/bracket-reconnect-isolation.test.ts` (NEW, P3) | was `UNVERIFIED`. After a full engine restart on the same DB the OCO pair survives (exactly one WORKING SL + one WORKING TP, no duplicate/orphan) and still fires; ops on account A never mutate account B, flatten A cancels only A's legs. **No cross-account mutation (no P0).** |
| **Wrong-account / cross-customer execution authorization** | **L4** | `http/trading-authz-http.test.ts` (NEW) | was **L1**. Real `POST /orders` + `/positions/:sym/flatten`: foreign account → **404 ACCOUNT_NOT_FOUND, account untouched** (no order/exec/position); own account passes; unauth rejected. **No P0.** |
| Idempotency (dup clientOrderId) | **L3** | `idempotency.test.ts` | dedup in `submitLocked`; realized once |
| Account-state enforcement (FAILED/LOCKED/DISABLED/COMPLETED/HOLD) + liquidation + reduce-allowed | **L3** | `rules.integration.test.ts`, `adversarial.test.ts`, `instrument-policy.test.ts`, `liquidation-state.test.ts` | new orders refused; flatten allowed |

### Gaps below L3 (honest)
- ~~**Bracket cleanup on reconnect / account-switch**~~ — **CLOSED in Phase 3** (L4, `bracket-reconnect-isolation.test.ts`).
- **DAILY_DRAWDOWN across a real day-roll** — E02 proves intraday; the day-boundary reset of the high-water is not separately driven. Adequate for intraday; `PARTIAL`. (Note: the EOD **drawdown-floor** day-roll is now separately proven — see the EOD row below.)

---

## Lifecycle, payouts, enforcement, money

| Behavior | Level | Evidence | Notes |
|---|---|---|---|
| **Owner HOLD actually blocks trading** | **L4** | `enforcement-integration.test.ts` | real `placeHold` + real `submitOrder` → `ACCOUNT_ENFORCEMENT_HOLD`, position stays 0; reduce/close never blocked; `releaseHold` restores. Order path consults `checkEnforcementHold` (engine.ts:1417) |
| **Kill switch actually changes behavior** | **L3** | `owner-config-http.test.ts` (real `POST /orders` → **423**), `kill-switch-enforcement.test.ts` (money/lifecycle switches via real services) | UI proven in Phase 1. `MAINTENANCE_MODE` order-block only round-tripped (shares the proven `assertNotEngaged` seam) — `PARTIAL` |
| Eval PASS → FUNDED exactly once | **L4** | `commerce.test.ts` (concurrent → one funded), golden-path.core50k "6/7" | lineage + cert idempotent. Minor: inherited version/rules asserted non-null, not equal — `PARTIAL` on that sub-claim |
| Failure → FAILED (immutable) → RESET preserves history | **L4** | `rules.integration.test.ts`, `portal-lifecycle.test.ts`, `provisioning.test.ts` | reset at original price, failed life preserved, idempotent |
| Payout qualification (single cycle: 5 days ≥ $150, 90/10 split, cap, debit) | **L4** service (boundaries now L3/L4) | golden-path.core50k "10", `payouts.test.ts`, `payout-boundaries-service.test.ts` (NEW, P3) | Fine boundaries now proven **through the real service + ledger** (was pure-only L1): winning-day inclusive at exactly $150.00 ($149.99 fails, $150.00/$150.01 qualify); 4-vs-5 days; exact-50% ceiling (approve at cap, reject +1 micro); per-size caps 25K=$1,000/50K=$2,000/100K=$3,500/300K=$5,000; Daily buffers 25K=$1,000/50K=$2,000/100K=$4,000 — all asserted against the **canonical @atlas/contracts numbers** |
| **Payout accounting invariant: pre − debit = post; trader + firm = gross (integer micros, no drift)** | **L4** | `payout-boundaries-service.test.ts` (NEW, P3) | 90/10 split; amounts whose 90% is not a whole micro reconcile exactly with the firm absorbing the remainder; verified on the approval result AND the append-only ledger DEBIT row |
| Payout #5 completes account; #6 rejected | **L4** | `payout-daily-progression.test.ts` | status COMPLETED, `MAX_CYCLES_REACHED`. Final cert/totals not asserted — `PARTIAL` |
| Consistency: Select 40% blocks payout but never fails funded | **L4** | `payouts.test.ts` | CONSISTENCY_NOT_MET, status still ACTIVE |
| Consistency: Core >50% pass gate | **L3/L4** | `trading/consistency-gate-engine.test.ts` (NEW, P3) | was **L1** (pure only). Through the REAL engine day-roll: best-day/total > 50% holds the account at **GOAL_REACHED** (delayed, never FAILED); at exactly **50%** (inclusive boundary) it PASSES; profit made on other days restores eligibility; a well-distributed account (<50%) passes cleanly. Threshold read from canonical catalog (CORE evalConsistency 50%). |
| EOD trailing drawdown (Core 50K): intraday-no-ratchet / EOD-ratchet / floor-never-back / ≤ lock | **L3/L4 (real engine) + L4 (post-payout floor)** | `trading/eod-trailing-engine.test.ts` (NEW, P3); pure `@atlas/core/rules/eod-trailing-lock.test.ts`; golden-path "11" | **GAP B1 CLOSED:** real-engine day-roll (`enforceRules` + dated quotes, no sleeps) asserts persisted `drawdownFloorMicros` for an **EOD_TRAILING** account: initial floor 48k, intraday unrealized never ratchets, floor ratchets only at the roll, never moves backward, locks at 50k, **survives a fresh engine (restart)**, and breaches at the floor. |
| Idempotency / concurrency of money paths (funded, adjust, payout, webhook replay, reset, hold) | **L4** | `commerce.test.ts`, `commerce-chaos.test.ts`, `m10-1-money-safety.test.ts`, golden-path "11" | only the external payout rail is mocked (correct seam) |

---

## Owner OS operability (from Phase 1 + Phase 2)
- Owner Console discoverable (portal menu + terminal rail), trader cannot see it, RBAC unchanged — **L4** (Phase-1 browser 11/11).
- Kill-switch engage/release + feature-flag toggle from the console — **L4** (Phase-1 browser round-trip).
- Owner HOLD / kill switch actually affect trading — **L3/L4** (above).
- **Staff management UI — BUILT in Phase 3 (was L0).** `StaffPage` now runs the whole lifecycle from the console: invite (email/role + STAFF step-up), change role, disable/reactivate, revoke sessions, resend/revoke invitations — reusing the proven step-up dialog pattern. UI is L2 (built, typechecked, wired) over **L4-proven endpoints** (`owner-staff-http.test.ts`), with new **RBAC adversarial** coverage (`staff-rbac-adversarial.test.ts`, L4): a valid STAFF step-up never substitutes for the owner-only permission, so no non-owner (not even an ADMIN, on itself) can escalate; last-owner protection and no-self-service-grant remain proven at the domain/route level. Owner-only controls are gated on SUPER_ADMIN in the UI to match the server exactly. Browser walkthrough is the L5 human step (`HUMAN_GOLDEN_PATH.md`).
- **Owner OS backend-only triage (Phase 3, STEP 11/12):** see `OWNER_OS_BACKEND_ONLY_TRIAGE.md`. No LAUNCH-CRITICAL family lacks UI after Staff; remaining backend-only families are POST-LAUNCH/INTERNAL observability & ops-productivity, deliberately not wired now.

## Atlas UX quality
Functionally correct (execution L4, market data real-delayed, risk enforced) but **UX-unacceptable**
per the owner. Measured latency is low (see `ATLAS_PERFORMANCE_BASELINE.md`); the complaint maps to
interaction quality, a rebuild concern, not a data/latency bug. `NEEDS HUMAN UX REVIEW`.

## Chart correctness (STEP 26)
Internal correctness **verified** (OHLC invariants, monotonic timestamps, 1m→5m aggregation parity
for NQ/ES/GC/CL). External raw-vs-provider (Yahoo) parity **UNVERIFIED** (no external reference
available in the headless dev environment). See the Phase-2 report.

## What only a human can confirm (L5 — PENDING HUMAN, all rows)
Every row above is at most L4. Nathan must physically run `HUMAN_GOLDEN_PATH.md` to assign L5. Claude
has not and will not self-certify L5.
