import { configDefaults, defineConfig } from 'vitest/config';

const TOOL_E2E_SUITES = 'tools/*/tests/e2e/**';
const underVerify = process.env.TBX_TOOL_BIN !== undefined;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
    passWithNoTests: true,
    include: ['tests/**/*.test.ts', 'tools/*/tests/**/*.test.ts', 'shared/ts/**/*.test.ts'],
    exclude: underVerify ? configDefaults.exclude : [...configDefaults.exclude, TOOL_E2E_SUITES],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules', 'dist', 'vitest.config.ts'],
    },
  },
});
