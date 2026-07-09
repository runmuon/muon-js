import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['audit-A/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // run each file in its own process so global hooks / process listeners
    // from one probe cannot mask another.
    isolate: true,
    pool: 'forks',
  },
});
