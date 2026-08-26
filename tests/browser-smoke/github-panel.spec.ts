import { expect, test } from '@playwright/test';

const uniqueEmail = () => `github-panel-smoke-${Date.now()}@test.local`;

test('github rail panel renders and obeys its visibility setting', async ({ page }) => {
  // Signup plus a cold `gh` call on the runtime costs more than the 30s project
  // default, so the per-step waits below fail on their own assertion rather
  // than dying of the suite timeout.
  test.setTimeout(90_000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  // A fresh account every run. Reusing one gets 429'd by Better Auth after a
  // handful of rapid loads, and the shell then falls back to "Something went
  // wrong!" — which reads exactly like a broken panel and is not one.
  await page.goto('/signup');
  await page.locator('#name').fill('GitHub Panel Smoke');
  await page.locator('#email').fill(uniqueEmail());
  await page.locator('#password').fill('smoke-pass-123');
  await page.locator('form#signup-form button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/signup/, { timeout: 10_000 });

  // The rail only exists on the chat surface and only once a chat does.
  // Scoped to the header banner because the sidebar carries a second button
  // with the same label, and an unscoped locator is a strict-mode violation
  // that would kill the spec before it reaches the panel.
  await page.getByRole('banner').getByRole('button', { name: 'New Chat' }).click();

  const railButton = page.getByRole('button', { name: 'Show GitHub panel' });
  await expect(railButton).toBeVisible({ timeout: 15_000 });
  await railButton.click();

  await expect(page.getByTestId('github-panel')).toBeVisible({ timeout: 15_000 });

  // Structure, not state. The review queue is not deterministic: authenticated
  // locally it lists rows, on CI `gh` is absent, and on a fresh account it is
  // empty — three different renders, and asserting any one of them fails
  // somewhere. That both containers exist is the part that is always true.
  await expect(page.getByTestId('github-inbox-section')).toBeVisible();
  await expect(page.getByTestId('github-repo-section')).toBeVisible();

  // The one deterministic state on the panel: a brand-new chat has no folder
  // bound, so "This repo" says so rather than asking GitHub about one.
  await expect(
    page.getByText('Point this chat at a folder to see its pull requests and issues.')
  ).toBeVisible({ timeout: 15_000 });

  // Turning the panel off in settings must remove it from the rail — the
  // cheapest end-to-end proof that the settings normalizer and the registry
  // agree on the panel id.
  await page.goto('/settings/general');
  const toggle = page.getByRole('checkbox', { name: 'Show GitHub', exact: true });
  await expect(toggle).toBeChecked({ timeout: 15_000 });
  // The write has to reach the server before the reload below, or the chat
  // surface re-reads the old settings and the assertion races a round trip.
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().includes('/api/settings/app')
  );
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await saved;

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Show GitHub panel' })).toHaveCount(0, {
    timeout: 15_000,
  });

  expect(consoleErrors).toEqual([]);
});
