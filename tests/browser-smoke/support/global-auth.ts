/**
 * One signed-in account for the whole browser-smoke suite.
 *
 * Every spec used to sign up for itself, and each signup carried a full
 * application bootstrap behind it — session, settings, chats, environments,
 * agents. The API rate-limits the `general` bucket at 100 requests a minute
 * counted *per client IP* (`apps/api/src/plugins/rate-limit-policy.ts`), and on
 * CI the whole suite is one IP. At five specs that fit; the sixth pushed it
 * over, and whichever spec happened to run next failed on "too many requests"
 * looking exactly like its own feature had broken.
 *
 * Signing up once, here, over HTTP rather than through a browser, removes both
 * costs at once: one signup instead of four, and no page load to pay for it.
 * The session cookie is written to `storageState`, so specs open already
 * authenticated and go straight to the surface they are about.
 *
 * `auth-flow.spec.ts` deliberately opts out — it is the spec that tests signing
 * up and logging in, and it cannot start from a session that already exists.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type FullConfig, request } from '@playwright/test';

export const STORAGE_STATE_PATH = '.mango/artifacts/playwright/.auth/smoke-user.json';

const SMOKE_PASSWORD = 'smoke-pass-123';
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 500;

/** Waits for the API to answer, so this runs whether or not webServer is up yet. */
async function waitForServer(baseURL: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const probe = await request.newContext({ baseURL });

  try {
    while (Date.now() < deadline) {
      const healthy = await probe
        .get('/api/health')
        .then((response) => response.ok())
        .catch(() => false);
      if (healthy) return;
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    throw new Error(`browser-smoke: API at ${baseURL} never became ready.`);
  } finally {
    await probe.dispose();
  }
}

/**
 * Creates the shared account and saves its session cookie.
 *
 * @example
 * // playwright.config.ts
 * globalSetup: './tests/browser-smoke/support/global-auth.ts',
 */
export default async function globalAuth(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:3001';
  await waitForServer(baseURL);

  const context = await request.newContext({ baseURL });
  try {
    // Unique per run: the suite's database persists between runs on a developer
    // machine, and a second signup on a taken address fails rather than
    // reusing the account.
    const response = await context.post('/api/auth/sign-up/email', {
      data: {
        name: 'Smoke Suite',
        email: `smoke-suite-${Date.now()}@test.local`,
        password: SMOKE_PASSWORD,
      },
    });
    if (!response.ok()) {
      throw new Error(
        `browser-smoke: shared signup failed with ${response.status()}. ${await response.text()}`
      );
    }

    await mkdir(dirname(STORAGE_STATE_PATH), { recursive: true });
    await context.storageState({ path: STORAGE_STATE_PATH });
  } finally {
    await context.dispose();
  }
}
