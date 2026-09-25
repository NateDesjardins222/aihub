# M13.0 — Economics Engine + Business Model Validation — Final Report

**Purpose:** a trustworthy, auditable foundation for deciding whether the CURRENT
Happy Trader business model can withstand real customer behaviour and financial stress.
This is a **scenario/stress-testing engine, not a forecast.** No product rules were
changed. No production side effects.

## Git

- **Starting HEAD:** `9d18553` (design-lab wip, on top of M13 homepage `1d20927` / M12 `b580e12`)
- **Final HEAD:** `70d6df8` — pushed to `origin/claude/futures-trading-simulator-v8qefu`; remote == local.
- Two M13.0 commits: `0cca3ca` (engine + catalog), `70d6df8` (owner view + docs + validation).

## Files added / changed (M13.0)

Added: `packages/contracts/src/product-catalog.ts`; `apps/server/src/platform/economics/`
(`config.ts`, `engine.ts`, `scenarios.ts`, `analysis.ts`, `run.ts`, `serialize.ts`,
`index.ts`, `engine.test.ts`, `serialize.test.ts`); `apps/server/scripts/economics-validate.ts`;
`apps/web/src/admin/pages/EconomicsV2Page.tsx`; `docs/economics/*` (README, MODEL,
ASSUMPTIONS, ACCOUNT_ECONOMICS, PAYOUT_MODEL, AFFILIATE_ECONOMICS, COST_MODEL,
TREASURY_MODEL, SCENARIOS, SENSITIVITY, VALIDATION, LIMITATIONS, this report).

Changed: `packages/contracts/src/index.ts`; `apps/web/src/marketing/catalog.ts`
(now re-exports the shared catalog); `apps/server/scripts/seed-htf-products.ts`
(consumes the shared payout params); `apps/server/src/platform/payout-core.ts` +
`payouts.ts` (`MAX_PAYOUT_CYCLES` moved to the pure module); `apps/server/src/http/routes/payouts.ts`
(v2 routes); `apps/web/src/admin/AdminApp.tsx`, `api.ts`, `types.ts`; `apps/server/package.json`.

## Migrations

None. Persistence reuses the existing immutable, insert-only `economics_runs` table
(v2 runs store the full bundle in `results` with a `version: "M13_V2"` marker;
`purchases` holds the customer count). No schema change was required; a migration was
deliberately avoided since it could not be exercised without a database in this
environment.

## Authoritative data sources (Category A — reused, never duplicated)

- Product catalog (CORE/SELECT/DAILY, prices, targets, drawdowns, contract limits,
  buffers, split, activation) → `@atlas/contracts/product-catalog.ts` (new single
  source; web + server + seed all read it).
- Payout maths (`splitAccounting`, `MICROS`, `MAX_PAYOUT_CYCLES`, caps, min, winning
  days) → `apps/server/src/platform/payout-core.ts` / `payouts.ts`.
- Firm limits → `account-limit.ts` (`MAX_ACTIVE_ACCOUNTS = 5`).

## Assumption model (Category B — explicit, editable, versioned)

`config.ts defaultAssumptions()` + named scenarios. Funnel (pass/reset/repurchase/
survival/payout), refunds, chargebacks, processing (%+fixed), operating cost lines,
CAC, affiliate penetration/rate/maturity, treasury coverage & reserves, growth timing.
Every value is labelled and never presented as historical data. Payment-processing fees
are modelled as assumptions because **no processing fee exists in production config**.

## What the engine does

Deterministic seeded (`mulberry32`) simulation of the full customer lifecycle over a
time horizon: arrival (4 patterns) → purchase → evaluation (pass/fail →
reset/repurchase/churn) → funded performance → payout lifecycle (eligible → approved →
paid, via the real 90/10 split) → affiliate commissions (created → matured → paid,
reversed/canceled on refund/chargeback) → refunds vs chargebacks (separate) →
processing, operating, CAC. Outputs: revenue streams, payout liability, affiliate
lifecycle, a monthly **cash timeline** with reserve requirement and distributable cash,
a **treasury** view, **product economics**, **break-even**, **sensitivity**, seeded
**Monte-Carlo** distributions (p10…p90 with an explicit worse-tail), and **scenario
comparison**. CSV/JSON exports. Owner OS page "Economics (M13)", owner-only.

## Test / typecheck / build results

- Economics + payout-core tests: **59 passed** (`engine.test.ts` 24, `serialize.test.ts`
  11, plus payout-core/economics-sim regression). Web marketing: **14 passed**.
- Server typecheck: **clean.** Web typecheck: **clean.**
- Server build: **clean.** Web production build: **clean.**
- `pnpm --filter @atlas/server economics:validate`: runs 100/1k/5k/10k + PAYOUT_STRESS +
  COMBINED_DOWNSIDE (see numbers below).

## Validation runs (architecture checks — NOT predictions)

| Run | Net revenue | Trader payout | Contribution (margin) | Distributable | P(neg)/P(liq) |
|-----|-------------|---------------|-----------------------|---------------|---------------|
| BASE 100c / 90d | $26,089 | $10,338 | **-$15,858 (-60.8%)** | -$40,598 | 100% / 100% |
| BASE 1,000c / 90d | $250,434 | $56,413 | $131,032 (52.3%) | $75,461 | 0% / 0% |
| BASE 5,000c / 180d | $1,268,489 | $295,557 | $744,784 (58.7%) | $515,002 | 0% / 0% |
| BASE 10,000c / 365d | $2,581,987 | $635,371 | $1,475,874 (57.2%) | $1,027,232 | 0% / 0% |
| PAYOUT_STRESS 5k/180d | $1,258,280 | **$2,886,923** | **-$1,860,806 (-147.9%)** | -$1,441,969 | 100% / 100% |
| COMBINED_DOWNSIDE 5k/180d | $952,493 | $1,796,462 | **-$1,232,313 (-129.4%)** | -$1,077,103 | 100% / 100% |

## Economic risks discovered (by the model, under assumptions)

1. **Fixed-cost drag at low volume.** At 100 customers the modeled contribution is
   sharply negative — fixed operating costs are not covered until volume grows. Early-
   stage runway must fund this.
2. **Payout tail risk is existential under stress.** If funded traders perform far
   better than the BASE assumptions (PAYOUT_STRESS / COMBINED_DOWNSIDE), trader payouts
   exceed revenue and contribution goes deeply negative — payouts are a genuine, uncapped-
   at-the-firm-level liability that the reserve model must cover. This is a **finding to
   surface, not a reason to change product rules.**
3. **Liquidity timing.** Because payouts, affiliate maturity and refunds lag purchases,
   a rapid inflow (VIRAL_GROWTH / SPIKE) can create a monthly liquidity trough even when
   annual economics are positive; the cash timeline flags months where distributable
   cash goes negative.

## Existing-system bug discovered

The public marketing catalog models drawdowns as **EOD trailing** (SELECT at 5% of
size), while the DB seed `seed-htf-products.ts evalRules` computes a **STATIC 4%**
drawdown for every family. They disagree on drawdown type and SELECT's drawdown amount.
**Reported, not changed** (product-rule reconciliation is an owner decision). It does not
affect the economics model (evaluation pass rate is an input). Prices, 90/10 split,
activation, caps, buffers and winning-days are consistent and now sourced once from the
shared catalog.

## Limitations

See `LIMITATIONS.md`. In brief: not a forecast; evaluation pass/fail and payout size are
assumptions rather than trade-level simulations; reserve model is illustrative; DAILY
progression / SELECT consistency are represented through inputs; DB persistence path is
correct-by-construction but was not exercised live (no database in this environment).
Clean calibration seams exist to swap assumptions for observed distributions later.
