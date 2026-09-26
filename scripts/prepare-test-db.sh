#!/usr/bin/env bash
#
# Prepare a deterministic, isolated, seeded PostgreSQL database for the test suite.
#
# Phase 10 produced 105 misleading test failures because the suite was run with the
# wrong working directory (compiled dist/*.test.js got collected) against a
# migrated-but-UNSEEDED database. This script removes both variables: it drops and
# recreates a dedicated test database, applies every migration from zero, and seeds
# the canonical catalog + demo fixtures — so `vitest run` starts from a known state.
#
# It NEVER touches the canonical development database (atlas) or any production DB.
# The target is taken from TEST_DATABASE_URL, or defaults to the local atlas_test.
#
# Usage:  ./scripts/prepare-test-db.sh
set -euo pipefail

TEST_URL="${TEST_DATABASE_URL:-postgres://atlas:atlas@localhost:5432/atlas_test}"

# Parse the database name out of the URL (last path segment, minus any query).
DB_NAME="$(printf '%s' "$TEST_URL" | sed -E 's#.*/([^/?]+).*#\1#')"
ADMIN_URL="$(printf '%s' "$TEST_URL" | sed -E "s#/${DB_NAME}([?].*)?\$#/postgres#")"

if [ "$DB_NAME" = "atlas" ]; then
  echo "REFUSING: TEST_DATABASE_URL points at the canonical dev database 'atlas'." >&2
  exit 1
fi

echo "[prepare-test-db] target database: $DB_NAME"
echo "[prepare-test-db] dropping and recreating (isolated, safe)…"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE);" >/dev/null
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null

export DATABASE_URL="$TEST_URL"
export TEST_DATABASE_URL="$TEST_URL"
export NODE_ENV="${NODE_ENV:-test}"
export JWT_SECRET="${JWT_SECRET:-test-secret-thirty-two-chars-min-abcdef}"
export CORS_ORIGIN="${CORS_ORIGIN:-http://localhost:5173}"

echo "[prepare-test-db] applying migrations from zero…"
pnpm --filter @atlas/server db:migrate

echo "[prepare-test-db] seeding canonical catalog + demo fixtures…"
pnpm --filter @atlas/server db:seed

echo "[prepare-test-db] ready: $DB_NAME migrated + seeded."
