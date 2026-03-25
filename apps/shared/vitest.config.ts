import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/support/**', '**/node_modules/**', '**/dist/**', '**/*.config.*'],
  },
});
