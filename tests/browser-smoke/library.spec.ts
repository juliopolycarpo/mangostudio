import { expect, test } from '@playwright/test';

test('library surface renders its coverage matrix', async ({ page }) => {
  // A cold library scan of every enabled location costs more than the 30s
  // project default, so the per-step waits below fail on their own assertion
  // rather than dying of the suite timeout.
  test.setTimeout(90_000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  // The surface is behind the auth guard; the session comes from the suite's
  // shared `storageState`, so there is no signup to pay for here.
  await page.goto('/environments/library');

  // The section index redirects to the skills tab. Anchored, because every one
  // of these paths ends in the pre-move URL and would match a loose pattern
  // while sitting on the redirect instead of the page.
  await expect(page).toHaveURL(/\/environments\/library\/skills$/, { timeout: 10_000 });
  await expect(page.getByTestId('coverage-matrix')).toBeVisible({ timeout: 20_000 });

  // A column per target, whether or not the scan found any rows to fill them.
  for (const target of ['MangoStudio', 'Claude Code', 'Codex', 'Cursor']) {
    await expect(page.getByRole('columnheader', { name: target })).toBeVisible();
  }

  await page.getByRole('link', { name: 'Subagents' }).click();
  await expect(page).toHaveURL(/\/environments\/library\/subagents$/);

  await page.getByRole('link', { name: 'Commands' }).click();
  await expect(page).toHaveURL(/\/environments\/library\/commands$/);
  await expect(page.getByTestId('coverage-matrix')).toBeVisible({ timeout: 20_000 });

  // Every location the scanner could read, and the switch that decides whether
  // it does. A matrix that came back empty is only trustworthy once this page
  // says the directory behind it was actually looked at.
  await page.getByRole('link', { name: 'Locations' }).click();
  await expect(page).toHaveURL(/\/environments\/library\/locations$/);
  await expect(page.getByTestId('location-settings')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('switch').first()).toBeVisible();

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/environments\/library\/settings$/);
  await expect(
    page.getByTestId('settings-comparison').or(page.getByTestId('library-empty'))
  ).toBeVisible({
    timeout: 15_000,
  });

  // The bookmark promise, in a real browser: a pre-move URL still lands on the
  // page it used to name.
  await page.goto('/library/subagents');
  await expect(page).toHaveURL(/\/environments\/library\/subagents$/, { timeout: 10_000 });

  expect(consoleErrors).toEqual([]);
});
