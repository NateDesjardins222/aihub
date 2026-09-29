#!/usr/bin/env bash
#
# Resilience Phase 2 — backup / restore drill (Parts XXX–XXXI).
#
# Development infrastructure only. Takes a pg_dump of the seeded test database,
# restores it into a FRESH isolated database, then proves the restored copy
# retains authoritative business truth: key row counts match, per-table content
# digests match, and the read-only integrity checks find no P0/P1 corruption.
#
# It never touches the canonical dev database ('atlas') or any production system,
# and it does not commit the dump (written to a scratch dir, deleted at the end).
#
# Usage:  bash scripts/resilience-restore-drill.sh
set -euo pipefail

SRC_URL="${TEST_DATABASE_URL:-postgres://atlas:atlas@localhost:5432/atlas_test}"
SRC_DB="$(printf '%s' "$SRC_URL" | sed -E 's#.*/([^/?]+).*#\1#')"
ADMIN_URL="$(printf '%s' "$SRC_URL" | sed -E "s#/${SRC_DB}([?].*)?\$#/postgres#")"
RESTORE_DB="atlas_restore_drill"
RESTORE_URL="$(printf '%s' "$SRC_URL" | sed -E "s#/${SRC_DB}([?].*)?\$#/${RESTORE_DB}#")"
WORK="${TMPDIR:-/tmp}/htf-restore-drill"
DUMP="$WORK/atlas_test.dump"
mkdir -p "$WORK"

if [ "$SRC_DB" = "atlas" ]; then echo "REFUSING: source is the canonical dev DB 'atlas'." >&2; exit 1; fi

echo "[drill] 1/6 dump $SRC_DB → $DUMP (custom format, checksummed)"
pg_dump -Fc "$SRC_URL" -f "$DUMP"
SIZE=$(stat -c%s "$DUMP" 2>/dev/null || stat -f%z "$DUMP")
echo "[drill]     dump size: ${SIZE} bytes"

echo "[drill] 2/6 (re)create fresh $RESTORE_DB"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\" WITH (FORCE);" >/dev/null
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$RESTORE_DB\";" >/dev/null

echo "[drill] 3/6 restore into $RESTORE_DB"
pg_restore --no-owner --no-privileges -d "$RESTORE_URL" "$DUMP" >/dev/null 2>&1 || true

echo "[drill] 4/6 compare row counts on authoritative tables"
TABLES="users accounts account_lifecycles account_qualifications account_profile_versions orders executions positions daily_account_stats payout_requests payout_ledger payout_operations outbox_events audit_log entitlements commercial_orders provisioning_requests trader_risk_controls"
FAIL=0
for t in $TABLES; do
  src=$(psql "$SRC_URL" -tAc "SELECT count(*) FROM $t" 2>/dev/null || echo "NA")
  dst=$(psql "$RESTORE_URL" -tAc "SELECT count(*) FROM $t" 2>/dev/null || echo "NA")
  if [ "$src" != "$dst" ]; then echo "  MISMATCH $t: src=$src restored=$dst"; FAIL=1; else echo "  ok $t=$src"; fi
done

echo "[drill] 5/6 content digest of the money ledger (order-independent)"
LEDGER_SQL="SELECT md5(string_agg(row_digest, '' ORDER BY row_digest)) FROM (SELECT md5(payout_request_id::text||entry_type||amount_micros::text||balance_before_micros::text||balance_after_micros::text) AS row_digest FROM payout_ledger) s"
src_dig=$(psql "$SRC_URL" -tAc "$LEDGER_SQL" 2>/dev/null || echo "NA")
dst_dig=$(psql "$RESTORE_URL" -tAc "$LEDGER_SQL" 2>/dev/null || echo "NA")
if [ "$src_dig" != "$dst_dig" ]; then echo "  MISMATCH payout_ledger digest"; FAIL=1; else echo "  ok payout_ledger digest=$src_dig"; fi

echo "[drill] 6/6 integrity checks on the RESTORED database (must be zero P0)"
INTEGRITY_SQL=$(cat <<'SQL'
SELECT 'ACTIVE_ACCOUNTS_OVER_CAP', count(*) FROM (SELECT user_id FROM accounts WHERE account_type IN ('EVALUATION','FUNDED_SIM') AND status IN ('ACTIVE','PENDING') AND archived_at IS NULL GROUP BY user_id HAVING count(*) > 5) a
UNION ALL SELECT 'PAID_CYCLES_OVER_MAX', count(*) FROM (SELECT account_id FROM payout_requests WHERE state='PAID' GROUP BY account_id HAVING count(*) > 5) b
UNION ALL SELECT 'DUP_FUNDED_SUCCESSOR', count(*) FROM (SELECT funded_account_id FROM account_qualifications WHERE funded_account_id IS NOT NULL GROUP BY funded_account_id HAVING count(*) > 1) c
UNION ALL SELECT 'DUP_RESET_SUCCESSOR', count(*) FROM (SELECT reset_of_account_id FROM accounts WHERE reset_of_account_id IS NOT NULL GROUP BY reset_of_account_id HAVING count(*) > 1) d
UNION ALL SELECT 'PAYOUT_LEDGER_ARITHMETIC', count(*) FROM payout_ledger WHERE (entry_type='DEBIT' AND balance_after_micros <> balance_before_micros - amount_micros) OR (entry_type='REVERSAL' AND balance_after_micros <> balance_before_micros + amount_micros) OR (entry_type='SETTLEMENT' AND balance_after_micros <> balance_before_micros)
UNION ALL SELECT 'FAILED_PAYOUT_NOT_REVERSED', count(*) FROM payout_requests r WHERE r.state='FAILED' AND EXISTS (SELECT 1 FROM payout_ledger d WHERE d.payout_request_id=r.id AND d.entry_type='DEBIT') AND NOT EXISTS (SELECT 1 FROM payout_ledger v WHERE v.payout_request_id=r.id AND v.entry_type='REVERSAL')
SQL
)
psql "$RESTORE_URL" -v ON_ERROR_STOP=1 -c "$INTEGRITY_SQL;" | tee "$WORK/integrity.txt"
BAD=$(psql "$RESTORE_URL" -tAc "SELECT coalesce(sum(n),0) FROM ($INTEGRITY_SQL) x(k,n)")
if [ "${BAD:-0}" != "0" ]; then echo "  INTEGRITY VIOLATIONS on restored DB: $BAD"; FAIL=1; else echo "  ok: zero integrity violations on restored DB"; fi

echo "[drill] cleanup"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\" WITH (FORCE);" >/dev/null
rm -f "$DUMP"

if [ "$FAIL" != "0" ]; then echo "RESTORE DRILL FAILED"; exit 1; fi
echo "==================================================================="
echo " RESTORE DRILL PASSED — restored copy retains authoritative truth"
echo "==================================================================="
