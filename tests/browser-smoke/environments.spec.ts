import { expect, test } from '@playwright/test';

const uniqueEmail = () => `env-smoke-${Date.now()}@test.local`;

test('environments surface renders its runtime cards', async ({ page }) => {
  // Signup plus three cold probes budget more than the 30s project default, so
  // the per-step waits below would die of the suite timeout rather than their
  // own — reporting a timeout instead of the assertion that actually failed.
  test.setTimeout(90_000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  // The surface is behind the auth guard, so the smoke run needs an account.
  await page.goto('/signup');
  await page.locator('#name').fill('Env Smoke');
  await page.locator('#email').fill(uniqueEmail());
  await page.locator('#password').fill('smoke-pass-123');
  await page.locator('form#signup-form button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/signup/, { timeout: 10_000 });

  await page.goto('/environments');

  // The index route redirects to the runtimes tab.
  await expect(page).toHaveURL(/\/environments\/runtimes/, { timeout: 10_000 });
  await expect(page.getByTestId('runtime-card').first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole('link', { name: 'Health' }).click();
  await expect(page).toHaveURL(/\/environments\/health/);

  await page.getByRole('link', { name: 'Agents' }).click();
  await expect(page).toHaveURL(/\/environments\/agents/);
  await expect(page.getByTestId('agent-cli-card').first()).toBeVisible({ timeout: 15_000 });

  expect(consoleErrors).toEqual([]);
});
