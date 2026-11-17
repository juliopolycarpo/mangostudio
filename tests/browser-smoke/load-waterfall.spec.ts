import { tmpdir } from 'node:os';

import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

import { STORAGE_STATE_PATH } from './support/global-auth';
import { dismissWorkdirPicker } from './support/workdir-picker';

/**
 * What a first use of each lazy feature asks the hub for.
 *
 * The bundle report (`scripts/ci/frontend-load-graph.ts`) predicts the rounds
 * of requests from the build's metafile; this spec watches a real browser fetch them.
 * Each feature runs in a context of its own, so no module a previous step
 * loaded is in the HTTP cache or the module map. Timings come from the
 * browser's own Resource Timing entries, not from Playwright's event stream,
 * and go to the run output as `LOAD_WATERFALL` JSON lines.
 * `MANGO_LOAD_PROFILE=slow-4g` runs the same steps behind a CDP network
 * throttle (150 ms RTT, 1.6 Mbit/s).
 *
 * A measurement, not a check: it asserts only that each feature appears, and
 * it is slow under the throttle, so it runs when asked for, against a
 * throwaway hub (it adds chats to the suite's smoke account):
 * `MANGO_LOAD_WATERFALL=1 bunx playwright test load-waterfall`.
 */
test.skip(
  process.env.MANGO_LOAD_WATERFALL !== '1',
  'measurement only: set MANGO_LOAD_WATERFALL=1 to run it'
);

const PROFILES: Record<string, { latency: number; bytesPerSecond: number } | undefined> = {
  none: undefined,
  'slow-4g': { latency: 150, bytesPerSecond: (1.6 * 1024 * 1024) / 8 },
};
const PROFILE_NAME = process.env.MANGO_LOAD_PROFILE ?? 'none';
const PROFILE = PROFILES[PROFILE_NAME];

interface LoadedResource {
  readonly path: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly transferBytes: number;
}

/** Script, stylesheet and font entries that started at or after `sinceMs` (page clock). */
async function resourcesSince(page: Page, sinceMs: number): Promise<LoadedResource[]> {
  return page.evaluate((since) => {
    return performance
      .getEntriesByType('resource')
      .filter((entry) => entry.startTime >= since)
      .map((entry) => {
        const timing = entry as PerformanceResourceTiming;
        return {
          path: new URL(entry.name).pathname,
          startMs: Math.round(entry.startTime - since),
          endMs: Math.round(entry.responseEnd - since),
          transferBytes: timing.transferSize,
        };
      })
      .filter((entry) => /\.(js|css|woff2)$/.test(entry.path))
      .sort((a, b) => a.startMs - b.startMs);
  }, sinceMs);
}

/** A context on the suite's smoke account, with an empty browser cache. */
function signedInContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: STORAGE_STATE_PATH,
  });
}

async function throttle(page: Page): Promise<void> {
  if (!PROFILE) return;
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: PROFILE.latency,
    downloadThroughput: PROFILE.bytesPerSecond,
    uploadThroughput: PROFILE.bytesPerSecond,
  });
}

/** One feature's measurement: when it was ready and what it fetched, from the page clock `since`. */
async function report(
  page: Page,
  feature: string,
  since: number,
  readyAt: number,
  extra: Record<string, number> = {}
): Promise<void> {
  await page.waitForLoadState('networkidle');
  const resources = await resourcesSince(page, since);
  const scripts = resources.filter((resource) => resource.path.endsWith('.js'));
  process.stdout.write(
    `LOAD_WATERFALL ${JSON.stringify({
      feature,
      profile: PROFILE_NAME,
      readyMs: Math.round(readyAt - since),
      ...extra,
      scriptRequests: scripts.length,
      scriptBytes: scripts.reduce((sum, resource) => sum + resource.transferBytes, 0),
      resources: resources.map((resource) => ({
        ...resource,
        path: resource.path.replace('/assets/', ''),
      })),
    })}\n`
  );
}

const now = (page: Page): Promise<number> => page.evaluate(() => performance.now());

async function createChat(
  page: Page,
  title: string,
  options: { readonly text?: string }
): Promise<void> {
  const created = await page.request.post('/api/chats', { data: { title } });
  expect(created.ok(), `expected chat create: 2xx | received: ${created.status()}`).toBe(true);
  const { id } = (await created.json()) as { id: string };
  // A chat with a working directory is what makes the Git panel available.
  const bound = await page.request.put(`/api/chats/${id}`, { data: { workdir: tmpdir() } });
  expect(bound.ok(), `expected workdir bind: 2xx | received: ${bound.status()}`).toBe(true);
  if (options.text === undefined) return;
  const stored = await page.request.post('/api/messages', {
    data: {
      id: `${id}-message`,
      chatId: id,
      role: 'user',
      text: options.text,
      timestamp: Date.now(),
      interactionMode: 'agent',
    },
  });
  expect(stored.ok(), `expected message stored: 2xx | received: ${stored.status()}`).toBe(true);
}

/**
 * A signed-in context whose account has one freshly seeded chat, the newest,
 * which the landing opens. The chat is seeded from a throwaway context, so the
 * measured one starts with an empty cache.
 */
async function contextWithChat(
  browser: Browser,
  title: string,
  text?: string
): Promise<BrowserContext> {
  const seeding = await signedInContext(browser);
  await createChat(await seeding.newPage(), title, { text });
  await seeding.close();
  return signedInContext(browser);
}

test.describe.configure({ mode: 'serial' });

test('first load of the chat page', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await contextWithChat(browser, `waterfall-chat-${Date.now()}`);
  const page = await context.newPage();
  await throttle(page);
  await page.goto('/');
  await dismissWorkdirPicker(page, 2_000);
  await expect(page.getByTestId('sidebar-new-chat')).toBeVisible({ timeout: 60_000 });
  await report(page, 'chat-first-load', 0, await now(page));
  await context.close();
});

const MARKDOWN_BLOCKS = [
  { lang: 'ts', source: 'const answer: number = 42;', feature: 'markdown-code-block' },
  { lang: 'bash', source: 'echo "hello" | tr a-z A-Z', feature: 'markdown-code-block-bash' },
] as const;

for (const { lang, source, feature } of MARKDOWN_BLOCKS) {
  test(`first markdown code block (${lang})`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await contextWithChat(
      browser,
      `waterfall-md-${lang}-${Date.now()}`,
      `Here:\n\n\`\`\`${lang}\n${source}\n\`\`\`\n`
    );
    const page = await context.newPage();
    await throttle(page);
    await page.goto('/');
    await dismissWorkdirPicker(page, 2_000);
    await expect(page.getByTestId('sidebar-new-chat')).toBeVisible({ timeout: 60_000 });
    const shellAt = await now(page);
    await expect(page.locator('pre.shiki').first()).toBeVisible({ timeout: 90_000 });
    await report(page, feature, 0, await now(page), { shellMs: Math.round(shellAt) });
    await context.close();
  });
}

test('open a terminal', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await contextWithChat(browser, `waterfall-terminal-${Date.now()}`);
  const page = await context.newPage();
  await page.goto('/');
  await dismissWorkdirPicker(page, 2_000);
  const railButton = page.getByRole('button', { name: 'Show Terminal panel' });
  await expect(railButton).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await throttle(page);
  const since = await now(page);
  if ((await railButton.getAttribute('aria-pressed')) !== 'true') await railButton.click();
  await page.getByRole('button', { name: 'New terminal' }).click();
  await expect(page.getByTestId('terminal-view')).toBeVisible({ timeout: 60_000 });
  await report(page, 'terminal-open', since, await now(page));
  await context.close();
});

test('open the Git panel', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await contextWithChat(browser, `waterfall-git-${Date.now()}`);
  const page = await context.newPage();
  await page.goto('/');
  await dismissWorkdirPicker(page, 2_000);
  // Reach the Git panel from another one: a rail that already shows it
  // fetches nothing when "opened".
  const terminalButton = page.getByRole('button', { name: 'Show Terminal panel' });
  await expect(terminalButton).toBeVisible({ timeout: 30_000 });
  await terminalButton.click();
  await page.waitForLoadState('networkidle');
  await throttle(page);
  const since = await now(page);
  await page.getByRole('button', { name: 'Show Repository panel' }).click();
  // The panel's refresh control is the first thing the Git panel body draws.
  await expect(page.getByRole('button', { name: 'Refresh repository state' })).toBeVisible({
    timeout: 60_000,
  });
  await report(page, 'git-panel-open', since, await now(page));
  await context.close();
});

test('open the GitHub panel', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await contextWithChat(browser, `waterfall-github-${Date.now()}`);
  const page = await context.newPage();
  await page.goto('/');
  await dismissWorkdirPicker(page, 2_000);
  // Reach it from another panel, for the same reason as the Git panel.
  const terminalButton = page.getByRole('button', { name: 'Show Terminal panel' });
  await expect(terminalButton).toBeVisible({ timeout: 30_000 });
  await terminalButton.click();
  await page.waitForLoadState('networkidle');
  await throttle(page);
  const since = await now(page);
  await page.getByRole('button', { name: 'Show GitHub panel' }).click();
  await expect(page.getByTestId('github-panel')).toBeVisible({ timeout: 60_000 });
  await report(page, 'github-panel-open', since, await now(page));
  await context.close();
});

test('open the GitHub panel after the pointer rested on its button', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await contextWithChat(browser, `waterfall-github-hover-${Date.now()}`);
  const page = await context.newPage();
  await page.goto('/');
  await dismissWorkdirPicker(page, 2_000);
  const terminalButton = page.getByRole('button', { name: 'Show Terminal panel' });
  await expect(terminalButton).toBeVisible({ timeout: 30_000 });
  await terminalButton.click();
  await page.waitForLoadState('networkidle');
  await throttle(page);
  const since = await now(page);
  const githubButton = page.getByRole('button', { name: 'Show GitHub panel' });
  await githubButton.hover();
  // A pointer takes a moment to get from "over the button" to the click.
  await page.waitForTimeout(PROFILE === undefined ? 150 : 1_500);
  const clickedAt = await now(page);
  await githubButton.click();
  await expect(page.getByTestId('github-panel')).toBeVisible({ timeout: 60_000 });
  await report(page, 'github-panel-open-hovered', since, await now(page), {
    clickToReadyMs: Math.round((await now(page)) - clickedAt),
  });
  await context.close();
});
