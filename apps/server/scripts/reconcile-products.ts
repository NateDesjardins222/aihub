/**
 * Reconcile an EXISTING development database to the authoritative Happy Trader
 * product model (Phase 3).
 *
 * Safe to run on a database that predates the authoritative model: it publishes a
 * corrected immutable version for any product whose terms have drifted (Gold target
 * 15K / drawdown 10K, Select drawdowns 1250/2500/5000, EOD_TRAILING for all 10),
 * marks the 10 evaluations ACTIVE and their funded destinations INTERNAL, and
 * retires the legacy Atlas templates — without deleting any historical record or
 * rewriting any account's pinned version.
 *
 * IDEMPOTENT: re-running makes no further changes once the database is correct.
 *
 *   pnpm --filter @atlas/server exec tsx scripts/reconcile-products.ts
 *   # or, from the repo root:  pnpm db:reconcile
 */
import { createDb } from '../src/db/client.js';
import { defaultOrganizationId } from '../src/platform/provisioning.js';
import { reconcileHtfProducts } from '../src/platform/product-reconcile.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas';
  const { db, sql } = createDb(url);
  try {
    const organizationId = await defaultOrganizationId(db);
    const r = await reconcileHtfProducts(db, organizationId);
    // eslint-disable-next-line no-console
    console.log('Product reconciliation complete:');
    // eslint-disable-next-line no-console
    console.log(`  active (commercial):   ${r.active.length}  [${r.active.join(', ')}]`);
    // eslint-disable-next-line no-console
    console.log(`  internal (funded+prac):${r.internal.length}  [${r.internal.join(', ')}]`);
    // eslint-disable-next-line no-console
    console.log(`  retired (legacy):      ${r.retired.length}  [${r.retired.join(', ')}]`);
    // eslint-disable-next-line no-console
    console.log(`  versions published:    ${r.published.length}  [${r.published.join(', ')}]`);
    // eslint-disable-next-line no-console
    console.log(`  unchanged:             ${r.unchanged.length}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('reconcile failed:', err);
  process.exit(1);
});
