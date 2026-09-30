#!/usr/bin/env bash
#
# Security Phase 1 — coherent security regression command.
#
# Composes the authorization / authentication / IDOR / webhook / injection-boundary
# / secret / property security suites into one gate. It runs ONLY the project's own
# deterministic tests against the isolated local test DB — it performs NO invasive
# external scanning, touches no real provider, moves no real money.
#
#   pnpm security:check
#
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==================================================================="
echo " Happy Trader Funding — security:check"
echo " commit: $(git rev-parse --short HEAD)   branch: $(git branch --show-current)"
echo "==================================================================="

echo ""
echo ">>> [1/2] Prepare isolated, seeded test database"
bash scripts/prepare-test-db.sh

echo ""
echo ">>> [2/2] Security suites (authz / auth / IDOR / webhook / secret / property)"
pnpm --filter @atlas/server exec vitest run \
  src/http/security.test.ts \
  src/http/security-phase1.test.ts \
  src/http/authz-security.test.ts \
  src/http/m10-1-rbac-redteam.test.ts \
  src/http/staff-rbac-adversarial.test.ts \
  src/http/trading-authz-http.test.ts \
  src/http/owner-authz-http.test.ts \
  src/http/enforcement-authz.test.ts \
  src/http/affiliate-security.test.ts \
  src/http/replay-controls.test.ts \
  src/http/routes/self-serve-boundary.test.ts \
  src/http/routes/certificate-security.routes.test.ts \
  src/http/routes/payouts.routes.test.ts \
  src/http/routes/copy.routes.test.ts \
  src/http/routes/customers.routes.test.ts \
  src/ws/ws-security.test.ts \
  src/platform/kill-switch-enforcement.test.ts

echo ""
echo "==================================================================="
echo " SECURITY CHECK PASSED"
echo "==================================================================="
