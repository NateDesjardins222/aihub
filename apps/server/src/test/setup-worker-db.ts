/**
 * Vitest per-worker setup (PCV-6 deterministic test isolation).
 *
 * Runs in every worker fork before its test files import anything. When
 * isolation is ON, it pins this fork to its own cloned database (created by
 * global-setup.ts) by setting HTF_TEST_WORKER_DB — which db/client.ts routes
 * every connection to, including the test files that hard-code an `atlas_test`
 * URL. DATABASE_URL / TEST_DATABASE_URL are set to the same clone so the few
 * paths that read them directly agree. It runs before any `env()` call, and the
 * routing in client.ts reads process.env directly, so `env()` caching cannot
 * defeat it.
 *
 * Self-disabling: with HTF_TEST_ISOLATION unset this is a no-op and every worker
 * uses the single prepared database, exactly as before.
 *
 * The worker id → clone mapping is deterministic: vitest numbers forks
 * 1..maxWorkers via VITEST_POOL_ID, and the harness passes --maxWorkers equal to
 * the clone count, so id and clone line up one-to-one (a defensive modulo keeps
 * it in range if they ever differ).
 */
import { testDbPoolSize, testIsolationEnabled, workerDbUrl } from './worker-db.js';

if (testIsolationEnabled()) {
  const poolSize = testDbPoolSize();
  const raw = Number(process.env['VITEST_POOL_ID'] ?? process.env['VITEST_WORKER_ID'] ?? '1');
  const workerId = Number.isInteger(raw) && raw > 0 ? ((raw - 1) % poolSize) + 1 : 1;
  const url = workerDbUrl(workerId);
  process.env['HTF_TEST_WORKER_DB'] = url;
  process.env['DATABASE_URL'] = url;
  process.env['TEST_DATABASE_URL'] = url;
}
