import { tmpdir } from 'node:os';
import { expect, type Page, test } from '@playwright/test';

/**
 * The narrowest title the row may leave, in CSS pixels. Well under the ~167 px
 * the title has with no metadata at all, and well over the 0 px the regression
 * produced: it is the line between "a few characters and an ellipsis" and
 * "nothing to tell this chat from the next one".
 */
const MIN_VISIBLE_TITLE_PX = 56;

const CHAT_TITLE = 'Sidebar title width regression chat';
// Long enough to fill the badge's own cap, so the metadata is as wide as it gets.
const LONG_BRANCH = 'feature/sidebar-metadata-must-not-hide-the-chat-title';

interface SidebarRow {
  readonly chatId: string;
  readonly row: ReturnType<Page['locator']>;
}

/**
 * Creates a chat bound to a working directory — the only kind the shell asks
 * Git about — and answers the batched Git summary for it with a long branch, a
 * dirty tree and upstream drift, which is the widest badge the row can carry.
 * The runner badge needs no setup: every chat has one.
 */
async function openRowWithWideMetadata(page: Page): Promise<SidebarRow> {
  const created = await page.request.post('/api/chats', { data: { title: CHAT_TITLE } });
  expect(created.ok(), `expected chat create: 2xx | received: ${created.status()}`).toBe(true);
  const { id: chatId } = (await created.json()) as { id: string };

  const bound = await page.request.put(`/api/chats/${chatId}`, { data: { workdir: tmpdir() } });
  expect(bound.ok(), `expected workdir bind: 2xx | received: ${bound.status()}`).toBe(true);

  await page.route('**/api/git/state/batch', async (route) => {
    await route.fulfill({
      json: {
        states: {
          [chatId]: {
            branch: LONG_BRANCH,
            ahead: 12,
            behind: 34,
            changedFileCount: 56,
            workdir: tmpdir(),
          },
        },
      },
    });
  });

  await page.goto('/');
  const row = page
    .getByRole('navigation', { name: 'Chats' })
    .getByRole('listitem')
    .filter({
      has: page.getByTitle(CHAT_TITLE, { exact: true }),
    });
  await expect(row.getByTestId('git-summary-badge')).toBeVisible({ timeout: 15_000 });
  // The hover state swaps the badge for the row actions; keep the pointer off the row.
  await page.mouse.move(900, 600);
  return { chatId, row };
}

async function titleWidth({ row }: SidebarRow): Promise<number> {
  const box = await row.getByTitle(CHAT_TITLE, { exact: true }).boundingBox();
  return box?.width ?? 0;
}

async function expectTitleVisible(sidebar: SidebarRow, width: number): Promise<void> {
  const received = Math.round(await titleWidth(sidebar));
  expect(
    received,
    `expected title width: > 0 px | received: ${received} px (sidebar ${width} px)`
  ).toBeGreaterThan(0);
  expect(
    received,
    `expected title width: >= ${MIN_VISIBLE_TITLE_PX} px | received: ${received} px (sidebar ${width} px)`
  ).toBeGreaterThanOrEqual(MIN_VISIBLE_TITLE_PX);
}

test('chat title stays visible beside a long Git branch and the runner badge', async ({
  page,
}, testInfo) => {
  const { chatId, row } = await openRowWithWideMetadata(page);
  const sidebar = { chatId, row };
  const handle = page.getByRole('separator', { name: 'Resize chat sidebar' });

  /** Home is the 240 px minimum and one arrow step is 16 px: 256 px, the default. */
  const useDefaultWidth = async () => {
    await handle.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '256');
  };

  try {
    // The width is a saved setting of the suite's shared account, so a retry
    // does not start from the default unless this puts it there.
    await useDefaultWidth();
    await expectTitleVisible(sidebar, 256);
    await testInfo.attach('row-default-width', {
      body: await row.screenshot(),
      contentType: 'image/png',
    });

    // The narrowest the sidebar goes.
    await page.keyboard.press('Home');
    await expect(handle).toHaveAttribute('aria-valuenow', '240');
    await expectTitleVisible(sidebar, 240);
    await testInfo.attach('row-minimum-width', {
      body: await row.screenshot(),
      contentType: 'image/png',
    });

    // Widening gives the title room back.
    const minimum = await titleWidth(sidebar);
    await page.keyboard.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', '420');
    const maximum = await titleWidth(sidebar);
    expect(
      maximum,
      `expected title width at 420 px: > ${minimum} px (its 240 px width) | received: ${maximum} px`
    ).toBeGreaterThan(minimum);

    // Badge content is unchanged: the branch is still in the row, only clipped.
    await expect(row.getByTitle(LONG_BRANCH, { exact: true })).toHaveText(LONG_BRANCH);
  } finally {
    await useDefaultWidth();
    await page.request.delete(`/api/chats/${chatId}`);
  }
});
