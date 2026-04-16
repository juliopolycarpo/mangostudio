import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/support/**', '**/node_modules/**', '**/dist/**', '**/*.config.*'],
    reporters: process.env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions'] : ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'lcov', 'html'],
      exclude: ['node_modules/', 'tests/support/**', '**/*.d.ts', '**/*.config.*'],
      thresholds: {
        statements: 75,
        branches: 73,
        functions: 68,
        lines: 78,
      },
    },
  },
});
