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

run_suite() {
  node_modules/.bin/vitest run "$TARGET" \
    --fileParallelism --maxWorkers="$WORKERS" \
    --sequence.shuffle.files --sequence.seed="$1"
}

fail=0
for i in $(seq 1 "$ITER"); do
  seed=$(( (RANDOM * 32768 + RANDOM) % 1000000 + 1 ))
  echo ""
  echo ">>> determinism iteration $i / $ITER  (shuffle seed $seed, fresh clones)"
  if run_suite "$seed"; then
    echo "<<< iteration $i: PASS"
  else
    echo "<<< iteration $i: FAIL (seed $seed)"
    fail=1
    break
  fi
done

if [ "$fail" = "0" ]; then
  echo ""
  echo ">>> dirty/repeat-DB iteration (reuse the clones the last run dirtied)"
  if HTF_SKIP_CLONE=1 run_suite 424242; then
    echo "<<< dirty/repeat-DB: PASS"
  else
    echo "<<< dirty/repeat-DB: FAIL"
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
