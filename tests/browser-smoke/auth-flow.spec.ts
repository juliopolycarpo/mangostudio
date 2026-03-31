import { test, expect } from '@playwright/test';

const uniqueEmail = () => `smoke-${Date.now()}@test.local`;

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

  // Logout — button text is "Sair"
  await page.getByRole('button', { name: 'Sair' }).click();

  // After logout redirected to login
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

  // Log back in
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('form#login-form button[type="submit"]').click();

  // Lands back in authenticated area
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
});
