# VALIDATION

## Determinism & auditability

- `simulate` / `runEconomics` are pure functions of their inputs; same inputs → byte-
  identical result (asserted in tests).
- A persisted run (`economics_runs`, insert-only) freezes: scenario, seed, customers,
  horizon, the full assumptions, the engine & model version, and the complete result
  bundle. Re-running with the stored `(assumptions, seed, customers, horizonDays)`
  reproduces it exactly. Runs are never mutated.

## Tests (`apps/server/src/platform/economics/*.test.ts`)

Deterministic, DB-free:

- **Determinism** — same inputs identical; different seed differs.
- **Reconciliation** — gross = initial+reset+repurchase; net = gross − refunds −
  chargebacks; contribution = its components; per-product sums = aggregate; timeline
  cumulative = Σ net; paid trader cash = paidTraderShare; 90/10 split reconciles.
- **Invariants** — no negative counts/expenses; funnel ordering (passes ≤ purchases,
  funded = passes, recipients ≤ funded, paid ≤ approved ≤ requested); paid + liability ≤
  total trader expense; affiliate net = gross − canceled − reversed and 0 ≤ net ≤ gross;
  reserve components non-negative and sum to the requirement.
- **Edge cases** — zero customers; zero pass; full pass; zero payout; high refund; high
  chargeback.
- **Scenarios / sensitivity / break-even / Monte Carlo** — all run and reconcile;
  PAYOUT_STRESS pays out more than BASE; monotone sensitivity; ordered MC percentiles.
- **Bundle** — `runEconomics` is complete and reproducible; safety reserve folded in.
- **Scale** — 100 / 1,000 / 5,000 / 10,000 customers over 30–365 days, well within a
  few ms each; emits the report numbers below.
- **Serialize** — CSV/JSON exports are well-formed and reconcile to the run.
- **Catalog** — the shared catalog has 10 products, 90% split, $0 activation, caps and
  the $250 minimum (guards against divergence).

## Validation runs (architecture checks — NOT predictions)

`pnpm --filter @atlas/server exec tsx scripts/economics-validate.ts` runs and prints:
100c/90d, 1,000c/90d, 5,000c/180d, 10,000c/365d, plus PAYOUT_STRESS and
COMBINED_DOWNSIDE at 5,000c/180d. These exercise the engine at scale and under stress;
their numbers are model-validation output, not forecasts.

## Environment note

This milestone was validated in an environment **without a PostgreSQL instance**. The
engine and all its tests are pure and run fully (green). The DB-backed persistence route
(`/admin/economics/v2/run` insert into `economics_runs`) is correct-by-construction and
reuses the existing, working v1 persistence pattern (same table, same insert shape), but
its live insert path was not executed here; it is exercised wherever the app runs with a
database. Typecheck and production builds pass for both server and web.
