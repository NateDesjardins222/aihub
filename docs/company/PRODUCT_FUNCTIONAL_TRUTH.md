# PRODUCT FUNCTIONAL TRUTH

**Happy Trader Funding — Product Recovery Phase 1.** What actually works, traced from source.

Baseline: branch `claude/futures-trading-simulator-v8qefu`, from RC1 `dac5fd1`.
Software-only environment: no real money, no production providers, no live Rithmic/Databento.

> **The standard.** A feature is *working* only when the intended human can DISCOVER → REACH →
> UNDERSTAND → USE → SEE THE RESULT → REFRESH → SEE DURABLE STATE (and, for critical features,
> the effect propagates UI → API → domain → DB → downstream enforcement → owner visibility →
> audit). "Route exists / component renders / test passes / Playwright can navigate to it /
> DB row exists / button renders" is **not** proof.

## Status legend
`E2E-VERIFIED` full chain exists and works · `PARTIAL` chain incomplete · `BROKEN` calls a
missing/mismatched route · `UI-ONLY` handler does nothing real · `BACKEND-ONLY` route exists
but no UI reaches it · `PLACEHOLDER` renders, no handler · `NOT-IMPLEMENTED` (may be a
deliberately-gated seam) · `NEEDS HUMAN UX REVIEW` works, quality unacceptable (see
PRODUCT_UX_DEBT.md).

Method: three source-tracing passes (Portal, Atlas, Owner OS), each following every actionable
control from its frontend handler → API call → Fastify route → domain service → DB write →
downstream/audit. Full per-control matrices are in the session scratchpad
(`inv-portal.md`, `inv-atlas.md`, `inv-owner.md`); this document is the synthesized authority.

---

## Headline

**This is a genuinely wired product, not a mock shell.** Across all three surfaces the dominant
failure mode is **omission in the Owner OS** (real backend capabilities with no console UI), not
fakery. No control that is *rendered* anywhere lies about what it does; no money/security/risk
defect was found.

| Surface | Controls traced | E2E-VERIFIED | PARTIAL | BACKEND-ONLY (no UI) | PLACEHOLDER | NOT-IMPL (gated) | UI-ONLY / BROKEN |
|---|---|---|---|---|---|---|---|
| Customer Portal | 61 | 56 | 2 | 1 | 1 | 0 | 0 |
| Atlas terminal | 33 | 33 | 0 | 0 | 0 | 2 | 0 |
| Owner OS | ~60 (24 pages) | ~24 mutating families + 11 read pages | 0 | 12 families | 0 | 0 | 0 |

**P0: none. P1: 3 (all Owner-OS "inaccessible" — 2 repaired this phase, 1 documented).**

---

## 1. Customer Portal (`/portal`)

**E2E-VERIFIED (56):** login/logout/register; dashboard + account cards + switcher; account
detail; **all trader risk controls** (see §4); payouts (eligibility/request/status/methods);
certificate vault + verification; achievements (bulk visibility); support (create/reply);
MFA enroll/challenge/recovery/disable; profile save; account reset; reset/lifecycle actions;
"Trade →" hand-off to Atlas; onboarding/checkout entry. Every one reaches a real route +
domain service + DB write, and success is shown only after the awaited response resolves. No
`alert()`/`console.log`-only/empty-onClick/dead-href control exists in the portal.

**Not fully working (all non-P0):**
- `PARTIAL / P2` — **Framed-certificate order in PRODUCTION** (`CertificatesPage.tsx`): the
  dev/test flow is fully wired, but in production the browser calls a dev-only
  `dev/simulate-payment` route that is gated off, the `.catch()` swallows the 404, and an
  "ordered" success toast still shows while the order stays `PENDING_PAYMENT`. No real merch
  checkout is wired (server TODO). **Contained:** gated behind `MERCH_ENABLED` (off) and only
  in production, which this phase does not touch. Fix belongs to the merch/commerce phase.
- `PARTIAL / P3` — **Billing page**: titled "purchases and resets" but renders only the
  accounts list; no billing-history/receipts route is called. Informational gap, buttons work.
- `PLACEHOLDER / P3` — **Notifications** section in Profile: static text, no controls ("managed
  with the desk").
- `BACKEND-ONLY / P3` — **Per-achievement visibility** (`PATCH …/achievements/:id/visibility`):
  route exists; UI exposes only the bulk toggle.

---

## 2. Atlas trading terminal (`/`, signed in)

**E2E-VERIFIED (33):** account selector; symbol search + timeframes; chart (real
lightweight-charts, history via REST `/marketdata/bars`, live via WS); order ticket
(market/limit/stop/stop-limit); cancel / cancel-all; positions + working-orders panels;
brackets + drag-to-modify + server OCO; flatten / reverse / partial / break-even; P&L +
balance + MLL + risk display; account switching; indicators (real SMA/EMA/RSI, client-side by
design); drawing tools (persisted); WS connection/stale/reconnect (resume-by-seq +
snapshot-on-gap); session/logout/MFA; copy trading (leader fan-out through the same execution
seam); replay controls.

**The five determinations (dev):**
1. **Market data** = REAL exchange-derived, ~10-min **delayed** OHLCV polled from Yahoo
   (`MARKET_DATA_PROVIDER=yahoo-delayed`). Not mock/synthetic/replay. OHLCV + last only (no
   depth). Labelled "SIM/delayed" in the UI.
2. **Order execution** = simulated fill inside the Atlas engine, routed **through** the
   `ExecutionProvider` abstraction (`EXECUTION_PROVIDER=simulation`), written to Postgres in
   one transaction (orders/positions/executions/trades/balance).
3. **Risk enforcement** = server-authoritative both ways: firm lock (`checkOrder`) rejects new
   orders when LOCKED/FAILED (close/liquidation exempt); personal controls enforced on the
   order path (see §4). UI disable is only a secondary hint.
4. **8 instruments** (NQ/MNQ/ES/MES/GC/MGC/CL/MCL) — all wired for market data **and**
   execution.
5. **Performance** = no re-render storm; ticks bypass React to canvas, account updates
   debounced, P&L applied by monotonic server seq. (Owner's lag/feel complaint is UX quality,
   tracked in PRODUCT_UX_DEBT.md — separate from functional correctness.)

**NOT-IMPLEMENTED (deliberately gated seams, off in dev, not broken):** external live market
feed (Databento/Rithmic), external live execution. These are real seams behind env flags.

Atlas functional correctness is high. Its **presentation/interaction quality is owner-rejected**
and tracked as UX debt — status `NEEDS HUMAN UX REVIEW` for the surface as a whole, **not**
BROKEN.

---

## 3. Owner OS (`/admin`, "ATLAS operations")

24 routes. **11 read-only pages** fetch real server data (Command Center, Trading, Risk,
Funding, Economics, Audit, Providers, Reconciliation, etc.) — no fake/hardcoded metrics; the
only simulation labels are honest ("mock (dev/test)", "Tax placeholder", "SIMULATION" until the
server reports external-live).

**~24 mutating control families E2E-VERIFIED:** account lifecycle; user actions; customer ops
(x5); funding decisions; payouts (x7) + payout ops (x5); enforcement (x11); products (x4);
affiliates (x7); support (x16); certificate store (x8) — each reaches a real route + domain
service + audit.

**BACKEND-ONLY (route exists, no UI to reach it) — the real gap:** 12 families. The console is a
read-only dashboard over a fully-capable backend in two areas (Ops System, Staff & Access).
See §5 (repaired) and PRODUCT_RECOVERY_REPORT.md / KNOWN_ISSUES.md for the rest.

**No UI-ONLY / BROKEN / PLACEHOLDER control found** among rendered controls.

---

## 4. Trader risk controls — the chain that usually breaks (it does not here)

**Status: E2E-VERIFIED AND ENFORCED.** Proven by source trace on both halves plus deterministic
engine-integration tests.

- **SAVE:** Portal `ControlsView` → `PUT /api/v1/portal/accounts/:id/controls/:controlType`
  (ownership via `assertOwned`) → `upsertPersonalControl` → writes `traderRiskControls` +
  `traderRiskControlEvents` + `recordAudit('personal_risk.updated')`. Version CAS +
  LOCKED-tighten-only enforced server-side. Persists across refresh (proven).
- **ENFORCE:** `TradingEngine.submitOrder` → `checkPersonalRisk` (engine.ts:1408) →
  `loadPersonalConfig` (reads **the same `traderRiskControls` table** the portal writes) →
  `evaluatePersonalRisk` → `throw OrderRejectedError`. Additive/tighten-only; only the
  exposure-INCREASING portion; never blocks a reduce/flatten/liquidation. Authoritative day
  P&L from ledger columns (`balanceMicros − dayStartBalanceMicros`); equity marked only when
  drawdown is enabled.
- **Automated evidence:** `trading/personal-risk-gate.test.ts` G01–G10 exercises each control on
  the real order path — G07 daily-loss-limit blocks new exposure, G02 max-trades, G03
  max-position (allows reducing), G04 daily-contract, G06 consecutive-loss+cooldown, G09 never
  blocks liquidation, G10 counters persist across a fresh engine (restart). Plus
  `personal-risk.test.ts` (evaluator), `personal-risk.crud.test.ts` (save/lock),
  `copy-personal-risk.test.ts`, `enforcement-core.test.ts`.

Per-control verdicts (all **E2E-VERIFIED**, enforced server-side): DAILY_LOSS_LIMIT,
DAILY_DRAWDOWN, PROFIT_LOCK, MAX_TRADES, MAX_POSITION, DAILY_CONTRACT_LIMIT,
CONSECUTIVE_LOSS_LOCK, COOLDOWN, TRADING_WINDOW, SESSION_RESTRICTION. The value a customer saves
**is** read and enforced by the order engine.

---

## 5. Repaired in Product Recovery Phase 1

| Item | Was | Now |
|---|---|---|
| **Owner Console discoverability** | reachable only by typing `/admin` | role-gated `Owner Console →` in the portal profile menu **and** the terminal app rail; shown iff `role !== 'TRADER'`; trader never sees it; server RBAC unchanged |
| **Customer theme toggle** | broken light/dark toggle | removed cleanly; portal pinned to its dark presentation; dead `theme.ts` deleted |
| **Kill switches (P1, was BACKEND-ONLY)** | read-only table, emergency halt unreachable | inline **Engage/Release** with required reason + `KILL_SWITCH` step-up (reusing the proven reauth pattern); server route/permission/audit unchanged |
| **Feature flags (P1, was BACKEND-ONLY)** | read-only table | inline **Enable/Disable** toggle (permission-gated); server route unchanged |
| **Staff page note** | claimed a non-existent "invite dialog" | honest note: management is API-served, console UI not yet built (read-only) |

## 6. Documented, NOT repaired this phase (Owner OS inaccessible functionality)

`P1` **Staff management UI** (invite / role change / suspend / reactivate / revoke sessions) —
backend `owner-staff.ts` complete + STAFF step-up; needs a console dialog (a build, not a
wiring fix) → Phase 2. `P2` inactivity-sweep, full-system-test, alert ack/resolve, incident
create/transition/assign, impersonation, owner-account adjust/pause. `P3` customer directory/360
tags, finance exports/saved-views/notes/tasks. All are BACKEND-ONLY (route + domain + audit
exist; no console control). None are money/security/risk defects.

## 7. Backend systems worth preserving (do NOT rewrite)
Authoritative product config; lifecycle/state machines; risk engine + personal-risk gate;
payout logic + ledger; execution provider abstraction; market-data provider abstraction;
identity/RBAC + step-up reauth + MFA; enforcement/holds + hash-chained audit; support,
certificates, affiliates, economics backends; account projections + reconciliation. These are
genuinely E2E and correct.

## 8. Frontend surfaces needing later rebuild (see PRODUCT_UX_DEBT.md)
Customer Portal presentation (owner-rejected quality); Atlas interaction/feel/perceived
performance; Owner OS presentation is secondary (evaluate after it is naturally accessible).
