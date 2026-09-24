# Happy Trader Funding — Economics Simulator V1

An **internal owner tool** for stress-testing the account products. It is a
synthetic what-if model: it never reads or writes production trader/account data
and never influences a live payout. It answers "if we sell N accounts under these
assumptions, what does the P&L of the firm look like, and how much variance and
reserve should we expect?"

## 0. Hard separation from the production engine

| Production payout engine | Economics simulator |
| --- | --- |
| Real deterministic trader/account state | Synthetic assumptions and scenarios |
| Governs real eligibility (later, real money) | Governs nothing; pure projection |
| Reads `accounts`, `daily_account_stats`, ledger | Reads only its own inputs |
| Writes `payout_requests`, `payout_ledger` | Writes only `economics_scenarios` / `economics_runs` (owner-scoped) |

The simulator imports the **pure** eligibility/split/buffer helpers from the
payout engine (so its accounting matches the real machine exactly) but never the
DB-bound services. A simulator assumption can never reach a trader.

## 1. Methodology

A run is a deterministic function of `(assumptions, seed)`. Each of `N` synthetic
purchases is drawn from the assumption distributions and passed through a funnel:

```
purchase → (pass eval?) → funded → (first payout?) → payout events (repeat?) → lifetime value
```

Per purchase the model computes, in integer micro-dollars using the **same**
`splitAccounting()` and buffer helpers as production:

1. **Revenue** = product price − processing% − fraud/chargeback%.
2. **Pass**: Bernoulli(passRate[product]). A non-pass produces revenue and no
   payout liability.
3. **Funded survival**: Bernoulli(fundedSurvival) — funded accounts that never
   reach a first payout (blew the account or churned).
4. **First payout**: Bernoulli(firstPayoutProb) among surviving funded accounts.
5. **Repeat payouts**: a geometric/negative-binomial draw with
   `repeatPayoutProb`, capped by a max cycle count, each payout amount drawn from
   the payout distribution and **clamped to the product's caps** (progressive
   caps honoured) and the min request.
6. **Trader vs firm split**: each payout gross split 90/10 via the production
   helper; the **firm retains the 10% + the account balance adjustment
   economics**; the trader receives 90%. (In the firm's books the payout expense
   is the trader share; the gross leaves the funded-account notional, which is
   simulated firm capital, not revenue.)
7. **Costs**: CAC (as % of revenue or fixed per purchase), platform/data cost,
   support/KYC cost, fixed costs amortized across the run.

Contribution = revenue − trader payouts − processing − fraud − platform/data −
support/KYC − CAC. Contribution margin = contribution / revenue.

Every assumption is surfaced in the run output — **nothing is buried**. A run
records the full assumption set it used so a result is always reproducible from
`(assumptions, seed)`.

## 2. Assumptions (all editable, all shown)

Product mix, account-size mix, purchase prices (default from the locked product
table), pass rate by product, funded survival, first-payout probability, repeat
payout probability, average payout, payout distribution shape, repeat purchase
behaviour, reset behaviour (if supported later), payment processing %,
chargeback/fraud %, market-data/platform cost, support/KYC cost, CAC, fixed
costs, payout caps (per product/version), minimum payout, Daily buffer, Select
consistency behaviour (share of Select traders blocked by consistency).

Defaults are a documented **BASE** scenario; every scenario is a named override
set over BASE.

## 3. Outputs

Per run and per (product × size): purchases, gross revenue, average revenue per
purchase, passes, pass rate, funded accounts, payout recipients, purchase→payout
%, number of payout events, gross trader payouts, firm retained split,
payout/revenue %, processing cost, fraud/chargeback cost, platform/data cost,
support/KYC cost, CAC, contribution dollars, contribution margin. Plus revenue,
payout liability and contribution broken down per product (Core/Select/Daily) and
per account size.

## 4. Scale

Runs at 10,000 / 100,000 / 1,000,000 synthetic purchases. The engine is O(N) with
integer math and a seeded PRNG (mulberry32/xoshiro), so 1M purchases complete in
well under a few seconds server-side. A run streams aggregates, not per-purchase
rows, so memory is O(1) in N (Monte Carlo keeps only per-trial aggregates).

## 5. Stress scenarios

Named scenarios: BASE, GOOD_FOR_FIRM, GOOD_FOR_TRADER, HIGH_PASS_RATE,
HIGH_PAYOUT_RATE, HIGH_REPEAT_PAYOUT, HIGH_CAC, HIGH_FRAUD, DAILY_PAYOUT_STRESS,
SELECT_HIGH_SKILL. Custom scenarios are arbitrary override sets. The tool does not
declare a winner — it shows the economic consequences of each.

### Sensitivity

The tool sweeps a single lever and reports the contribution-margin curve:

- Payout expense × {+10, +20, +30, +40, +50, +75, +100}%.
- Pass rate × the same series.
- CAC ∈ {10, 15, 20, 25, 30}% of revenue.

For each sweep it flags where contribution margin crosses
{30, 25, 20, 15, 10, 5, 0, negative}% — the break-even map the owner needs.

## 6. Monte Carlo

Beyond expected values: a seeded Monte Carlo with `T` trials (reproducible seed).
Each trial redraws the funnel and records aggregates. Reported distributions:
revenue, payout expense, contribution, contribution margin, number of funded
accounts, number of payout recipients — each with mean, median, p5, p25, p75,
p95. This exposes variance and informs reserve requirements: the p95 payout
expense is the tail the firm must be able to cover.

## 7. Payout-cap experiment

At least three configurable schedules compared side by side: CONSERVATIVE,
CURRENT, GENEROUS. Progressive caps are first-class (`[payout#1, payout#2,
payout#3, established]`). The tool shows revenue, payout liability and
contribution under each schedule and **does not auto-pick** — the owner reads the
trade-off. All cap numbers are exposed as assumptions, never hidden constants.

## 8. Reserve model

Illustrative required reserve from: pending approved payouts (from the real
engine's exposure, read-only), expected near-term payouts (from the run's
expected value), the simulated payout distribution (its p95 tail), and a
configurable stress multiplier. Presented as
`reserve ≈ max(pendingApproved, expectedNearTerm) + stressMultiplier × (p95 −
mean) payout expense`. **Not accounting or legal advice** — assumptions visible,
clearly labelled as a planning aid.

## 9. Storage (owner-scoped, separate namespace)

```
economics_scenarios   (saved assumption sets)
  id / organization_id / name / base_scenario / assumptions jsonb / created_by / created_at

economics_runs        (a computed result, reproducible from assumptions+seed)
  id / organization_id / scenario_id / seed / purchases /
  assumptions jsonb (frozen) / results jsonb (aggregates + per-product/size + monte carlo) /
  created_by / created_at
```

These tables carry no foreign keys to trader/account data. A run is a pure
computation cached for the owner; deleting all of them changes nothing in
production.

## 10. Methodology limitations (honest)

- Independence assumption: purchases are drawn i.i.d.; real cohorts correlate
  (marketing pushes, market regimes). The model does not correlate traders.
- Payout distribution is parametric (log-normal-ish clamped to caps), not fit to
  real data yet — there is no real payout history in V1.
- Funded "survival" and "repeat" are single Bernoulli/geometric parameters, not a
  full lifetime model; good enough for stress ranges, not for pricing precision.
- Firm-capital vs revenue accounting: the model treats trader payouts as expense
  and firm split as retained; it does not model the funded-account notional as a
  balance-sheet item beyond the payout it produces.

The point of V1 is ranges and break-even maps under explicit assumptions, not a
single "true" number.
