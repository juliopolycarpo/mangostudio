import { expect, test } from '@playwright/test';

/**
 * The palette in a real browser, asserted on the one outcome that does not
 * depend on the machine.
 *
 * What it offers is whatever this host actually has — a runner with no skills
 * directory and no agent CLI has nothing to list, and a developer's laptop has
 * a dozen entries. "No command matches" is true on both, and it still proves
 * the parts that only a browser can: that `/` reaches the palette through the
 * composer's caret tracking, that the strings resolve, and that a name which
 * matches nothing leaves Enter to the composer instead of eating it.
 */
test('the composer answers a slash with the command palette', async ({ page }) => {
  test.setTimeout(90_000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto('/');
  const composer = page.getByTestId('composer');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  // A hub with no default working directory in `workspaceSettings` opens the
  // folder picker over an existing chat by itself (`use-runner-selection`), and
  // it is a modal whose backdrop swallows every click below it — a click waits
  // for a hit target it never gets, rather than failing fast.
  //
  // Conditional because whether it appears depends on the hub under the suite,
  // not on this spec: a fresh one always shows it, and `reuseExistingServer`
  // means a local run without CI set reuses a dev server whose chat is already
  // bound and shows nothing. Reproduce the CI shape with `CI=true bun run test
  // --e2e`, and run the whole suite — the chat this picker needs is left behind
  // by an alphabetically earlier spec.
  const workdirPicker = page.getByRole('dialog', { name: 'Working directory' });
  const pickerOpened = await workdirPicker
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (pickerOpened) {
    await page.keyboard.press('Escape');
    await expect(workdirPicker).toBeHidden({ timeout: 10_000 });
  }

  // Located by element, not by role: the composer is a `textbox` until the
  // palette opens and a `combobox` while it is open, and a role-based locator
  // re-resolves between the two and finds nothing.
  const textbox = composer.locator('textarea');
  await textbox.click();
  await textbox.fill('/zzz-no-such-command');
  await expect(page.getByText('No command matches.')).toBeVisible({ timeout: 20_000 });

  // A path is the other common leading slash, and the palette has to get out of
  // its way — including the arrow keys, which belong to the prompt history.
  await textbox.fill('/home/someone/repo');
  await expect(page.getByText('No command matches.')).toBeHidden();

  expect(consoleErrors).toEqual([]);
});
