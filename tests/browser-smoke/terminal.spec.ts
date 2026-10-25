import { writeFileSync } from 'node:fs';
import { decodeTerminalClientMessage } from '@mangostudio/shared/terminal';
import { expect, test } from '@playwright/test';
import { dismissWorkdirPicker } from './support/workdir-picker';

/**
 * Opens the Terminal rail panel on a fresh chat, starts a session on the Local
 * runtime and runs a command whose output the shell has to compute. WebGL may
 * be unavailable headless; the DOM renderer must still draw the text.
 */
test('terminal session survives renderer fallback, remounts and pop-out takeover', async ({
  page,
}, testInfo) => {
  // A cold shell spawn plus the socket round-trip costs more than the 30s
  // project default, the same reasoning as the GitHub panel spec's budget.
  test.setTimeout(90_000);

  const consoleErrors: string[] = [];
  const frames: ReturnType<typeof decodeTerminalClientMessage>[] = [];
  let socketConnections = 0;
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/terminal/')) return;
    socketConnections += 1;
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') frames.push(decodeTerminalClientMessage(payload));
    });
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  // The session comes from the suite's shared `storageState`, so this opens
  // straight onto the authenticated shell.
  await page.goto('/');

  // This spec runs first in the suite, so it meets the account's very first
  // landing, where the app opens a chat and its folder picker on its own.
  await dismissWorkdirPicker(page);

  // The rail only exists on the chat surface; open a chat when the landing
  // did not already do so. From `md` up the sidebar carries "New chat" and the
  // header's copy is hidden. By test id, because an untitled chat's row in the
  // sidebar list is a button with the same name.
  const railButton = page.getByRole('button', { name: 'Show Terminal panel' });
  if (!(await railButton.isVisible())) {
    await page.getByTestId('sidebar-new-chat').click();
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

  await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type("printf '\\u4e2d\\U0001f642 cafe\\u0301\\n'");
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('中🙂 café');
  await expect(terminal.locator('.xterm-accessibility')).toHaveCount(1);
  await expect
    .poll(() => frames.some((frame) => frame.type === 'ack' && frame.bytes > 0))
    .toBe(true);
  expect(frames.some((frame) => frame.type === 'data')).toBe(true);
  expect(frames.some((frame) => frame.type === 'resize')).toBe(true);

  const connectionsBeforeLoss = socketConnections;
  const forcedLoss = await terminal.evaluate((element) => {
    const gl = Array.from(element.querySelectorAll('canvas'))
      .map((canvas) => canvas.getContext('webgl2'))
      .find((context) => context !== null);
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    extension.loseContext();
    return true;
  });
  if (forcedLoss) {
    await expect(terminal.locator('.xterm-screen > canvas')).toHaveCount(0, { timeout: 8_000 });
    await expect(terminal.locator('.xterm-rows')).toHaveCount(1);
    await expect(terminal).toContainText('MANGO_23');
    expect(socketConnections, 'renderer fallback must keep the existing terminal socket').toBe(
      connectionsBeforeLoss
    );
  }
  // This also exercises native paste into xterm without a physical IME.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('echo PASTED_$((40+2))'));
  await terminal.click();
  await page.keyboard.press('Control+Shift+V');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('PASTED_42', { timeout: 15_000 });

  // Collapsing unmounts the view; reopening attaches the same server session
  // and replays output rather than keeping a hidden terminal mounted.
  const tabs = page.getByRole('tablist', { name: 'Terminal sessions' });
  const firstTab = tabs.locator('[data-testid^=terminal-tab-]').first();
  const firstId = await firstTab.getAttribute('data-testid');
  await page.getByRole('button', { name: 'Collapse agent side panel', exact: true }).click();
  await expect(terminal).toHaveCount(0);
  await railButton.click();
  await expect(terminal).toContainText('MANGO_23', { timeout: 15_000 });
  await expect(terminal).toHaveCount(1);

  await newSession.click();
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await expect(terminal).toHaveCount(1);
  if (!firstId) throw new Error('expected stable terminal session tab test id');
  await page.getByTestId(firstId).getByRole('tab').click();
  await expect(terminal).toContainText('MANGO_23', { timeout: 15_000 });
  await expect(terminal).toHaveCount(1);

  // A pop-out takes the socket lease. Closing it and taking the lease back
  // must preserve the PTY and its replayed history.
  await page.getByTestId(firstId).hover();
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open in a window', exact: true }).first().click();
  const popup = await popupPromise;
  await expect(popup.getByTestId('terminal-view')).toContainText('MANGO_23', { timeout: 15_000 });
  await expect(page.getByTestId('terminal-replaced-overlay')).toBeVisible();
  await popup.close();
  await page.getByRole('button', { name: 'Bring it here', exact: true }).click();
  await expect(page.getByTestId('terminal-replaced-overlay')).toHaveCount(0);
  await terminal.click();
  await page.keyboard.type('echo REATTACHED_$((30+4))');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('REATTACHED_34', { timeout: 15_000 });
  const receiptPath = testInfo.outputPath('terminal-lifecycle.json');
  writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        browserVersion: page.context().browser()?.version(),
        forcedLoss,
        connectionsBeforeLoss,
        socketConnections,
        ackFrames: frames.filter((frame) => frame.type === 'ack').length,
        resizeFrames: frames.filter((frame) => frame.type === 'resize').length,
        inputFrames: frames.filter((frame) => frame.type === 'data').length,
        consoleErrors,
      },
      null,
      2
    )
  );
  await testInfo.attach('terminal-lifecycle', {
    path: receiptPath,
    contentType: 'application/json',
  });
  expect(consoleErrors).toEqual([]);
});
