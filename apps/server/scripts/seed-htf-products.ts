/**
 * Seed / reconcile the 10 LOCKED Happy Trader products (+ funded destinations).
 *
 * Thin wrapper over the ONE authoritative mechanism, `reconcileHtfProducts`, which
 * builds every product from the shared model (@atlas/contracts) and publishes it
 * into immutable product configuration. Idempotent: a version is (re)published only
 * when its terms differ from the current latest. The normal `db:seed` runs the same
 * reconciliation, so this script exists only for explicitly re-running it against an
 * existing database.
 *
 *   pnpm --filter @atlas/server exec tsx scripts/seed-htf-products.ts
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
    console.log(
      `HTF reconcile: ${r.active.length} active, ${r.internal.length} internal, ${r.retired.length} retired ` +
        `(${r.published.length} versions published, ${r.unchanged.length} unchanged)`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
