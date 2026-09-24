# Happy Trader Funding — Payout Engine V1 + Economics Simulator: completion report

The financial brain of Happy Trader Funding, built and proven before any real
money is connected to it. **No real money moves; no payout provider, bank, KYC
vendor, Whop or Databento is wired.** Everything reuses the existing
authoritative systems rather than forking a parallel source of truth.

## Files changed

**Design docs**
- `docs/payout-engine-v1.md` — the contract: schema, state machine, reason-code
  enum, Core/Select/Daily eligibility, 90% split + Daily-buffer accounting,
  idempotency model, ledger, audit seam, owner workflows, exposure, immutable
  versioning.
- `docs/economics-simulator-v1.md` — methodology, assumptions, outputs, stress +
  sensitivity, Monte Carlo, cap experiment, reserve, limitations.

**Backend (server)**
- `apps/server/src/platform/payout-core.ts` — pure eligibility + accounting (no
  DB): `PayoutPolicy`, the split, withdrawable, progressive caps, winning-day
  counting, consistency, `evaluatePayoutEligibility`, `resolvePayoutRequest`.
- `apps/server/src/platform/payouts.ts` — the production service: state machine,
  the one-time balance debit at APPROVED, the append-only ledger, idempotency +
  CAS under the account advisory lock, cycle management, audit + events.
- `apps/server/src/platform/payout-queries.ts` — owner queue, the payout case,
  firm exposure (three distinct numbers).
- `apps/server/src/platform/economics-sim.ts` — the seeded simulator: funnel,
  sensitivity, Monte Carlo, cap experiment, reserve, scenarios.
- `apps/server/src/http/routes/payouts.ts` — trader + owner + economics routes.
- `apps/server/src/db/schema.ts` — `payout_requests`, `payout_ledger`,
  `payout_cycles`, `economics_scenarios`, `economics_runs`.
- `apps/server/src/platform/audit.ts` (+`PAYOUT` subject),
  `apps/server/src/platform/events.ts` (+`payout.*` event types),
  `apps/server/src/http/app.ts` (route registration).
- `apps/server/scripts/seed-htf-payout.ts` — an eligible HTF funded account for
  browser acceptance.

**Frontend (web)**
- `apps/web/src/admin/pages/PayoutsPage.tsx` — owner control center (queue,
  exposure, payout case, actions).
- `apps/web/src/admin/pages/EconomicsPage.tsx` — the economics simulator UI.
- `apps/web/src/panels/PayoutSurface.tsx` (+`.css`) — the trader payout drawer.
- `apps/web/src/admin/{api,types}.ts`, `AdminApp.tsx`, `AppRail.tsx`,
  `TerminalShell.tsx`, `state/workspace.ts`, `ui/Icon.tsx` — wiring.

## Migration

`apps/server/drizzle/0017_payouts.sql` (journal entry 17), applied to the dev and
test databases. Additive and non-destructive. `payout_ledger` is append-only,
enforced by a trigger; `UNIQUE (payout_request_id, entry_type)` makes the balance
debit and a future settlement structurally at-most-once. Money is bigint micros.

## New endpoints

Trader (`/api/v1`): `GET /payouts/eligibility/:accountId`, `POST /payouts/requests`.
Owner (`/api/v1/admin`): `GET /payouts`, `GET /payouts/:id`, `GET /payouts/exposure`,
`POST /payouts/:id/{approve,reject,hold,remove-hold,cancel,process,pay}`,
`GET /economics/scenarios`, `POST /economics/run`, `GET /economics/runs`.
RBAC: SUPPORT reads, ADMIN acts (reason required for sensitive actions),
SUPER_ADMIN runs the simulator; traders act only on accounts they own.

## New admin screens

**Payouts** — firm-exposure banner (paid today/7d/30d/all, requested liability,
approved-unpaid, eligible ceiling, kept distinct), a state-tabbed queue, and the
full payout case (live eligibility recompute, ledger, audit) with the state
machine's actions. **Economics** — pick a scenario/scale/seed/trials, run, and
read headline economics, per product & size, the cap experiment, the sensitivity
curve, the Monte-Carlo distribution, an illustrative reserve, and the full
assumption set. A trader **Payouts** drawer in the terminal shows eligibility and
the exact reasons, and takes a bounded request.

## Tests

- **Payout eligibility/accounting (pure)** — `payout-core.test.ts` 15/15:
  split reconciliation at every amount, per-cycle winning-day reset, Select
  consistency block-not-fail, the Daily buffer worked example, min/max bounds,
  holds as reasons.
- **Property / randomized** — `payout-core.property.test.ts` 2/2 over 8,000
  random draws: trader+firm always reconciles to the gross; withdrawable never
  negative and never into the buffer; a resolved payout always within bounds and
  leaving balance ≥ starting+buffer; a rejection is a reason, never money.
- **Service (real DB)** — `payouts.test.ts` 10/10: exact-once debit, duplicate
  approval no-op, **two simultaneous approvals debit once (concurrency)**,
  duplicate request key returns the same row, rejected/ineligible never touch the
  balance, the Daily buffer, Select consistency, processing→paid settlement,
  illegal transitions refused.
- **HTTP routes / RBAC / tenant / IDOR** — `payouts.routes.test.ts` 4/4: a trader
  acts only on their own account (foreign account 404), a trader cannot read the
  owner queue, SUPPORT cannot approve, ADMIN can, approval without a reason is
  refused, exposure reflects the liability.
- **Economics** — `economics-sim.test.ts` 10/10: PRNG determinism, run
  reproducibility, accounting reconciliation, funnel invariants, the 10K/100K/1M
  scale run, every scenario, monotone sensitivity, ordered Monte-Carlo
  percentiles, cap ordering, the reserve formula.
- **Browser acceptance** — `payout-acceptance.spec.mjs` 10/10 in the real
  browser: trader eligibility → bounded request; owner queue → exposure → case →
  approve; the account balance falls from $53,000 to $52,000 (debited once), no
  console errors.

## Simulation results (BASE scenario, seed 2026)

| Purchases | Revenue | Pass | Funded | Payout recipients | Trader payouts | Payout/rev | Contribution | Margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10,000 | $1.90M | 11.1% | 1,113 | 230 | $0.56M | 29.2% | $0.78M | 41.1% |
| 100,000 | $19.10M | 11.3% | 11,271 | 2,249 | $5.79M | 30.3% | $7.64M | 40.0% |
| 1,000,000 | $191.6M | 11.3% | 112,978 | 22,725 | $60.5M | 31.6% | $74.3M | 38.8% |

1M purchases simulate in ~70ms; every run reconciles
`contribution = revenue − trader payouts − costs`.

### Stress scenarios (30K purchases, margin · payout/rev)

BASE 38.2% · 32.1% | GOOD_FOR_FIRM 57.0% · 21.3% | GOOD_FOR_TRADER −162.7% ·
233.0% | HIGH_PASS_RATE −88.0% · 158.3% | HIGH_PAYOUT_RATE −77.0% · 147.3% |
HIGH_REPEAT_PAYOUT −99.8% · 170.1% | HIGH_CAC −40.9% · 96.2% | HIGH_FRAUD −31.9%
· 96.2% | DAILY_PAYOUT_STRESS −73.1% · 143.4% | SELECT_HIGH_SKILL −60.1% · 130.4%.

Sensitivity: at BASE, doubling payout expense drives the margin from ~+38% to
~−125% — the tool flags where each lever crosses zero. The owner reads the map;
the tool never picks a "best".

### Payout-cap experiment (100K purchases, trader payouts)

Conservative $3.80M · Current $6.10M · Generous (progressive) $7.61M. No winner
is chosen automatically — the economic consequence of each schedule is shown.

### Monte Carlo (40 trials × 20K purchases)

Contribution mean ~$1.49M, p5 ~$1.39M, p95 ~$1.61M — a tight band at BASE; the
p95 payout-expense tail feeds the illustrative reserve.

## Known limitations (honest)

- No real payout provider/bank/KYC; PROCESSING and PAID are operator/mock
  transitions. This is deliberate for V1.
- Select/Daily payout caps are working defaults pending simulation; only Core's
  caps were commercially locked. All caps are product-version configuration.
- The simulator draws purchases i.i.d. and uses parametric payout draws (no real
  payout history exists yet); it is a ranges-and-break-even tool, not pricing
  precision. Reserve output is a planning aid, not accounting or legal advice.
- A funded withdrawal debits the balance and shifts the day-start anchors so it
  is never mistaken for a losing day or a drawdown breach; funded products are
  assumed to use a locked/static drawdown so a profit withdrawal above the buffer
  never breaches (documented in the engine).

## Not claimed

This is **not** real-money payout readiness. It is the deterministic financial
brain — eligibility, state, accounting, idempotency, audit, owner control, and an
economics model — built and proven so real money can later be connected to a
system that already knows exactly what it owes and why.
