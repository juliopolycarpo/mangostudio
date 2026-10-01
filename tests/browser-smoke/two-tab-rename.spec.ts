import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { dismissWorkdirPicker } from './support/workdir-picker';

/**
 * A rename in one tab reaches the account's other open tabs by a realtime
 * signal, not by a reload, a reconnect or a poll: the chat list does not poll
 * and window focus does not refetch it (`lib/query-client.ts`), so the signal
 * is the only way a second tab learns of it. This is the browser-level
 * acceptance of the API-level check that `PUT /api/chats/:id` publishes the
 * activity invalidation to the owner's sockets and to nobody else's.
 */

// Generous on purpose: the reload marker and the socket count, not this bound,
// are what tell "the hub signalled the tab" from "the tab started over".
const SYNC_TIMEOUT_MS = 15_000;
const SUBSCRIBE_TIMEOUT_MS = 20_000;
const NO_RELOAD_MARKER = '__twoTabRenameNoReload';
const QUIET_MS = 2_500;
const QUIET_LIMIT_MS = 20_000;
const SMOKE_PASSWORD = 'smoke-pass-123';

/** What a page's realtime socket has done, observed from the outside. */
interface RealtimeProbe {
  /**
   * Resolves once the hub has acknowledged the page's subscription to the
   * activity topic; rejects, naming `label`, after `SUBSCRIBE_TIMEOUT_MS`.
   */
  subscribed(label: string): Promise<void>;
  /** How many realtime sockets the page has opened; a second one is a reconnect. */
  opened(): number;
  /** How many `invalidate` frames for the activity topic have arrived. */
  invalidations(): number;
}

/**
 * Starts watching `page`'s realtime socket. Call before the page navigates,
 * since the socket opens during the first bootstrap.
 *
 * @example
 * const probe = watchRealtime(page);
 * await page.goto('/');
 * await probe.subscribed('first tab');
 */
function watchRealtime(page: Page): RealtimeProbe {
  let received = 0;
  let sockets = 0;
  let ack = false;

  page.on('websocket', (socket) => {
    sockets += 1;
    socket.on('framereceived', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString('utf8');
      if (text.includes('"subscribed"') && text.includes('"activity"')) ack = true;
      if (text.includes('"invalidate"') && text.includes('"activity"')) received += 1;
    });
  });

  return {
    async subscribed(label) {
      const deadline = Date.now() + SUBSCRIBE_TIMEOUT_MS;
      while (!ack) {
        if (Date.now() >= deadline) {
          throw new Error(
            `expected ${label} activity subscription ack within ${SUBSCRIBE_TIMEOUT_MS} ms | received: none (${sockets} socket(s) opened)`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    opened: () => sockets,
    invalidations: () => received,
  };
}

/** The chat-list row whose title is exactly `title`, in the page's sidebar. */
function sidebarRow(page: Page, title: string) {
  return page
    .getByRole('navigation', { name: 'Chats' })
    .getByRole('listitem')
    .filter({ has: page.getByTitle(title, { exact: true }) });
}

/**
 * Signs up an account of the spec's own in a context of its own and finishes
 * its first-run setup, so its pages open on the chat shell rather than on
 * `/welcome`. The suite's shared account is not used: another spec running in
 * parallel (workers are not limited outside CI) would publish activity signals
 * to its sockets, which could satisfy the positive check without the rename.
 */
async function newSignedInContext(browser: Browser, name: string): Promise<BrowserContext> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const signup = await context.request.post('/api/auth/sign-up/email', {
    data: { name, email: `${name}-${Date.now()}@test.local`, password: SMOKE_PASSWORD },
  });
  expect(signup.ok(), `expected second user signup: 2xx | received: ${signup.status()}`).toBe(true);
  const setup = await context.request.put('/api/settings/app', {
    data: {
      profileSettings: {
        default: {
          onboarding: { welcomeAcknowledged: true, skippedSteps: [], completedAt: Date.now() },
        },
      },
    },
  });
  expect(setup.ok(), `expected second user setup: 2xx | received: ${setup.status()}`).toBe(true);
  return context;
}

async function createChat(page: Page, title: string): Promise<string> {
  const created = await page.request.post('/api/chats', { data: { title } });
  expect(created.ok(), `expected chat create: 2xx | received: ${created.status()}`).toBe(true);
  return ((await created.json()) as { id: string }).id;
}

async function openShell(
  page: Page,
  probe: RealtimeProbe,
  title: string,
  label: string
): Promise<void> {
  await page.goto('/');
  await dismissWorkdirPicker(page);
  await expect(sidebarRow(page, title)).toBeVisible({ timeout: 20_000 });
  await probe.subscribed(label);
}

/**
 * Resolves once `read()` has returned the same value for `QUIET_MS`, or throws
 * naming the last value after `QUIET_LIMIT_MS`.
 */
async function untilQuiet(read: () => number): Promise<void> {
  const deadline = Date.now() + QUIET_LIMIT_MS;
  let last = read();
  let since = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const now = read();
    if (now !== last) {
      last = now;
      since = Date.now();
    }
    if (Date.now() - since >= QUIET_MS) return;
  }
  throw new Error(
    `expected activity to go quiet within ${QUIET_LIMIT_MS} ms | received: still changing at ${last}`
  );
}

/** Renames through the sidebar row's own edit control, the way a user does. */
async function renameInSidebar(page: Page, from: string, to: string): Promise<void> {
  const row = sidebarRow(page, from);
  await row.hover();
  await row.getByTitle('Edit title').click();
  // Not scoped to `row`: while the title is being edited the row no longer
  // holds the title span the row is found by.
  const input = page.getByRole('navigation', { name: 'Chats' }).getByRole('textbox', {
    name: 'Edit title',
  });
  await input.fill(to);
  await input.press('Enter');
}

test('a rename in one tab reaches the same user’s other tab, and no other user’s', async ({
  browser,
}) => {
  // Above the sum of the bounded waits below, so a slow runner reaches one of
  // their named failures instead of the generic test timeout.
  test.setTimeout(180_000);
  const stamp = Date.now();
  const ownTitle = `Two-tab rename ${stamp}`;
  const renamedTitle = `Two-tab renamed ${stamp}`;
  const strangerTitle = `Other user chat ${stamp}`;

  const owner = await newSignedInContext(browser, 'rename-owner');
  const first = await owner.newPage();
  const second = await owner.newPage();
  const stranger = await newSignedInContext(browser, 'other-user');
  const strangerPage = await stranger.newPage();
  const probes = {
    first: watchRealtime(first),
    second: watchRealtime(second),
    stranger: watchRealtime(strangerPage),
  };
  const strangerListRequests: string[] = [];
  strangerPage.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/chats')
      strangerListRequests.push(request.method());
  });
  let chatId: string | undefined;
  let strangerChatId: string | undefined;

  try {
    chatId = await createChat(first, ownTitle);
    strangerChatId = await createChat(strangerPage, strangerTitle);

    await openShell(first, probes.first, ownTitle, 'first tab');
    await openShell(second, probes.second, ownTitle, 'second tab');
    await openShell(strangerPage, probes.stranger, strangerTitle, 'other user tab');

    // Every shell is still settling: a landing creates a chat, which signals
    // its account's sockets. Only what arrives after that goes quiet can be
    // credited to — or blamed on — the rename.
    await untilQuiet(
      () =>
        strangerListRequests.length +
        probes.first.invalidations() +
        probes.second.invalidations() +
        probes.stranger.invalidations()
    );
    const strangerRequestsBefore = strangerListRequests.length;
    const before = probes.second.invalidations();
    const socketsBefore = probes.second.opened();
    // A reload would drop this; it is how the spec tells "the hub signalled the
    // tab" from "the tab started over".
    await second.evaluate((marker) => {
      (window as unknown as Record<string, unknown>)[marker] = true;
    }, NO_RELOAD_MARKER);
    const strangerBefore = probes.stranger.invalidations();

    const startedAt = Date.now();
    await renameInSidebar(first, ownTitle, renamedTitle);

    // The second tab was neither reloaded nor reconnected: its sidebar changes
    // because the hub signalled it.
    await expect(
      sidebarRow(second, renamedTitle),
      `expected second tab sidebar: "${renamedTitle}" within ${SYNC_TIMEOUT_MS} ms | received: no such row`
    ).toBeVisible({ timeout: SYNC_TIMEOUT_MS });
    const elapsed = Date.now() - startedAt;
    test.info().annotations.push({ type: 'sync-ms', description: String(elapsed) });
    await expect(sidebarRow(second, ownTitle)).toHaveCount(0);
    const survived = await second.evaluate(
      (marker) => (window as unknown as Record<string, unknown>)[marker] === true,
      NO_RELOAD_MARKER
    );
    expect(
      survived,
      'expected second tab: same document after the rename | received: reloaded'
    ).toBe(true);
    expect(
      probes.second.opened(),
      `expected second tab realtime sockets: ${socketsBefore} (no reconnect) | received: ${probes.second.opened()}`
    ).toBe(socketsBefore);
    expect(
      probes.second.invalidations(),
      'expected second tab: an activity invalidate frame after the rename | received: none'
    ).toBeGreaterThan(before);

    // Give a stray signal to the other account's tab the time the first tab
    // needed, then check it saw nothing: no row for the renamed chat, its own
    // row untouched, and no chat-list refetch.
    await strangerPage.waitForTimeout(Math.max(1_000, elapsed));
    await expect(sidebarRow(strangerPage, strangerTitle)).toHaveCount(1);
    await expect(sidebarRow(strangerPage, renamedTitle)).toHaveCount(0);
    expect(
      strangerListRequests.length,
      `expected other user's chat-list requests after the rename: ${strangerRequestsBefore} (none new) | received: ${strangerListRequests.length}`
    ).toBe(strangerRequestsBefore);
    expect(
      probes.stranger.invalidations(),
      `expected other user's activity invalidate frames after the rename: ${strangerBefore} | received: ${probes.stranger.invalidations()}`
    ).toBe(strangerBefore);

    // The negative checks above only mean something if that tab's socket was
    // alive and listening the whole time. Prove it: a write of the other
    // account's own must reach it.
    const renamedByOwner = await strangerPage.request.put(`/api/chats/${strangerChatId}`, {
      data: { title: `${strangerTitle} (touched)` },
    });
    expect(
      renamedByOwner.ok(),
      `expected other user's own chat update: 2xx | received: ${renamedByOwner.status()}`
    ).toBe(true);
    await expect
      .poll(() => probes.stranger.invalidations(), {
        message: `expected other user's activity invalidate frames after its own update: > ${strangerBefore} | received: none (socket not listening)`,
        timeout: SYNC_TIMEOUT_MS,
      })
      .toBeGreaterThan(strangerBefore);
  } finally {
    const removed = await Promise.all([
      chatId ? first.request.delete(`/api/chats/${chatId}`) : undefined,
      strangerChatId ? strangerPage.request.delete(`/api/chats/${strangerChatId}`) : undefined,
    ]);
    // Soft, so a failed cleanup never hides the failure that led here. The
    // two accounts themselves stay: the hub runs on a throwaway home.
    for (const response of removed) {
      if (response) {
        expect
          .soft(response.ok(), `expected chat cleanup: 2xx | received: ${response.status()}`)
          .toBe(true);
      }
    }
    await stranger.close();
    await owner.close();
  }
});
