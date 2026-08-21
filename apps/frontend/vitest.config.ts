import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The Vitest lane, now empty.
 *
 * Every test file runs on `bun test` — see the `test:unit` and
 * `test:integration` scripts, and `tests/unit/bun-lane-harness.test.ts` for the
 * guard that keeps it that way. `include: []` is what makes that true rather
 * than merely intended: left at its default this config would collect all 167
 * files a second time and fail on `import { jest } from 'bun:test'`.
 *
 * The file survives only because removing it would orphan `vite`,
 * `@vitejs/plugin-react`, `@tailwindcss/vite`, `vitest` and
 * `@vitest/coverage-istanbul` in the same change; that deletion lands with them.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: [],
    coverage: {
      provider: 'istanbul',
      reportsDirectory: path.resolve(__dirname, '../../.mango/artifacts/coverage/frontend/vitest'),
      reporter: ['text', 'json-summary', 'lcov'],
      exclude: [
        'node_modules/',
        'tests/support/**',
        'src/lib/utils.ts',
        'src/utils/model-utils.ts',
        '**/*.d.ts',
        '**/*.config.*',
      ],
      // No thresholds: this lane runs no files, so any number here would gate
      // on a coverage figure nothing produces. The Bun lane re-derives real
      // ones against the whole suite.
      thresholds: undefined,
    },
  },
});
