import { expect, test } from '@playwright/test';

const uniqueEmail = () => `library-smoke-${Date.now()}@test.local`;

test('library surface renders its coverage matrix', async ({ page }) => {
  // Signup plus a cold library scan of every enabled location costs more than
  // the 30s project default, so the per-step waits below fail on their own
  // assertion rather than dying of the suite timeout.
  test.setTimeout(90_000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  // The surface is behind the auth guard, so the smoke run needs an account.
  await page.goto('/signup');
  await page.locator('#name').fill('Library Smoke');
  await page.locator('#email').fill(uniqueEmail());
  await page.locator('#password').fill('smoke-pass-123');
  await page.locator('form#signup-form button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/signup/, { timeout: 10_000 });

  await page.goto('/library');

  // The index route redirects to the skills tab.
  await expect(page).toHaveURL(/\/library\/skills/, { timeout: 10_000 });
  await expect(page.getByTestId('coverage-matrix')).toBeVisible({ timeout: 20_000 });

  // A column per target, whether or not the scan found any rows to fill them.
  for (const target of ['MangoStudio', 'Claude Code', 'Codex', 'Cursor']) {
    await expect(page.getByRole('columnheader', { name: target })).toBeVisible();
  }

  await page.getByRole('link', { name: 'Subagents' }).click();
  await expect(page).toHaveURL(/\/library\/subagents/);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/library\/settings/);
  await expect(
    page.getByTestId('settings-comparison').or(page.getByTestId('library-empty'))
  ).toBeVisible({
    timeout: 15_000,
  });

  expect(consoleErrors).toEqual([]);
});
