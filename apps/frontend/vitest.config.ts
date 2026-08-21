import { readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Files that have already moved to `bun test`, read back off the script that
 * runs them.
 *
 * Both lanes are live during the migration, and a file listed in neither runs
 * nowhere while a file listed in both runs twice — neither shows up as a
 * failure. Deriving the exclusion from `test:unit:bun` makes the package script
 * the single source of truth, so moving a file across lanes is one edit.
 * `tests/vitest-lane.test.ts` fails if this derivation stops finding anything.
 */
export function bunLaneFiles(): string[] {
  const manifest = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return manifest.scripts['test:unit:bun']
    .split(/\s+/)
    .filter((arg) => /^tests\/.+\.tsx?$/.test(arg));
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Swap `motion/react` for a synchronous stub. Real exit animations leave
      // elements mounted mid-transition, which made AnimatePresence-driven
      // assertions race the animation and fail only under load.
      'motion/react': path.resolve(__dirname, './tests/support/setup/motion-react-stub.tsx'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/support/setup/vitest.setup.ts'],
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: [
      'tests/support/**',
      ...bunLaneFiles(),
      '**/node_modules/**',
      '**/dist/**',
      '**/*.config.*',
    ],
    reporters: process.env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions'] : ['default'],
    // Same 15s floor the Bun lanes take via `--timeout`, for the same reason:
    // a runner under load is several times slower than a dev machine, and both
    // runners otherwise default to 5s. Per-test and per-hook overrides still win.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      // istanbul instruments source through the Vite transform pipeline, so it
      // works under Bun (which runs vitest via the `node` shim). The v8 provider
      // needs V8 inspector coverage APIs that Bun does not implement, which made
      // `bun run test --coverage` fail outside CI runners that ship real Node.
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
      // No thresholds while the suite migrates to `bun test`.
      //
      // 70/60/64/72 were measured over all 167 files. This lane now runs
      // whatever has not moved yet, so the numbers describe a shrinking and
      // arbitrary subset of the sources — moving eight files already took
      // branches within 4.9 points of its floor, and the set reaches zero
      // before this PR ends. Ratcheting them down per batch would gate on a
      // number nobody chose. The Bun lane re-derives real thresholds against
      // the whole suite.
      thresholds: undefined,
    },
  },
});
