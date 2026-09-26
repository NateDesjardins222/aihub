#!/usr/bin/env bash
#
# Canonical release validation for Happy Trader Funding (Phase 11).
#
# This is the ONE trustworthy pre-release gate. Unlike an ad-hoc `vitest` run, it:
#   1. runs from the repo ROOT, so vitest uses the root config whose include glob is
#      `.test.ts` only — compiled `dist/**/*.test.js` is never collected;
#   2. prepares a deterministic, isolated, SEEDED test database first, so no suite
#      fails merely because the DB was empty;
#   3. runs typecheck, the test suite, and the production build, stopping on the
#      first real failure and reporting an honest aggregate.
#
# It never touches the canonical dev database or any production system. Providers
# stay mock/unconfigured. No real money, no real payout, no live Rithmic.
#
# Usage:  pnpm validate:release
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==================================================================="
echo " Happy Trader Funding — canonical release validation"
echo " commit: $(git rev-parse --short HEAD)   branch: $(git branch --show-current)"
echo "==================================================================="

echo ""
echo ">>> [1/4] Prepare isolated, seeded test database"
bash scripts/prepare-test-db.sh

echo ""
echo ">>> [2/4] Typecheck (all packages)"
pnpm -r typecheck

echo ""
echo ">>> [3/4] Test suite (root config; dist excluded; files serialized)"
export NODE_ENV="${NODE_ENV:-test}"
export JWT_SECRET="${JWT_SECRET:-test-secret-thirty-two-chars-min-abcdef}"
export CORS_ORIGIN="${CORS_ORIGIN:-http://localhost:5173}"
pnpm test

echo ""
echo ">>> [4/4] Production build"
pnpm build

echo ""
echo "==================================================================="
echo " RELEASE VALIDATION PASSED"
echo "==================================================================="
