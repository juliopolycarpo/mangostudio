import { expect, test } from '@playwright/test';
import { dismissWorkdirPicker } from './support/workdir-picker';

/**
 * Opens the Terminal rail panel on a fresh chat, starts a session on the Local
 * runtime and runs a command whose output the shell has to compute. WebGL may
 * be unavailable headless; the DOM renderer must still draw the text.
 */
test('typing in the terminal panel runs a real command', async ({ page }) => {
  // A cold shell spawn plus the socket round-trip costs more than the 30s
  // project default, the same reasoning as the GitHub panel spec's budget.
  test.setTimeout(90_000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  // The session comes from the suite's shared `storageState`, so this opens
  // straight onto the authenticated shell.
  await page.goto('/');

  // This spec runs first in the suite, so it meets the account's very first
  // landing, where the app opens a chat and its folder picker on its own.
  await dismissWorkdirPicker(page);

  // The rail only exists on the chat surface; open a chat when the landing
  // did not already do so. Scoped to `main` because the sidebar carries a
  // second button with the same label.
  const railButton = page.getByRole('button', { name: 'Show Terminal panel' });
  if (!(await railButton.isVisible())) {
    await page.getByRole('main').getByRole('button', { name: 'New Chat' }).click();
    await dismissWorkdirPicker(page);
  }
  await expect(railButton).toBeVisible({ timeout: 15_000 });
  // The rail remembers which panel was open, so this one may already be it —
  // and clicking then would close the panel the assertions below need.
  if ((await railButton.getAttribute('aria-pressed')) !== 'true') await railButton.click();

  // A fresh chat has no session yet: the panel opens on its empty state with
  // the button that opens one.
  const newSession = page.getByRole('button', { name: 'New terminal' });
  await expect(newSession).toBeVisible({ timeout: 15_000 });
  await newSession.click();

  const terminal = page.getByTestId('terminal-view');
  await expect(terminal).toBeVisible({ timeout: 15_000 });

  // Focuses the xterm surface before typing, the same as a click would.
  await terminal.click();
  // The shell has to compute the marker: the typed command echoes back on the
  // same screen, so asserting on a literal would pass before anything ran.
  await page.keyboard.type('echo MANGO_$((20+3))');
  await page.keyboard.press('Enter');

  await expect(terminal).toContainText('MANGO_23', { timeout: 15_000 });

  expect(consoleErrors).toEqual([]);
});
