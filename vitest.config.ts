import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    reporters: 'default',
    // Several suites chdir into a temp project directory. process.cwd() is
    // per-process, so files must not share one.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    fileParallelism: true,
    sequence: { concurrent: false },
  },
});
