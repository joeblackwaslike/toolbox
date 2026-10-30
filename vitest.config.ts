import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
    passWithNoTests: true,
    include: ['tests/**/*.test.ts', 'tools/*/tests/**/*.test.ts', 'shared/ts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules', 'dist', 'vitest.config.ts'],
    },
  },
});
