import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

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
      'tests/unit/lib/utils.test.ts',
      'tests/unit/utils/model-utils.test.ts',
      '**/node_modules/**',
      '**/dist/**',
      '**/*.config.*',
    ],
    reporters: process.env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions'] : ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      exclude: [
        'node_modules/',
        'tests/support/**',
        'src/lib/utils.ts',
        'src/utils/model-utils.ts',
        '**/*.d.ts',
        '**/*.config.*',
      ],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 64,
        lines: 72,
      },
    },
  },
});
