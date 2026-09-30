# State-Machine Fuzzing & Soak Testing

**How the authoritative lifecycle + payout state machine is attacked by
deterministic, seeded generation, and how to run it.** Phase 3 of the engineering
resilience programme. All harness code lives under
`apps/server/src/platform/resilience/`.

## Why this exists

Unit tests prove that a *known* sequence behaves. They cannot prove that *no*
sequence misbehaves. Phase 3 attacks the **combinatorial state space**: can any
sequence of valid, invalid, duplicate, stale, retried, raced or malformed actions
ever drive the authoritative system into an impossible state? The metric is
**state space explored and invariants proven**, not test count — a handful of
seeded generators exploring tens of thousands of transitions is worth more than
hundreds of trivial unit tests.

## The pieces

| File | Role |
| --- | --- |
| `model/prng.ts` | `Prng` (mulberry32) + `fnv1a` — deterministic seeded randomness and hashing. No `Math.random` anywhere in generation. |
| `model/sim.ts` | The lifecycle+payout simulator. Drives the REAL backend domain functions (provision, certify, fund, request/approve/settle/fail payout, provider callbacks) and exposes `check()` (invariant oracle) and `digest()` (normalized authoritative state hash). |
| `model/fuzzer.ts` | The generator: `chooseStep` (seeded, weighted), `applyStep`, `applyMalformed`, `runSeed`, `replaySteps`, and `shrink` (remove-range delta-debug minimization). Entity pools are iterated in **insertion order** so a seed always selects the same logical entity. |
| `state-machine.test.ts` | FAST corpus + determinism proof + shrinker proof + post-corpus integrity. MEDIUM tier behind an env flag. |
| `multi-instance.test.ts` | N independent DB connection pools sharing one Postgres — proves no correctness depends on process-local memory. |
| `soak-trading.test.ts` | Long seeded fill sequences across all 8 instruments; multi-day EOD-trailing drawdown + time soak. |
| `soak-lifecycle.test.ts` | Failed-payout reversal torture (RES-P2-1), terminal-state torture, provisioning idempotency soak. |
| `soak-integrity.test.ts` | Outbox exactly-once / concurrent-disjoint / poison isolation; audit-chain integrity + tamper detection; read-model monotonicity under stale/duplicate events. |

## The invariant oracle

After each meaningful transition the fuzzer runs, as its oracle:

1. **Phase-1 integrity checks** (`integrity-checks.ts`, `runIntegrityChecks`) —
   10 global detectors: active-account cap, paid-cycle cap, duplicate
   funded/reset successor, drawdown floor above HWM, phantom position, payout
   ledger arithmetic, approved-payout-without-debit, failed-payout-debit-not-
   reversed, etc. Any P0/P1 finding is a hard failure.
2. **Phase-2 reconciliation** (`reconcile.ts`, `reconcileAccount`) — position,
   cost basis, realized P&L and fees rebuilt independently from the execution
   history; balance identity; ledger arithmetic. Any drift line is a hard failure.

These are the same detectors the operator CLI (`pnpm integrity:check`) runs, so
the tests and the production audit share one definition of "consistent."

## Determinism

A given seed always produces the same sequence **and** the same authoritative
state digest. This rests on three things: the seeded `Prng`, **insertion-order**
entity pools (never UUID-sorted — UUIDs churn per run), and an **id-normalized**
digest (`sim.digest()` maps ids to insertion-order numbers before hashing). The
`state-machine.test.ts` determinism test runs the same seed twice and asserts an
identical digest. This is what makes a failure **reproducible** and the shrinker
meaningful.

## Shrinking

When a seed reproduces a failure, `shrink(steps, reproduces)` does remove-range
delta debugging to converge on the minimal reproducing subsequence — so a failure
in a 200-step run becomes a 1–3 step counterexample a human can read. Proven by a
synthetic predicate in `state-machine.test.ts`.

## Tiers

| Tier | Seeds × steps | When it runs | How |
| --- | --- | --- | --- |
| **FAST** | 10 seeds × 45 steps, oracle every transition | canonical (`pnpm validate:release`) | default |
| **MEDIUM** | 200 seeds × 200 steps (env-configurable) | on demand | `RESILIENCE_DEEP=1` |
| **DEEP** | same knobs, larger | soak/nightly | `RESILIENCE_DEEP=1 RESILIENCE_SEEDS=… RESILIENCE_STEPS=…` |

Only FAST is in the canonical gate, so the release run stays fast; MEDIUM/DEEP are
opt-in.

## Running it

```bash
# One-time: a running Postgres + a migrated test DB.
bash scripts/prepare-test-db.sh                       # drop + migrate-from-zero + seed

# FAST tier (what canonical runs):
pnpm --filter @atlas/server exec vitest run src/platform/resilience/state-machine.test.ts

# All Phase-3 soak suites:
pnpm --filter @atlas/server exec vitest run src/platform/resilience/

# MEDIUM tier (deep fuzz soak):
RESILIENCE_DEEP=1 RESILIENCE_SEEDS=200 RESILIENCE_STEPS=200 \
  pnpm --filter @atlas/server exec vitest run src/platform/resilience/state-machine.test.ts

# Operator audit (read-only, exits non-zero on any violation):
pnpm integrity:check                 # text report
pnpm integrity:check -- --json       # machine-readable
```

## Reproducing a failure

1. The failing test prints the seed. Re-run `runSeed(db, org, key, <seed>, {...})`
   to reproduce the exact sequence.
2. `shrink` the sequence against a predicate that reproduces the violation to get
   the minimal counterexample.
3. `replaySteps(db, org, key, minimalSteps)` replays just those steps for
   debugging.
4. Fix the **root cause** in production code (never the test), add the minimal
   sequence as a named regression seed in the corpus, and re-run.

## Adding coverage

- New action → add to `ActionName`, `pools`/`WEIGHTS`/`chooseStep`/`applyStep` in
  `fuzzer.ts`, keeping pool iteration in insertion order.
- New invariant → add a detector to `integrity-checks.ts` (global) or a check kind
  to `reconcile.ts` (per-account). Both are automatically picked up by the fuzzer
  oracle and the `integrity:check` CLI.
- New named regression seed → append to `CORPUS` in `state-machine.test.ts`.
