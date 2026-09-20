import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    passWithNoTests: true,
    // DB-backed suites share one seeded database; run files one at a time (CLAUDE.md D-045).
    fileParallelism: false,
  },
});
