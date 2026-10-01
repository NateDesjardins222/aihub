#!/usr/bin/env bash
#
# PCV-6 determinism harness — the CONCURRENCY proof for the server test suite.
#
# Canonical `pnpm validate:release` runs files serially. This harness instead
# runs the server suite the hard way, repeatedly, to expose any order- or
# race-dependent flake:
#   * file parallelism ON (the opposite of canonical), N worker forks;
#   * per-worker DATABASE ISOLATION (HTF_TEST_ISOLATION=1): globalSetup clones
#     the prepared template into one database per fork, so parallel files never
#     share a database (the PCV-6 root cause);
#   * randomized FILE order (--sequence.shuffle.files) each iteration, so a test
#     that accidentally depends on another running first is caught;
#   * repeated ITER times (default 10) — 10/10 green is the bar;
#   * a final DIRTY/REPEAT-DB iteration that reuses the clones the previous
#     iteration left full of fixtures, proving cleanup is scoped and fixture
#     identity is unique (no reliance on a pristine database).
#
# Each stress iteration reclones from the freshly prepared template, so it is
# also a fresh-DB proof. Exit 0 only if every iteration (and the dirty run)
# passed. No retries, no rerun-to-green: a single failing iteration fails the
# whole harness and stops, so a flake cannot hide.
#
# Usage:  pnpm test:determinism [iterations]      # default 10
#         PCV6_TARGET=apps/server/src/trading pnpm test:determinism 20
set -uo pipefail
cd "$(dirname "$0")/.."

ITER="${1:-10}"
WORKERS="${HTF_TEST_DB_WORKERS:-4}"
TARGET="${PCV6_TARGET:-apps/server}"

export NODE_ENV=test
export JWT_SECRET="${JWT_SECRET:-test-secret-thirty-two-chars-min-abcdef}"
export CORS_ORIGIN="${CORS_ORIGIN:-http://localhost:5173}"
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://atlas:atlas@localhost:5432/atlas_test}"
export DATABASE_URL="$TEST_DATABASE_URL"
export HTF_TEST_ISOLATION=1
export HTF_TEST_DB_WORKERS="$WORKERS"

echo "==================================================================="
echo " PCV-6 determinism harness"
echo " target=$TARGET  iterations=$ITER  workers=$WORKERS  isolation=on  parallel=on"
echo "==================================================================="

echo ""
echo ">>> prepare template database (migrated + seeded)"
bash scripts/prepare-test-db.sh

# $1 = target(s), $2 = shuffle seed. Extra env (HTF_KEEP_CLONES / HTF_SKIP_CLONE)
# is supplied by the caller.
run_suite() {
  node_modules/.bin/vitest run $1 \
    --fileParallelism --maxWorkers="$WORKERS" \
    --sequence.shuffle.files --sequence.seed="$2"
}

fail=0
for i in $(seq 1 "$ITER"); do
  seed=$(( (RANDOM * 32768 + RANDOM) % 1000000 + 1 ))
  echo ""
  echo ">>> determinism iteration $i / $ITER  (shuffle seed $seed, fresh clones)"
  if run_suite "$TARGET" "$seed"; then
    echo "<<< iteration $i: PASS"
  else
    echo "<<< iteration $i: FAIL (seed $seed)"
    fail=1
    break
  fi
done

# Dirty/repeat-DB proof (PCV-6 §22). Scoped to the FIXTURE-BASED collision
# suites, which are designed to be repeat-safe (unique per-fixture identity +
# scoped self-cleanup) and are exactly the surfaces PCV-6 reproduced. It is NOT
# the whole suite on purpose: bootstrap/singleton tests ("create the FIRST owner
# on an empty database", seeded-catalog counts) legitimately require the prepared
# baseline and cannot pass twice on one un-reseeded database by design — they are
# covered by the fresh-clone iterations above and by the twice-consecutive
# canonical validation, which re-prepares each run. The first pass dirties the
# clones and KEEPS them; the second pass reuses the dirtied clones — passing then
# proves no cross-run accumulation (fixtures unique, cleanup scoped).
DIRTY_TARGET="${PCV6_DIRTY_TARGET:-apps/server/src/trading apps/server/src/platform/resilience apps/server/src/http/affiliate-http.test.ts apps/server/src/http/affiliate-security.test.ts apps/server/src/platform/projection-outbox.test.ts}"
if [ "$fail" = "0" ]; then
  echo ""
  echo ">>> dirty/repeat-DB: pass 1/2 — dirty the clones (fresh create, keep)"
  if HTF_KEEP_CLONES=1 run_suite "$DIRTY_TARGET" 424242; then
    echo "<<< dirty/repeat-DB pass 1: PASS (clones now dirty, kept)"
    echo ""
    echo ">>> dirty/repeat-DB: pass 2/2 — REUSE the dirtied clones (the proof)"
    if HTF_SKIP_CLONE=1 run_suite "$DIRTY_TARGET" 424243; then
      echo "<<< dirty/repeat-DB: PASS"
    else
      echo "<<< dirty/repeat-DB: FAIL"
      fail=1
    fi
  else
    echo "<<< dirty/repeat-DB pass 1: FAIL"
    fail=1
  fi
fi

echo ""
echo "==================================================================="
if [ "$fail" = "0" ]; then
  echo " PCV-6 DETERMINISM: ALL $ITER ITERATIONS + DIRTY-DB PASSED"
else
  echo " PCV-6 DETERMINISM: FAILED"
fi
echo "==================================================================="
exit "$fail"
