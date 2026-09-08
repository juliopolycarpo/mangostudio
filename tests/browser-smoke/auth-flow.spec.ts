import { expect, test } from '@playwright/test';

const uniqueEmail = () => `smoke-${Date.now()}@test.local`;

// The suite shares one signed-in account so it stays inside the API's per-IP
// rate limit. This file is the exception on purpose: signing up, logging out
// and logging back in cannot start from a session that already exists.
test.use({ storageState: { cookies: [], origins: [] } });

test('login page renders', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator('form#login-form')).toBeVisible();
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('#password')).toBeVisible();
});

test('signup page renders', async ({ page }) => {
  await page.goto('/signup');
  await expect(page).toHaveURL(/\/signup/);
  await expect(page.locator('form#signup-form')).toBeVisible();
  await expect(page.locator('#name')).toBeVisible();
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('#password')).toBeVisible();
});

test('signup → authenticated landing → logout → login', async ({ page }) => {
  const email = uniqueEmail();
  const password = 'smoke-pass-123';
  const name = 'Smoke User';

  // Sign up
  await page.goto('/signup');
  await page.locator('#name').fill(name);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('form#signup-form button[type="submit"]').click();

  // After signup lands in authenticated area (not redirected to login)
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
  await expect(page).not.toHaveURL(/\/signup/);

  // Logout
  await page.getByTestId('logout-button').click();

  // After logout redirected to login
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

  // Log back in
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('form#login-form button[type="submit"]').click();

  // Lands back in authenticated area
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
});

test('signup lands in first-run setup, resumes on reload, and skipping reaches the app', async ({
  page,
}) => {
  const email = uniqueEmail();
  const password = 'smoke-pass-123';

  await page.goto('/signup');
  await page.locator('#name').fill('Setup User');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('form#signup-form button[type="submit"]').click();

  // A brand-new account has nothing configured, so it is sent to setup with the
  // page it was heading for kept in the URL.
  await expect(page).toHaveURL(/\/welcome/, { timeout: 10_000 });
  await expect(page.getByTestId('onboarding-step-welcome')).toBeVisible();

  await page.getByTestId('onboarding-continue').click();
  await expect(page.getByTestId('onboarding-choose-folder')).toBeVisible({ timeout: 10_000 });

  // Progress belongs to the account, not to the tab: a reload comes back to the
  // step the flow had reached rather than to the beginning.
  await page.reload();
  await expect(page.getByTestId('onboarding-choose-folder')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('onboarding-skip-all').click();

  await expect(page).not.toHaveURL(/\/welcome/, { timeout: 10_000 });
  await expect(page.getByTestId('logout-button')).toBeVisible({ timeout: 10_000 });

  // Skipping is not a send: nothing was asked, so no chat exists to answer.
  await expect(page.locator('[data-testid="onboarding-chat-answered"]')).toHaveCount(0);
});
