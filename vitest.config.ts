import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // Engine integration tests share one PostgreSQL database. They each create
    // their own account, but running files in parallel against one connection
    // pool makes failures hard to read, so files run one at a time.
    fileParallelism: false,
  },
});
