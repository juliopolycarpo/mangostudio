import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser-smoke',
  outputDir: '.mango/artifacts/playwright/test-results',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [
        ['github'],
        ['html', { open: 'never', outputFolder: '.mango/artifacts/playwright/html-report' }],
      ]
    : 'list',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'bun run dev --api',
      port: 3001,
      reuseExistingServer: !process.env.CI,
      env: {
        // Required since the auth-secret startup guard landed; a 32+ char
        // random value satisfies the runtime check without exposing a real key.
        BETTER_AUTH_SECRET: 'browser-smoke-test-secret-at-least-32-characters-long',
      },
    },
    {
      command: 'bun run dev --frontend',
      port: 5173,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
