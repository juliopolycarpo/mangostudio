import { expect, test } from '@playwright/test';
import { dismissWorkdirPicker } from './support/workdir-picker';

/**
 * A refused shell request, in a real browser: the model catalog fails, the
 * shell's navigation stays up with the bootstrap panel in place of the page,
 * nothing retries it behind the person's back, and the panel's retry asks for
 * the catalog once and brings the page back.
 *
 * The unit lanes pin the loader and the content region separately; only a
 * browser runs the real router, its intent preloads and every observer the
 * layout mounts at once, which is where an unbounded retry would show up.
 */

const CATALOG = '**/api/settings/models';

test('a refused catalog keeps navigation up and recovers through the retry', async ({ page }) => {
  test.setTimeout(90_000);

  let refuse = true;
  let catalogRequests = 0;
  await page.route(CATALOG, (route) => {
    catalogRequests += 1;
    if (!refuse) return route.continue();
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Catalog unavailable', code: 'INTERNAL' }),
    });
  });

  await page.goto('/');
  const panel = page.getByTestId('bootstrap-error');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('bootstrap-error-failed')).toContainText('the model list');
  await expect(page.getByTestId('composer')).toHaveCount(0);

  // Navigation is the shell's, not the page's: it is still there, and moving
  // with it (hover preloads, then a navigation) does not ask for the catalog
  // again — the panel's retry is the one thing that does.
  const refusedRequests = catalogRequests;
  const gallery = page
    .getByRole('button', { name: 'Gallery', exact: true })
    .filter({ visible: true });
  await gallery.hover();
  await gallery.click();
  await expect(page).toHaveURL(/\/gallery$/, { timeout: 10_000 });
  await expect(panel).toBeVisible();
  expect(
    catalogRequests,
    `expected catalog requests after navigating with it refused: ${refusedRequests} | received: ${catalogRequests}`
  ).toBe(refusedRequests);

  refuse = false;
  await page.getByTestId('bootstrap-error-retry').click();
  await expect(panel).toBeHidden({ timeout: 20_000 });
  expect(
    catalogRequests,
    `expected catalog requests after one retry: ${refusedRequests + 1} | received: ${catalogRequests}`
  ).toBe(refusedRequests + 1);

  await dismissWorkdirPicker(page, 5_000);
  await page.getByRole('button', { name: 'Chat', exact: true }).filter({ visible: true }).click();
  await expect(page.getByTestId('composer')).toBeVisible({ timeout: 20_000 });
});
