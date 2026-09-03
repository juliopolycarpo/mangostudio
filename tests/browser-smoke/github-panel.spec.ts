import { expect, test } from '@playwright/test';
import { dismissWorkdirPicker } from './support/workdir-picker';

test('github rail panel renders and obeys its visibility setting', async ({ page }) => {
  // A cold `gh` call on the runtime costs more than the 30s project default, so
  // the per-step waits below fail on their own assertion rather than dying of
  // the suite timeout.
  test.setTimeout(90_000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  // The session comes from the suite's shared `storageState`, so this opens
  // straight onto the authenticated shell.
  await page.goto('/');

  // A chat with no working directory opens the folder picker by itself, and it
  // is a modal that swallows the clicks below. The landing may already have
  // opened a chat — and its picker — before this spec ran, so dismiss whatever
  // is up before reaching for "New Chat" as well as after it.
  await dismissWorkdirPicker(page);

  // The rail only exists on the chat surface and only once a chat does.
  // Scoped to `main` because the sidebar carries a second button with the same
  // label, and an unscoped locator is a strict-mode violation that would kill
  // the spec before it reaches the panel. The chat header is a plain element
  // rather than a <header>, so it has no `banner` role to scope to.
  await page.getByRole('main').getByRole('button', { name: 'New Chat' }).click();

  // The new chat brings a picker of its own. Dismissing it is also what sets up
  // the one deterministic assertion further down: the chat stays unbound, so
  // "This repo" has nothing to ask GitHub about.
  await dismissWorkdirPicker(page);

  const railButton = page.getByRole('button', { name: 'Show GitHub panel' });
  await expect(railButton).toBeVisible({ timeout: 15_000 });
  // The rail remembers which panel was open, so this one may already be it —
  // and clicking then would close the panel the assertions below need.
  if ((await railButton.getAttribute('aria-pressed')) !== 'true') await railButton.click();

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
  //
  // Navigated in-app rather than with `goto`. Every full load re-bootstraps the
  // shell — session, settings, chats, environments, agents — and the API's
  // `general` bucket is 100 requests a minute *per IP*, which on CI is one IP
  // for the whole suite. This spec was the sixth to sign up and pushed the
  // suite over it, and the spec that ran next died on "too many requests"
  // looking like its own feature had broken. Client-side navigation costs a
  // route's queries instead of an application's.
  //
  // `GeneralSettingsRoute` renders straight from `app.settings.workspaceSettings`,
  // which serves the hook's defaults until the read resolves — so the checkbox
  // exists with a made-up value before the real one arrives, and the state below
  // is read rather than assumed. Armed before the click and tolerant of never
  // firing: an in-app navigation is usually served from the query cache, and no
  // request at all means the settings were already settled.
  const settingsRead = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'GET' && response.url().includes('/api/settings/app'),
      { timeout: 5_000 }
    )
    .catch(() => undefined);
  await page.getByRole('complementary').getByRole('button', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings/, { timeout: 15_000 });

  const toggle = page.getByRole('checkbox', { name: 'Show GitHub', exact: true });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await settingsRead;

  /**
   * `click` rather than `check`/`uncheck`: those verify the new state
   * themselves, on the action timeout, and report a race against the debounced
   * write as an unhelpful "did not change its state". The explicit assertion
   * here says which half failed. The write also has to reach the server before
   * the navigation that follows, or the chat surface re-reads the old settings.
   */
  const setPanelVisible = async (visible: boolean) => {
    if ((await toggle.isChecked()) === visible) return;
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().includes('/api/settings/app')
    );
    await toggle.click();
    await expect(toggle).toBeChecked({ checked: visible, timeout: 10_000 });
    await saved;
  };

  // The account is shared by the whole suite and survives a retry, so this spec
  // cannot assume it starts from the default. Asserting `toBeChecked` here
  // instead would fail every CI retry of a run that got past the toggle below.
  await setPanelVisible(true);
  await setPanelVisible(false);

  // Back to the chat in-app, for the same budget reason as above. The rail
  // re-derives its panels from the settings the toggle just wrote, and those
  // went through `normalizeWorkspaceSettings` on the way in — so a normalizer
  // that backfilled a panel the user had explicitly hidden would put the icon
  // straight back here, which is the regression this assertion exists for.
  await page.getByRole('navigation', { name: 'Chats' }).getByRole('button').first().click();

  // Assert we are actually back on the chat surface before asserting an absence.
  // This chat has no folder and no todos, so `git` and `todos` are unavailable
  // regardless — GitHub was the only panel the rail could offer it. That makes
  // "no GitHub button" true on every other route in the app too, and an absence
  // assertion that holds everywhere proves nothing.
  await expect(page.getByRole('textbox', { name: /Ask the AI model anything/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('github-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show GitHub panel' })).toHaveCount(0);

  expect(consoleErrors).toEqual([]);
});
