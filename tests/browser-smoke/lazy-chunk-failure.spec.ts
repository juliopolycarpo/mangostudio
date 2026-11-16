import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import { dismissWorkdirPicker } from './support/workdir-picker';

/**
 * Markdown, the diff viewer and the GitHub rail panel each load a chunk on
 * first use. When one cannot be fetched (offline, or the hub was upgraded under
 * an open tab) the failure must stay where the component sits. Before, it went
 * to the route's error component and replaced the whole page with "MangoStudio
 * could not finish loading". The terminal's case lives in `terminal.spec.ts`,
 * which has to run in the project that owns the single-user attestation.
 */
const MARKDOWN_CHUNK = /\/assets\/chunk-MarkdownContentRenderer-[^/]*\.js$/;
const DIFF_VIEWER_CHUNK = /\/assets\/chunk-DiffViewer-[^/]*\.js$/;
const GITHUB_PANEL_CHUNK = /\/assets\/chunk-GithubPanel-[^/]*\.js$/;

/** A chat with a working directory, which makes the Git panel the rail's first. */
async function seedChat(
  page: Page,
  title: string,
  options: { readonly workdir: string; readonly text?: string }
): Promise<void> {
  const created = await page.request.post('/api/chats', { data: { title } });
  expect(created.ok(), `expected chat create: 2xx | received: ${created.status()}`).toBe(true);
  const { id } = (await created.json()) as { id: string };
  const bound = await page.request.put(`/api/chats/${id}`, { data: { workdir: options.workdir } });
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

async function openNewestChat(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await dismissWorkdirPicker(page, 2_000);
  // The landing opens the newest chat; the sidebar row is the way to be sure.
  const row = page.getByRole('button', { name: title });
  if (await row.first().isVisible()) await row.first().click();
}

test('markdown stays readable as plain text when its chunk cannot be fetched', async ({ page }) => {
  test.setTimeout(90_000);
  const title = `lazy-markdown-${Date.now()}`;
  await seedChat(page, title, { workdir: tmpdir(), text: 'a **bold** claim' });

  await page.route(MARKDOWN_CHUNK, (route) => route.abort('failed'));
  const chunkFailed = page.waitForEvent('requestfailed', (request) =>
    MARKDOWN_CHUNK.test(request.url())
  );
  await openNewestChat(page, title);

  // The chunk request really failed, and the message shows the failure form of
  // the fallback (the loading form reads the same text, so the marker is what
  // tells them apart), with its line breaks kept.
  await chunkFailed;
  const fallback = page.locator('[data-markdown-fallback="failed"]', {
    hasText: 'a **bold** claim',
  });
  await expect(fallback).toBeVisible({ timeout: 30_000 });
  await expect(fallback).toHaveCSS('white-space', 'pre-wrap');
  await expect(page.getByText('MangoStudio could not finish loading')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-new-chat')).toBeVisible();
});

test('a diff viewer chunk that cannot be fetched fails in place and recovers on retry', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const repo = mkdtempSync(join(tmpdir(), 'lazy-diff-'));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    git('init', '-q');
    writeFileSync(join(repo, 'notes.txt'), 'one\n');
    git('add', 'notes.txt');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(repo, 'notes.txt'), 'one\ntwo\n');

    const title = `lazy-diff-${Date.now()}`;
    await seedChat(page, title, { workdir: repo });
    await page.route(DIFF_VIEWER_CHUNK, (route) => route.abort('failed'));
    await openNewestChat(page, title);

    await page.getByRole('button', { name: 'View diff for notes.txt' }).click({ timeout: 60_000 });
    const failure = page.getByTestId('lazy-chunk-failure');
    await expect(failure).toBeVisible({ timeout: 15_000 });
    // The rest of the Git panel and the chat are still there.
    await expect(page.getByTestId('sidebar-new-chat')).toBeVisible();
    await expect(page.getByText('MangoStudio could not finish loading')).toHaveCount(0);

    await page.unroute(DIFF_VIEWER_CHUNK);
    await failure.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('button', { name: 'Close diff' })).toBeVisible({ timeout: 30_000 });
    await expect(failure).toHaveCount(0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/** The hub "was upgraded": its index.html now names another entry bundle. */
async function routeUpgradedShell(page: Page, shellFetches: string[]): Promise<void> {
  await page.route('**/index.html', async (route) => {
    shellFetches.push(route.request().url());
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /\/assets\/main-[\w-]+\.js/,
      '/assets/main-upgraded0.js'
    );
    await route.fulfill({ response, body });
  });
}

test('after a hub upgrade the page offers one Reload, and never reloads by itself', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const shellFetches: string[] = [];
  let documentLoads = 0;
  // `load` fires per document, where `framenavigated` also counts the router's
  // in-page navigations.
  page.on('load', () => {
    documentLoads += 1;
  });

  await page.route(GITHUB_PANEL_CHUNK, (route) => route.abort('failed'));
  await routeUpgradedShell(page, shellFetches);

  await page.goto('/');
  await dismissWorkdirPicker(page);
  await page.getByTestId('sidebar-new-chat').click();
  await dismissWorkdirPicker(page);
  const railButton = page.getByRole('button', { name: 'Show GitHub panel' });
  await expect(railButton).toBeVisible({ timeout: 15_000 });
  if ((await railButton.getAttribute('aria-pressed')) !== 'true') await railButton.click();

  const failure = page.getByTestId('lazy-chunk-failure');
  await expect(failure).toHaveAttribute('data-stale-build', 'true', { timeout: 15_000 });
  await expect(failure).toContainText('MangoStudio was updated');
  await expect(failure.getByRole('button')).toHaveCount(0);
  // One Reload for the page, in the notice, not one per failing surface.
  const reload = page.getByRole('button', { name: 'Reload page' });
  await expect(reload).toHaveCount(1);
  await expect(page.getByTestId('stale-build-notice')).toContainText('MangoStudio was updated');
  await expect(page.getByTestId('stale-build-notice')).toContainText('Your message draft is kept');

  // Give a reload loop time to show itself: it would count a second document.
  await page.waitForTimeout(2_000);
  expect(
    documentLoads,
    `expected one document load and no automatic reload | received: ${documentLoads} (shell probes: ${shellFetches.length})`
  ).toBe(1);
  expect(
    shellFetches.length,
    `expected one index.html probe for the page | received: ${shellFetches.length}`
  ).toBeLessThanOrEqual(2);

  await page.unroute('**/index.html');
  await page.unroute(GITHUB_PANEL_CHUNK);
  await reload.click();
  await expect(page.getByTestId('github-panel')).toBeVisible({ timeout: 30_000 });
});

test('after a hub upgrade a tab showing only markdown gets the notice and stops asking for the chunk', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const title = `lazy-markdown-stale-${Date.now()}`;
  await seedChat(page, title, { workdir: tmpdir(), text: 'first **message**' });
  for (const [index, text] of ['second', 'third'].entries()) {
    const chats = (await (await page.request.get('/api/chats')).json()) as {
      id: string;
      title: string;
    }[];
    const chat = chats.find((candidate) => candidate.title === title);
    expect(
      chat,
      `expected the seeded chat | received titles: ${chats.map((c) => c.title).join(', ')}`
    ).toBeDefined();
    await page.request.post('/api/messages', {
      data: {
        id: `${chat?.id}-extra-${index}`,
        chatId: chat?.id,
        role: 'user',
        text,
        timestamp: Date.now() + index + 1,
        interactionMode: 'agent',
      },
    });
  }

  const chunkRequests: string[] = [];
  page.on('request', (request) => {
    if (MARKDOWN_CHUNK.test(request.url())) chunkRequests.push(request.url());
  });
  await page.route(MARKDOWN_CHUNK, (route) => route.abort('failed'));
  await routeUpgradedShell(page, []);
  await openNewestChat(page, title);

  await expect(page.getByTestId('stale-build-notice')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-markdown-fallback="failed"]').first()).toBeVisible();
  // Three rows share one failed attempt.
  expect(
    chunkRequests.length,
    `expected the markdown chunk requested once for three messages | received: ${chunkRequests.length}`
  ).toBe(1);

  // Past the first 1 s backoff a row that mounts again would start a new
  // attempt, unless the build is known to be stale. Leaving the chat and coming
  // back remounts every row, so this is what proves the gate and not just the
  // shared attempt.
  await page.waitForTimeout(1_500);
  await page.getByTestId('sidebar-new-chat').click();
  await dismissWorkdirPicker(page, 2_000);
  await page.getByRole('button', { name: title }).first().click();
  await expect(page.locator('[data-markdown-fallback="failed"]').first()).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(
    chunkRequests.length,
    `expected no new markdown chunk request once the build is stale | received: ${chunkRequests.length}`
  ).toBe(1);
});
