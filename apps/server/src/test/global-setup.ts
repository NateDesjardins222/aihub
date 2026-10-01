/**
 * Vitest globalSetup for PCV-6 deterministic test isolation.
 *
 * Runs ONCE in the main process before any worker starts. When isolation is ON
 * it clones the prepared template database (atlas_test, already migrated +
 * seeded by scripts/prepare-test-db.sh) into one database per worker fork using
 * `CREATE DATABASE … TEMPLATE`, a fast file-level copy — so every clone has the
 * full migration set (through 0038_celebration_acks) and seed catalog without
 * re-migrating. The returned teardown drops the clones.
 *
 * Self-disabling: with HTF_TEST_ISOLATION unset (an ordinary `pnpm test`, a
 * web-only run, an ad-hoc file run) this is a no-op and the suite uses the
 * single prepared database exactly as before.
 *
 * Safety: it refuses to touch a database named `atlas` (the canonical dev DB)
 * and only ever drops databases matching its own `<base>_w<n>` clone naming.
 */
import postgres from 'postgres';
import {
  adminDbUrl,
  baseTestDbUrl,
  parseDbName,
  testDbPoolSize,
  testIsolationEnabled,
  workerDbName,
} from './worker-db.js';

export default async function setup(): Promise<() => Promise<void>> {
  if (!testIsolationEnabled()) return async () => undefined;

  const base = baseTestDbUrl();
  const templateName = parseDbName(base);
  if (templateName === 'atlas') {
    throw new Error('PCV-6 isolation refuses to clone the canonical dev database "atlas".');
  }
  const poolSize = testDbPoolSize();

  // Dirty/repeat-DB proof (PCV-6 §22): HTF_SKIP_CLONE=1 reuses the clones a
  // previous run left — already full of that run's fixtures — instead of
  // recreating them. A suite that still passes against a dirty database proves
  // its fixtures are uniquely named and its cleanup is scoped (no global
  // TRUNCATE/DELETE that a repeat run would depend on). Teardown leaves them.
  if (process.env['HTF_SKIP_CLONE'] === '1') {
    // eslint-disable-next-line no-console
    console.log(`[pcv6-isolation] reusing ${poolSize} existing (dirty) per-worker databases`);
    return async () => undefined;
  }

  const admin = postgres(adminDbUrl(base), { max: 1, onnotice: () => {} });

  try {
    // Drop any connections lingering on the template so TEMPLATE can be used.
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = '${templateName}' AND pid <> pg_backend_pid()`,
    );
    for (let workerId = 1; workerId <= poolSize; workerId += 1) {
      const name = workerDbName(workerId, base);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${templateName}"`);
    }
    // eslint-disable-next-line no-console
    console.log(`[pcv6-isolation] cloned ${templateName} → ${poolSize} per-worker databases`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  return async () => {
    const admin2 = postgres(adminDbUrl(base), { max: 1, onnotice: () => {} });
    try {
      for (let workerId = 1; workerId <= poolSize; workerId += 1) {
        await admin2.unsafe(`DROP DATABASE IF EXISTS "${workerDbName(workerId, base)}" WITH (FORCE)`);
      }
    } finally {
      await admin2.end({ timeout: 5 });
    }
  };
}
