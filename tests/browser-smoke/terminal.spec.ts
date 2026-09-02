import { expect, test } from '@playwright/test';

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

  // A chat on an account with no default working directory opens the folder
  // picker by itself, and it is a modal: its header swallows every click
  // underneath, including the one on "New Chat". Dismiss it wherever it shows
  // up — this spec runs first in the suite, so it also meets the account's
  // very first landing, where the app opens a chat and the picker on its own.
  const workdirPicker = page.getByRole('dialog', { name: 'Working directory' });
  const dismissWorkdirPicker = async (): Promise<void> => {
    const opened = await workdirPicker.waitFor({ state: 'visible', timeout: 5_000 }).then(
      () => true,
      () => false
    );
    if (!opened) return;
    await page.keyboard.press('Escape');
    await expect(workdirPicker).toBeHidden({ timeout: 10_000 });
  };
  await dismissWorkdirPicker();

  // The rail only exists on the chat surface; open a chat when the landing
  // did not already do so. Scoped to `main` because the sidebar carries a
  // second button with the same label.
  const railButton = page.getByRole('button', { name: 'Show Terminal panel' });
  if (!(await railButton.isVisible())) {
    await page.getByRole('main').getByRole('button', { name: 'New Chat' }).click();
    await dismissWorkdirPicker();
  }
  await expect(railButton).toBeVisible({ timeout: 15_000 });
  await railButton.click();

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
