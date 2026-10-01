/**
 * Per-worker test-database helpers (PCV-6 deterministic test isolation).
 *
 * The canonical test database (default `atlas_test`) is prepared once —
 * migrated from zero and seeded — by scripts/prepare-test-db.sh. When test
 * isolation is ON (HTF_TEST_ISOLATION=1), the vitest globalSetup clones it into
 * one database per worker fork via `CREATE DATABASE … TEMPLATE atlas_test` (a
 * fast file-level copy that inherits every migration and seed row), and each
 * worker's setup file points its connections at its own clone. Parallel test
 * files then run against disjoint databases and cannot pollute, deadlock, or
 * starve one another.
 *
 * These helpers are the single source of truth for the pool size and the
 * derived URLs/names, shared by globalSetup and the per-worker setup file so
 * the clone that globalSetup creates is exactly the one a worker connects to.
 * They are deterministic (no randomness) and depend only on env + worker id.
 */
import os from 'node:os';

/** Isolation is strictly opt-in, so an ordinary `pnpm test` or a web-only run
 * is untouched. The determinism harness and (optionally) canonical validation
 * export HTF_TEST_ISOLATION=1 before invoking vitest. */
export function testIsolationEnabled(): boolean {
  return process.env['HTF_TEST_ISOLATION'] === '1';
}

/** Number of per-worker clones to create. Matches the vitest fork count the
 * harness passes via --maxWorkers. Explicit HTF_TEST_DB_WORKERS wins; otherwise
 * a bounded function of the CPU count so it is deterministic on a given box. */
export function testDbPoolSize(): number {
  const explicit = Number(process.env['HTF_TEST_DB_WORKERS']);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const cpus = os.cpus().length || 2;
  return Math.max(2, Math.min(cpus, 4));
}

/** The prepared template database URL (what prepare-test-db.sh built). */
export function baseTestDbUrl(): string {
  return process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
}

/** Parse the database name (last path segment, minus any query) from a URL. */
export function parseDbName(url: string): string {
  const match = url.match(/\/([^/?]+)(\?.*)?$/);
  return match ? match[1]! : 'atlas_test';
}

/** The admin (maintenance) URL — same server, `postgres` database — used to run
 * CREATE/DROP DATABASE, which cannot run while connected to the target. */
export function adminDbUrl(base = baseTestDbUrl()): string {
  const name = parseDbName(base);
  return base.replace(new RegExp(`/${name}(\\?.*)?$`), '/postgres$1');
}

/** The clone name for a given 1-based worker id, e.g. `atlas_test_w3`. */
export function workerDbName(workerId: number, base = baseTestDbUrl()): string {
  return `${parseDbName(base)}_w${workerId}`;
}

/** The clone URL for a given 1-based worker id. */
export function workerDbUrl(workerId: number, base = baseTestDbUrl()): string {
  const name = parseDbName(base);
  return base.replace(new RegExp(`/${name}(\\?.*)?$`), `/${name}_w${workerId}$1`);
}
