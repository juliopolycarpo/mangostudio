import { expect, test } from '@playwright/test';

test('environments surface renders its runtime cards', async ({ page }) => {
  // Three cold probes and the cold library scan the overview's snapshot
  // triggers budget more than the 30s project default, so the per-step waits
  // below would die of the suite timeout rather than their own — reporting a
  // timeout instead of the assertion that actually failed.
  test.setTimeout(120_000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  // The surface is behind the auth guard; the session comes from the suite's
  // shared `storageState`, so there is no signup to pay for here.

  await page.goto('/environments');

  // The umbrella lands on its own overview; it no longer forwards to a tab.
  await expect(page).toHaveURL(/\/environments$/, { timeout: 10_000 });

  // Every section renders its own frame before its data arrives, so all four
  // are present immediately — a missing one means a section threw, not that a
  // probe is slow.
  await expect(page.getByTestId('overview-agents')).toBeVisible();
  await expect(page.getByTestId('overview-toolchains')).toBeVisible();
  await expect(page.getByTestId('overview-health')).toBeVisible();
  await expect(page.getByTestId('overview-library')).toBeVisible();

  await expect(page.getByTestId('overview-agent-card').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('overview-toolchain-card').first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('health-rollup')).toBeVisible({ timeout: 15_000 });

  // Each tab name repeats inside the overview as an "Open <tab>" section link,
  // so tab navigation is driven from the strip that owns those tabs.
  const tabs = page.getByRole('navigation', { name: 'Environments' });

  await tabs.getByRole('link', { name: 'Toolchains' }).click();
  await expect(page).toHaveURL(/\/environments\/runtimes$/);
  await expect(page.getByTestId('runtime-card').first()).toBeVisible({ timeout: 15_000 });

  await tabs.getByRole('link', { name: 'Health' }).click();
  await expect(page).toHaveURL(/\/environments\/health/);

  await tabs.getByRole('link', { name: 'Agents' }).click();
  await expect(page).toHaveURL(/\/environments\/agents/);
  await expect(page.getByTestId('agent-cli-card').first()).toBeVisible({ timeout: 15_000 });

  // The library is a section of this umbrella, so its tab has to reach it from
  // here and the relabelled first tab has to lead back.
  await tabs.getByRole('link', { name: 'Library' }).click();
  await expect(page).toHaveURL(/\/environments\/library\/skills$/, { timeout: 10_000 });

  await tabs.getByRole('link', { name: 'Toolchains' }).click();
  await expect(page).toHaveURL(/\/environments\/runtimes$/);

  expect(consoleErrors).toEqual([]);
});
