import { defineConfig } from '@playwright/test';
import { STORAGE_STATE_PATH } from './tests/browser-smoke/support/global-auth';

export default defineConfig({
  testDir: './tests/browser-smoke',
  // One signed-in account for the suite, created over HTTP before any spec
  // runs. See the module for why: per-spec signups put the suite over the API's
  // per-IP rate limit, and the spec that tripped it was never the one at fault.
  globalSetup: './tests/browser-smoke/support/global-auth.ts',
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
    // One origin: the API builds and serves the frontend, so there is no
    // separate dev server and nothing on :5173 any more.
    baseURL: 'http://localhost:3001',
    // Specs start authenticated. `auth-flow.spec.ts` opts back out, because it
    // is the one that tests signing up and logging in.
    storageState: STORAGE_STATE_PATH,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'bun run dev --api',
      port: 3001,
      // The API builds the frontend bundle before it listens, so the default
      // 60s is not enough on a cold runner.
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        // Required since the auth-secret startup guard landed; a 32+ char
        // random value satisfies the runtime check without exposing a real key.
        BETTER_AUTH_SECRET: 'browser-smoke-test-secret-at-least-32-characters-long',
      },
    },
  ],
});
