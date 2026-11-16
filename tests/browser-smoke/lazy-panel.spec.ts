import { expect, test } from '@playwright/test';

import { dismissWorkdirPicker } from './support/workdir-picker';

/**
 * The rail loads a panel's body the first time it is shown. When that chunk
 * cannot be fetched (offline, or the hub was upgraded under an open tab and no
 * longer has the hashed name), the failure has to stay inside the rail: the
 * chat around it keeps working, and Retry goes back to the network.
 */
const GITHUB_PANEL_CHUNK = /\/assets\/chunk-GithubPanel-[^/]*\.js$/;

test('a rail panel whose chunk cannot be fetched fails inside the rail and recovers on retry', async ({
  page,
}) => {
  test.setTimeout(90_000);

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const blockedRequests: string[] = [];
  await page.route(GITHUB_PANEL_CHUNK, (route) => {
    blockedRequests.push(route.request().url());
    return route.abort('failed');
  });

  await page.goto('/');
  await dismissWorkdirPicker(page);
  await page.getByTestId('sidebar-new-chat').click();
  // An unbound chat offers no Git panel, so GitHub is the rail's first panel.
  await dismissWorkdirPicker(page);

  const railButton = page.getByRole('button', { name: 'Show GitHub panel' });
  await expect(railButton).toBeVisible({ timeout: 15_000 });
  if ((await railButton.getAttribute('aria-pressed')) !== 'true') await railButton.click();

  const failure = page.getByTestId('lazy-chunk-failure');
  await expect(failure, 'expected the rail to name the failed panel load').toBeVisible({
    timeout: 15_000,
  });
  expect(
    blockedRequests.length,
    `expected the GitHub panel chunk to be requested: >= 1 | received: ${blockedRequests.length}`
  ).toBeGreaterThanOrEqual(1);

  // The failure is local: the rest of the chat surface is still drawn and answers.
  await expect(page.getByTestId('sidebar-new-chat')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show Terminal panel' })).toBeEnabled();

  await page.unroute(GITHUB_PANEL_CHUNK);
  await failure.getByRole('button', { name: 'Retry' }).click();

  await expect(page.getByTestId('github-panel')).toBeVisible({ timeout: 30_000 });
  await expect(failure).toHaveCount(0);
  expect(
    pageErrors,
    `expected no uncaught page errors | received: ${pageErrors.join('; ')}`
  ).toEqual([]);
});

test('choosing a panel whose chunk is slow keeps the current panel up and marks the button busy', async ({
  page,
}) => {
  test.setTimeout(90_000);

  // The GitHub chunk is held until the test lets it through.
  let releaseChunk: () => void = () => undefined;
  const chunkGate = new Promise<void>((resolve) => {
    releaseChunk = resolve;
  });
  await page.route(GITHUB_PANEL_CHUNK, async (route) => {
    await chunkGate;
    await route.continue();
  });

  await page.goto('/');
  await dismissWorkdirPicker(page);
  await page.getByTestId('sidebar-new-chat').click();
  await dismissWorkdirPicker(page);

  // An unbound chat opens on GitHub, whose body is held: the rail shows its
  // spinner. Terminal's rail panel is part of the entry, so it shows at once.
  const terminalButton = page.getByRole('button', { name: 'Show Terminal panel' });
  await expect(terminalButton).toBeVisible({ timeout: 15_000 });
  await terminalButton.click();
  await expect(terminalButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'New terminal' })).toBeVisible();

  const githubButton = page.getByRole('button', { name: 'Show GitHub panel' });
  await githubButton.click();

  // The dock moved at once; the body has not, so the terminal stays and the
  // button says it is busy, with no spinner flashed over the panel.
  await expect(githubButton).toHaveAttribute('aria-pressed', 'true');
  await expect(githubButton).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'New terminal' })).toBeVisible();
  await expect(page.getByTestId('github-panel')).toHaveCount(0);

  releaseChunk();
  await expect(page.getByTestId('github-panel')).toBeVisible({ timeout: 30_000 });
  await expect(githubButton).toHaveAttribute('aria-busy', 'false');
});
