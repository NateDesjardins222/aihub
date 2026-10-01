import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts', 'apps/web/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // Canonical validation runs files one at a time. This is DEFENCE IN DEPTH,
    // not the fix: the PCV-6 non-determinism was removed at its source — the
    // background workers that escaped a test's lifetime are now gated off under
    // test (apps/server/src/http/app.ts, backgroundWorkersEnabled()), so files
    // no longer pollute or deadlock one another. Serial execution additionally
    // keeps a single shared database legible. True concurrency is PROVEN
    // separately, with per-worker database isolation, by `pnpm test:determinism`
    // (scripts/test-determinism.sh) — see docs/TEST_ISOLATION_ARCHITECTURE.md.
    fileParallelism: false,
    // Per-worker database isolation. BOTH hooks self-disable unless
    // HTF_TEST_ISOLATION=1, so an ordinary `pnpm test` (or a web-only run) is
    // completely unaffected; only the determinism harness turns them on, which
    // is when file parallelism is also enabled. globalSetup clones the prepared
    // template DB once per fork; the setup file points each fork at its clone.
    globalSetup: ['./apps/server/src/test/global-setup.ts'],
    setupFiles: ['./apps/server/src/test/setup-worker-db.ts'],
  },
});
