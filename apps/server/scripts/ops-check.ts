/**
 * Read-only operational self-check for a developer or operator.
 *
 * ONE command that answers the everyday operational questions without opening a
 * database by hand: what build is this, is the DB reachable, which providers are
 * enabled, is the outbox draining, is the infrastructure healthy (System Doctor),
 * and did integrity last pass? It is strictly READ-ONLY — it never writes a row,
 * moves money, or repairs anything — and it is CHEAP: it runs the bounded
 * System-Doctor probes and reads the LATEST PERSISTED integrity result. It does
 * NOT run the expensive deep integrity/reconciliation scan; that stays explicit
 * behind `pnpm integrity:check`.
 *
 * Exit code:
 *   0  healthy (System Doctor HEALTHY or WARNING, DB reachable)
 *   1  the check itself failed to run (could not connect / query)
 *   2  a CRITICAL operational condition (DB down, System Doctor CRITICAL)
 *
 *   pnpm --filter @atlas/server exec tsx scripts/ops-check.ts
 *   # or, from the repo root:  pnpm ops:check
 *
 * Flags:
 *   --json   emit a machine-readable JSON report instead of text
 */
import { desc, eq, sql as sqlRaw } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { integrityCheckResults } from '../src/db/schema.js';
import { releaseInfo } from '../src/config/release.js';
import { providerSafetySummary } from '../src/config/provider-safety.js';
import { outboxHealth } from '../src/platform/outbox.js';
import { runSystemDoctor } from '../src/platform/system-doctor.js';
import { defaultOrganizationId } from '../src/platform/provisioning.js';

interface OpsReport {
  ok: boolean;
  release: ReturnType<typeof releaseInfo>;
  database: { reachable: boolean; latencyMs: number | null };
  providers: ReturnType<typeof providerSafetySummary>;
  outbox: Awaited<ReturnType<typeof outboxHealth>>;
  doctor: { overall: string; checks: { key: string; status: string; actual: string }[] };
  latestIntegrity: { runId: string; at: string | null; failing: number; total: number } | null;
}

async function main(): Promise<void> {
  const json = new Set(process.argv.slice(2)).has('--json');
  const url = process.env['DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas';
  const { db, sql } = createDb(url);
  try {
    // DB ping (bounded).
    let reachable = false;
    let latencyMs: number | null = null;
    try {
      const t0 = Date.now();
      await db.execute(sqlRaw`select 1`);
      latencyMs = Date.now() - t0;
      reachable = true;
    } catch {
      reachable = false;
    }

    const providers = providerSafetySummary();

    // Everything below needs the DB; if it is down we still emit a report.
    let outbox: OpsReport['outbox'] = {
      pending: 0, deadLetter: 0, delivered: 0, oldestPendingAgeMs: null,
      state: 'HEALTHY', stallThresholdMs: 0, reason: 'db unreachable',
    };
    let doctor: OpsReport['doctor'] = { overall: reachable ? 'HEALTHY' : 'CRITICAL', checks: [] };
    let latestIntegrity: OpsReport['latestIntegrity'] = null;

    if (reachable) {
      const orgId = await defaultOrganizationId(db);
      outbox = await outboxHealth(db);
      const report = await runSystemDoctor(db, orgId, false);
      doctor = {
        overall: report.overall,
        checks: report.checks.map((c) => ({ key: c.key, status: c.status, actual: c.actual })),
      };

      // LATEST persisted integrity result — not a fresh (expensive) run.
      const rows = await db
        .select({
          runId: integrityCheckResults.runId,
          status: integrityCheckResults.status,
          createdAt: integrityCheckResults.createdAt,
        })
        .from(integrityCheckResults)
        .orderBy(desc(integrityCheckResults.createdAt))
        .limit(1);
      const lastRunId = rows[0]?.runId ?? null;
      if (lastRunId) {
        const runRows = await db
          .select({ status: integrityCheckResults.status, createdAt: integrityCheckResults.createdAt })
          .from(integrityCheckResults)
          .where(eq(integrityCheckResults.runId, lastRunId));
        const failing = runRows.filter((r) => r.status === 'FAIL').length;
        const at = runRows[0]?.createdAt ? new Date(runRows[0].createdAt as unknown as string).toISOString() : null;
        latestIntegrity = { runId: lastRunId, at, failing, total: runRows.length };
      }
    }

    const ok = reachable && doctor.overall !== 'CRITICAL';
    const report: OpsReport = { ok, release: releaseInfo(), database: { reachable, latencyMs }, providers, outbox, doctor, latestIntegrity };

    if (json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(report, null, 2));
    } else {
      printText(report);
    }
    process.exit(!reachable || doctor.overall === 'CRITICAL' ? 2 : 0);
  } catch (err) {
    console.error('ops:check failed to run:', err);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function printText(r: OpsReport): void {
  const log = (s = ''): void => {
    // eslint-disable-next-line no-console
    console.log(s);
  };
  log('== Operational self-check (read-only) ==');
  log();
  log(`Build:    commit=${r.release.commit}${r.release.label ? ` label=${r.release.label}` : ''} startedAt=${r.release.startedAt}`);
  log(`Database: ${r.database.reachable ? `reachable (${r.database.latencyMs}ms)` : 'UNREACHABLE'}`);
  log();
  log('Providers (secret-free):');
  for (const p of r.providers) log(`  ${p.capability}: ${p.mode}${p.safeForProduction ? '' : '  ⚠ NOT SAFE FOR PROD'}  — ${p.detail}`);
  log();
  log(`Outbox:   ${r.outbox.state}  (pending=${r.outbox.pending} deadLetter=${r.outbox.deadLetter} oldestPendingAgeMs=${r.outbox.oldestPendingAgeMs ?? 'n/a'})`);
  log(`          ${r.outbox.reason}`);
  log();
  log(`System Doctor: ${r.doctor.overall}`);
  for (const c of r.doctor.checks) log(`  ${c.key}: ${c.status} — ${c.actual}`);
  log();
  if (r.latestIntegrity) {
    log(`Latest integrity run: ${r.latestIntegrity.at ?? '?'} — ${r.latestIntegrity.failing} failing / ${r.latestIntegrity.total} checks (run ${r.latestIntegrity.runId.slice(0, 8)})`);
    log('  (this is the LAST PERSISTED result; run `pnpm integrity:check` for a fresh deep scan)');
  } else {
    log('Latest integrity run: none persisted yet — run `pnpm integrity:check`');
  }
  log();
  log(r.ok ? 'RESULT: OK ✓' : 'RESULT: ATTENTION NEEDED ✗');
}

main().catch((err) => {
  console.error('ops:check crashed:', err);
  process.exit(1);
});
