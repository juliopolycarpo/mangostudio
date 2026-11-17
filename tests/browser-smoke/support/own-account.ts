/**
 * A signed-in browser context on an account of the spec's own.
 *
 * The suite's shared account is a trap for any spec that depends on account
 * settings: `github-panel.spec.ts` turns the GitHub rail panel off and leaves it
 * off, so a spec that runs after it on the shared account finds no GitHub dock
 * button. A fresh account starts from the defaults.
 */

import { type Browser, type BrowserContext, expect } from '@playwright/test';

const SMOKE_PASSWORD = 'smoke-pass-123';

/**
 * Signs up `label-<run>@test.local` in a context of its own and finishes its
 * first-run setup, so its pages open on the chat shell rather than on `/welcome`.
 * The caller closes the context.
 *
 * @example
 * const context = await newSignedInContext(browser, 'lazy-panel', `${Date.now()}`);
 * const page = await context.newPage();
 */
export async function newSignedInContext(
  browser: Browser,
  label: string,
  run: string
): Promise<BrowserContext> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const signup = await context.request.post('/api/auth/sign-up/email', {
    data: { name: label, email: `${label}-${run}@test.local`, password: SMOKE_PASSWORD },
  });
  expect(signup.ok(), `expected signup: 2xx | received: ${signup.status()}`).toBe(true);
  const setup = await context.request.put('/api/settings/app', {
    data: {
      profileSettings: {
        default: {
          onboarding: { welcomeAcknowledged: true, skippedSteps: [], completedAt: Date.now() },
        },
      },
    },
  });
  expect(setup.ok(), `expected first-run setup: 2xx | received: ${setup.status()}`).toBe(true);
  return context;
}
