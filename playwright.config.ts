import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser-smoke',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'bun run dev:api',
      port: 3001,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'bun run dev:frontend',
      port: 5173,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
