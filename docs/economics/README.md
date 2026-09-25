# Happy Trader Funding — Economics Engine (M13.0)

A deterministic, auditable **business-economics simulation** for stress-testing the
CURRENT Happy Trader account products under configurable operating assumptions.

> This is a **scenario / stress-testing engine, NOT a forecast**. Happy Trader has
> not launched at meaningful production scale, so trader behaviour, costs and growth
> are modelled as explicit ASSUMPTIONS — never presented as historical operating data.
> The engine never touches production data and has no production side effects.

## What question it answers

> "If Happy Trader operates at scale under its current account rules, what happens
> financially — across revenue, payout liability, affiliate cost, refunds/chargebacks,
> operating cost, acquisition, cash timing and required reserves?"

## Where it lives

- Engine (pure, server): `apps/server/src/platform/economics/`
  - `config.ts` — Category A (authoritative) loader + Category B (assumptions) + versions
  - `engine.ts` — the deterministic lifecycle + time/cash-flow simulation
  - `scenarios.ts` — named stress scenarios
  - `analysis.ts` — break-even, sensitivity sweeps, seeded Monte Carlo
  - `run.ts` — composes a full auditable run bundle
  - `serialize.ts` — CSV / JSON export
- Authoritative catalog (shared): `packages/contracts/src/product-catalog.ts`
- HTTP (owner-only): `apps/server/src/http/routes/payouts.ts` → `/api/v1/admin/economics/v2/*`
- Owner OS view: `apps/web/src/admin/pages/EconomicsV2Page.tsx` (nav: "Economics (M13)")
- Persistence: `economics_runs` table (immutable, insert-only)

## The two categories of numbers

| Category | Meaning | Source |
|----------|---------|--------|
| **A — Authoritative** | Real product/payout parameters (prices, targets, drawdowns, caps, 90/10 split, activation, winning days, cycles, active-account limit) | `@atlas/contracts` product-catalog + `payout-core.ts` + `payouts.ts` / `account-limit.ts`. Never a second copy. |
| **B — Assumptions** | Trader behaviour, costs, refunds/chargebacks, processing, affiliate penetration, CAC, growth, reserves | `config.ts` `defaultAssumptions()` + named scenarios. Explicit, labelled, editable, versioned. |

See `ASSUMPTIONS.md` for the full split and `MODEL.md` for the mechanics.

## Determinism & audit

Every run is a pure function of `(assumptions, seed, customers, horizonDays)`. The same
inputs always produce the same output. A persisted run freezes its assumptions, seed,
engine version and full result, so it is reproducible and auditable forever
(`VALIDATION.md`).

## Documents

- `MODEL.md` — engine mechanics, lifecycle, time/cash-flow model
- `ASSUMPTIONS.md` — Category A vs B, every assumption and its default
- `ACCOUNT_ECONOMICS.md` — product segmentation & unit economics
- `PAYOUT_MODEL.md` — payout lifecycle, 90/10 split, caps, cycles
- `AFFILIATE_ECONOMICS.md` — commission lifecycle, maturity, reversals
- `COST_MODEL.md` — processing, operating, CAC
- `TREASURY_MODEL.md` — reserves & distributable cash
- `SCENARIOS.md` — named stress scenarios
- `SENSITIVITY.md` — sensitivity, break-even, Monte-Carlo percentile convention
- `VALIDATION.md` — how it is tested + validation runs
- `LIMITATIONS.md` — what this is NOT, and calibration seams
