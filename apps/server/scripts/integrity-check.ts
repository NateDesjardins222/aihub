/**
 * Read-only integrity + reconciliation audit for an operator.
 *
 * Runs the full Phase-1 integrity suite (money-duplication, cap, cycle, ledger,
 * position invariants) and the Phase-2 per-account reconciliation oracle
 * (position/P&L rebuilt from executions, balance identity, ledger arithmetic)
 * across every account, and prints a report. It NEVER writes: no fills, no
 * balances, no lifecycle, no audit rows — safe to run against production at any
 * time.
 *
 * Exit code:
 *   0  clean (no violations)
 *   1  the run itself failed (could not connect / query)
 *   2  one or more integrity or reconciliation violations were found
 *
 *   pnpm --filter @atlas/server exec tsx scripts/integrity-check.ts
 *   # or, from the repo root:  pnpm integrity:check
 *
 * Flags:
 *   --json           emit a machine-readable JSON report instead of text
 *   --skip-reconcile only run the global integrity suite (faster on huge DBs)
 */
import { createDb } from '../src/db/client.js';
import { accounts } from '../src/db/schema.js';
import { runIntegrityChecks } from '../src/platform/resilience/integrity-checks.js';
import { reconcileAccounts } from '../src/platform/resilience/reconcile.js';

interface Report {
  ok: boolean;
  integrity: Awaited<ReturnType<typeof runIntegrityChecks>>;
  reconcile: { accountsChecked: number; violations: Awaited<ReturnType<typeof reconcileAccounts>> };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const json = args.has('--json');
  const skipReconcile = args.has('--skip-reconcile');
  const url = process.env['DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas';
  const { db, sql } = createDb(url);
  try {
    const integrity = await runIntegrityChecks(db);
    let accountIds: string[] = [];
    let reconcileViolations: Awaited<ReturnType<typeof reconcileAccounts>> = [];
    if (!skipReconcile) {
      const rows = await db.select({ id: accounts.id }).from(accounts);
      accountIds = rows.map((r) => r.id);
      reconcileViolations = await reconcileAccounts(db, accountIds);
    }
    const ok = integrity.length === 0 && reconcileViolations.length === 0;
    const report: Report = {
      ok,
      integrity,
      reconcile: { accountsChecked: accountIds.length, violations: reconcileViolations },
    };

    if (json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(report, null, 2));
    } else {
      printText(report);
    }
    // Non-zero on any violation so CI / cron can gate on it.
    process.exit(ok ? 0 : 2);
  } catch (err) {
    console.error('integrity:check failed to run:', err);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function printText(report: Report): void {
  const log = (s = ''): void => {
    // eslint-disable-next-line no-console
    console.log(s);
  };
  log('== Integrity + reconciliation audit (read-only) ==');
  log();
  const bySeverity = { P0: 0, P1: 0, P2: 0 };
  for (const f of report.integrity) bySeverity[f.severity] += 1;
  log(`Integrity suite: ${report.integrity.length} finding(s)  [P0=${bySeverity.P0} P1=${bySeverity.P1} P2=${bySeverity.P2}]`);
  for (const f of report.integrity) {
    log(`  [${f.severity}] ${f.check} — ${f.count} row(s): ${f.description}`);
    if (f.sample.length) log(`        sample: ${f.sample.slice(0, 5).join(', ')}`);
  }
  log();
  log(`Reconciliation: ${report.reconcile.accountsChecked} account(s) checked, ${report.reconcile.violations.length} line(s) of drift`);
  for (const l of report.reconcile.violations.slice(0, 50)) {
    log(`  ${l.kind} ${l.entity}: expected=${l.expected} actual=${l.actual} delta=${l.delta}${l.detail ? ` (${l.detail})` : ''}`);
  }
  if (report.reconcile.violations.length > 50) log(`  … and ${report.reconcile.violations.length - 50} more`);
  log();
  log(report.ok ? 'RESULT: CLEAN ✓' : 'RESULT: VIOLATIONS FOUND ✗');
}

main().catch((err) => {
  console.error('integrity:check crashed:', err);
  process.exit(1);
});
