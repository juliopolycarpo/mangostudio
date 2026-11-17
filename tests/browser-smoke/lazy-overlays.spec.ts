import { expect, test } from '@playwright/test';

import { dismissWorkdirPicker } from './support/workdir-picker';

/**
 * The palette, the capability inspector and the MCP menu are chunks that load
 * on use. The page has to stay quiet until then (a chunk fetched on every first
 * load would only move bytes after first paint), and each has to arrive and
 * draw when asked.
 */
const LAZY_OVERLAY_CHUNKS = /\/assets\/chunk-(ConnectedPalette|CapabilityPanel|McpMenuParts)-/;

test('overlay chunks stay unfetched on first load and arrive when used', async ({ page }) => {
  test.setTimeout(90_000);

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const fetchedChunks: string[] = [];
  page.on('request', (request) => {
    if (LAZY_OVERLAY_CHUNKS.test(request.url())) fetchedChunks.push(request.url());
  });

  await page.goto('/');
  const composer = page.getByTestId('composer');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await dismissWorkdirPicker(page, 10_000);
  await page.waitForLoadState('networkidle');
  expect(
    fetchedChunks,
    `expected no overlay chunk on first load | received: ${fetchedChunks.join(', ')}`
  ).toEqual([]);

  // The palette: its chunk arrives with the chord, and it closes on Escape.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden({ timeout: 10_000 });

  // The capability inspector draws its body inside the popover.
  await page.getByRole('button', { name: 'Capabilities' }).click();
  await expect(page.getByText('Active capabilities')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Capabilities' }).click();

  // The MCP menu draws its catalog, or says there is nothing to offer.
  await page.locator('button[title="MCP prompts and resources"]').click();
  await expect(page.locator('p', { hasText: 'MCP prompts and resources' })).toBeVisible({
    timeout: 15_000,
  });
  // Whatever the hub lists, the catalog comes from the lazy chunk.
  await expect
    .poll(() => fetchedChunks.some((url) => url.includes('chunk-McpMenuParts-')), {
      message: 'expected the MCP menu chunk to be requested once the menu opened',
      timeout: 15_000,
    })
    .toBe(true);

  expect(
    pageErrors,
    `expected no uncaught page errors | received: ${pageErrors.join('; ')}`
  ).toEqual([]);
});
