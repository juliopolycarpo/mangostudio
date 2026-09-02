/**
 * Dismissing the working-directory picker, which is modal and therefore in the
 * way of every click underneath it.
 */

import { expect, type Page } from '@playwright/test';

/**
 * Closes the folder picker if it is open, and does nothing if it is not.
 *
 * A chat with no working directory opens it by itself (see
 * `use-runner-selection`), so one flow can meet it more than once: the landing
 * opens a chat, "New Chat" opens another, and each brings its own picker. The
 * one that is still up when a spec reaches the rail covers it — the failure
 * reads as a click timing out on a button Playwright can see, with the modal's
 * `<header>` named as what intercepts the pointer events. So this is called
 * wherever a picker may have appeared rather than once at a fixed point.
 *
 * @example
 * await dismissWorkdirPicker(page);
 */
export async function dismissWorkdirPicker(page: Page, timeoutMs = 5_000): Promise<void> {
  const picker = page.getByRole('dialog', { name: 'Working directory' });
  const opened = await picker.waitFor({ state: 'visible', timeout: timeoutMs }).then(
    () => true,
    () => false
  );
  if (!opened) return;
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden({ timeout: 10_000 });
}
