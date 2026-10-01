import { defineConfig } from '@playwright/test';
import { STORAGE_STATE_PATH } from './tests/browser-smoke/support/global-auth';
import { prepareSmokeHome, smokeHubEnv } from './tests/browser-smoke/support/smoke-home';

// The suite signs up accounts and creates chats, so it gets a hub of its own on
// a throwaway home (see the module for how that confines every storage path).
// Created once by the runner; workers re-evaluating this file reuse it.
const smokeHome = prepareSmokeHome(process.env);

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
  projects: [
    // The terminal spec runs first, on its own. A Local terminal needs the
    // single-user-host attestation, which the hub withdraws for the rest of its
    // process once a second account connects — and `auth-flow.spec.ts` signs
    // one up. Filename order is not a guarantee with more than one worker;
    // a project dependency is.
    {
      name: 'terminal',
      use: { browserName: 'chromium' },
      testMatch: /terminal\.spec\.ts$/,
    },
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
      testIgnore: /terminal\.spec\.ts$/,
      dependencies: ['terminal'],
    },
  ],
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
      // Never attach to a hub that is already running: its home is whatever
      // the developer started it with, which is their real `~/.mango`. A hub
      // left on :3001 now fails the run loudly ("already used") instead.
      reuseExistingServer: false,
      // `bun run dev` -> turbo -> `bun run --watch` is a chain of processes;
      // a graceful signal lets each one forward it instead of the chain being
      // cut off at the top and leaving the hub listening on :3001.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      env: {
        ...smokeHubEnv(smokeHome),
        // Required since the auth-secret startup guard landed; a 32+ char
        // random value satisfies the runtime check without exposing a real key.
        BETTER_AUTH_SECRET: 'browser-smoke-test-secret-at-least-32-characters-long',
      },
    },
  ],
});
