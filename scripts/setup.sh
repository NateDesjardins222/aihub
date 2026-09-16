#!/usr/bin/env bash
#
# Atlas Futures Terminal — one-command local setup.
#
# Creates the database, applies migrations, seeds the demo trader and prop
# products, and leaves you ready to run `pnpm dev`. Safe to re-run.
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

bold "Atlas Futures Terminal — setup"
echo

# ---------------------------------------------------------------- toolchain --
bold "1. Toolchain"

command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 22 or newer."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node $(node -v) found, but 22 or newer is required."
ok "Node $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm not found; enabling it through corepack"
  corepack enable >/dev/null 2>&1 || die "Could not enable pnpm. Run: npm i -g pnpm"
fi
ok "pnpm $(pnpm --version)"

# ----------------------------------------------------------------- database --
echo
bold "2. PostgreSQL"

DB_NAME="${ATLAS_DB_NAME:-atlas}"
DB_USER="${ATLAS_DB_USER:-atlas}"
DB_PASS="${ATLAS_DB_PASS:-atlas}"
DB_HOST="${ATLAS_DB_HOST:-localhost}"
DB_PORT="${ATLAS_DB_PORT:-5432}"
DATABASE_URL="postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

command -v psql >/dev/null 2>&1 || die "psql not found. Install PostgreSQL 14+, or run: docker compose up -d db"

# psql prompts for a password on stdin when it cannot authenticate, which makes
# a probe hang forever rather than fail. -w forbids the prompt so an unusable
# account is rejected immediately, and a connect timeout stops a wedged server
# doing the same thing.
export PGCONNECT_TIMEOUT=5
PSQL_PROBE=(psql -w -v ON_ERROR_STOP=1)

if ! pg_isready -h "$DB_HOST" -p "$DB_PORT" >/dev/null 2>&1; then
  die "No PostgreSQL server at ${DB_HOST}:${DB_PORT}.
     Start it, or run:  docker compose up -d db"
fi
ok "PostgreSQL reachable at ${DB_HOST}:${DB_PORT}"

# Find an account that can create roles. Linux packages use the `postgres`
# superuser; Homebrew on macOS makes your own login the superuser.
ADMIN=""
# $USER is not always exported (minimal shells, CI, some containers), and this
# script runs under `set -u`, so it must be dereferenced defensively.
for candidate in "${USER:-}" "${LOGNAME:-}" postgres; do
  [ -n "$candidate" ] || continue
  if "${PSQL_PROBE[@]}" -h "$DB_HOST" -p "$DB_PORT" -U "$candidate" -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    ADMIN="$candidate"
    break
  fi
done

if [ -z "$ADMIN" ] && command -v sudo >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
  if sudo -n -u postgres psql -w -tAc 'select 1' >/dev/null 2>&1; then ADMIN="sudo:postgres"; fi
fi

run_admin() {
  if [ "$ADMIN" = "sudo:postgres" ]; then
    sudo -n -u postgres psql -w -v ON_ERROR_STOP=1 -tAc "$1"
  else
    "${PSQL_PROBE[@]}" -h "$DB_HOST" -p "$DB_PORT" -U "$ADMIN" -d postgres -tAc "$1"
  fi
}

if [ -z "$ADMIN" ]; then
  warn "No superuser account found; skipping role and database creation."
  warn "Create them yourself, then re-run:"
  warn "  CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';"
  warn "  CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
else
  ok "administering as ${ADMIN}"
  if [ "$(run_admin "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'")" != "1" ]; then
    run_admin "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}'" >/dev/null
    ok "created role ${DB_USER}"
  else
    ok "role ${DB_USER} already exists"
  fi
  if [ "$(run_admin "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")" != "1" ]; then
    run_admin "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}" >/dev/null
    ok "created database ${DB_NAME}"
  else
    ok "database ${DB_NAME} already exists"
  fi
fi

PGPASSWORD="$DB_PASS" "${PSQL_PROBE[@]}" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc 'select 1' >/dev/null 2>&1 \
  || die "Cannot connect as ${DB_USER}. Check your PostgreSQL authentication settings."
ok "connected as ${DB_USER}"

# ---------------------------------------------------------------------- env --
echo
bold "3. Environment"

if [ -f .env ]; then
  ok ".env already present, leaving it alone"
else
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
  cat > .env <<ENV
NODE_ENV=development
PORT=4000
DATABASE_URL=${DATABASE_URL}

# Signing secret for access tokens. Generated for this machine.
JWT_SECRET=${SECRET}

# Market data. The Phase 1 provider is real exchange-derived OHLCV delayed
# roughly ten minutes. It is DEVELOPMENT ONLY and is never presented as
# real-time. See docs/milestones/M2-REPORT.md.
MARKET_DATA_PROVIDER=yahoo-delayed
MARKET_DATA_POLL_MS=5000
MARKET_DATA_STALE_MS=120000
ENV
  ok "wrote .env with a freshly generated JWT secret"
fi
cp -f .env apps/server/.env
ok "linked apps/server/.env"

# ------------------------------------------------------------------ install --
echo
bold "4. Dependencies"
pnpm install --silent
ok "workspace installed"

# ------------------------------------------------------------------ migrate --
echo
bold "5. Database schema and seed data"
DATABASE_URL="$DATABASE_URL" pnpm --filter @atlas/server db:migrate
DATABASE_URL="$DATABASE_URL" pnpm --filter @atlas/server db:seed

# --------------------------------------------------------------------- done --
echo
bold "Ready."
cat <<'DONE'

  Start the terminal:

      pnpm dev

  Then open  http://localhost:5173

      email     demo@atlasfutures.local
      password  atlas-demo-2026

  Market data is real, exchange-derived, and delayed about ten minutes.
  Everything else is simulated. No order is routed anywhere.

DONE
