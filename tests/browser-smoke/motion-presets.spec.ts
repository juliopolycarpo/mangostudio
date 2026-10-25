import { writeFile } from 'node:fs/promises';
import type { MessagesPage } from '@mangostudio/shared/chat';
import type { GithubInboxResponse } from '@mangostudio/shared/github';
import { expect, type Page, test } from '@playwright/test';
import { observeMotionNodes, readMotionObservations } from './support/motion-observer';

const diagnostics = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  diagnostics.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/LazyMotion|lazy-strict-mode|tree shaking/i.test(message.text())) {
      errors.push(message.text());
    }
  });
});

test.afterEach(({ page }) => {
  expect(
    diagnostics.get(page),
    'expected no uncaught browser errors or strict feature warnings'
  ).toEqual([]);
});

const SELECTORS = {
  route: '[data-testid="route-container"]',
  card: '[data-testid="home-dashboard"] section',
  dialog: '[data-testid="command-palette"]',
};

// The reduced-motion CSS rule uses this near-zero duration to finish keyframes
// and transitions. Motion's own reduced presets have duration zero.
const REDUCED_CSS_DURATION_MS = 0.01;
const ENTRANCE_DURATION_MS = 200;

for (const preference of ['no-preference', 'reduce'] as const) {
  test.describe(`real motion presets with ${preference}`, () => {
    test.use({ reducedMotion: preference });

    test.afterEach(async ({ page }, testInfo) => {
      const path = testInfo.outputPath('motion-observations.json');
      await writeFile(path, JSON.stringify(await readMotionObservations(page), null, 2));
      await testInfo.attach(`motion-${preference}`, {
        path,
        contentType: 'application/json',
      });
    });

    test('route, card grid and dialog settle with the requested motion', async ({ page }) => {
      await page.addInitScript(observeMotionNodes, SELECTORS);
      await page.goto('/home');
      await expect(page.getByTestId('home-dashboard')).toBeVisible();
      await expect.poll(() => page.locator(SELECTORS.card).count()).toBeGreaterThan(1);
      await expect
        .poll(() =>
          page
            .locator(SELECTORS.card)
            .evaluateAll((cards) => cards.every((card) => getComputedStyle(card).opacity === '1'))
        )
        .toBe(true);

      const cards = (await readMotionObservations(page)).filter(
        (entry) => entry.surface === 'card'
      );
      expect(cards.length).toBeGreaterThan(1);
      if (preference === 'no-preference') {
        expect(cards.some((card) => (card.samples[0]?.translateY ?? 0) > 0)).toBe(true);
        expect(
          cards.flatMap((card) => card.samples).flatMap((sample) => sample.animationDurationsMs)
        ).toContain(ENTRANCE_DURATION_MS);
      } else {
        expect(
          cards.flatMap((card) => card.samples).every((sample) => sample.translateY === 0)
        ).toBe(true);
      }

      await page
        .getByRole('button', { name: 'Gallery', exact: true })
        .filter({ visible: true })
        .click();
      await expect(page).toHaveURL(/\/gallery$/);
      await expect
        .poll(() =>
          page.locator(SELECTORS.route).evaluate((element) => getComputedStyle(element).opacity)
        )
        .toBe('1');
      const routes = (await readMotionObservations(page)).filter(
        (entry) => entry.surface === 'route'
      );
      expect(routes[0]?.samples[0]?.opacity).toBe(1);
      expect(routes.some((route) => route.path === '/gallery')).toBe(true);
      if (preference === 'no-preference') {
        expect(routes.find((route) => route.path === '/gallery')?.samples[0]?.opacity).toBeLessThan(
          1
        );
        expect(
          routes
            .find((route) => route.path === '/gallery')
            ?.samples.flatMap((sample) => sample.animationDurationsMs)
        ).toContain(ENTRANCE_DURATION_MS);
      } else {
        expect(
          routes
            .flatMap((route) => route.samples)
            .flatMap((sample) => sample.animationDurationsMs)
            .every((duration) => duration <= REDUCED_CSS_DURATION_MS)
        ).toBe(true);
      }

      await page.getByRole('button', { name: 'Open command palette' }).click();
      const dialog = page.getByTestId('command-palette');
      await expect(dialog).toBeVisible();
      await expect
        .poll(() => dialog.evaluate((element) => getComputedStyle(element).opacity))
        .toBe('1');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect
        .poll(
          async () =>
            (await readMotionObservations(page)).find((entry) => entry.surface === 'dialog')
              ?.removedAtMs
        )
        .toBeDefined();

      const observations = await readMotionObservations(page);
      const panel = observations.find((entry) => entry.surface === 'dialog');
      expect(panel).toBeDefined();
      if (preference === 'no-preference') {
        expect(panel?.samples[0]?.translateY).toBeLessThan(0);
        expect(panel?.samples[0]?.scaleX).toBeLessThan(1);
        expect(panel?.samples.flatMap((sample) => sample.animationDurationsMs)).toContain(
          ENTRANCE_DURATION_MS
        );
      } else {
        expect(
          panel?.samples.every((sample) => sample.translateY === 0 && sample.scaleX === 1)
        ).toBe(true);
        expect(
          panel?.samples
            .flatMap((sample) => sample.animationDurationsMs)
            .every((duration) => duration <= REDUCED_CSS_DURATION_MS)
        ).toBe(true);
      }
    });
  });
}

const LATE_INBOX: GithubInboxResponse = {
  state: 'ok',
  cachedAt: 0,
  items: [
    {
      number: 1,
      title: 'Late motion card',
      url: 'https://github.com/example/project/pull/1',
      state: 'OPEN',
      isDraft: false,
      updatedAt: '2026-01-01T00:00:00Z',
      author: null,
      labels: [],
      repository: { nameWithOwner: 'example/project' },
    },
  ],
};

test('a card arriving after the grid entrance finishes its own entrance', async ({ page }) => {
  let releaseInbox: () => void = () => undefined;
  const inboxReady = new Promise<void>((resolve) => {
    releaseInbox = resolve;
  });
  await page.route('**/api/github/inbox*', async function delayedInbox(route) {
    await inboxReady;
    await route.fulfill({ json: LATE_INBOX });
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(observeMotionNodes, { card: SELECTORS.card });
  await page.goto('/home');
  await expect.poll(() => page.locator(SELECTORS.card).count()).toBeGreaterThan(1);
  await expect
    .poll(() =>
      page
        .locator(SELECTORS.card)
        .evaluateAll((cards) =>
          cards.every(
            (card) =>
              getComputedStyle(card).opacity === '1' && getComputedStyle(card).transform === 'none'
          )
        )
    )
    .toBe(true);
  // Completion, rather than a sleep: all first-paint card animations must settle.
  await expect
    .poll(() =>
      page
        .locator(SELECTORS.card)
        .evaluateAll((cards) =>
          cards.every((card) =>
            card.getAnimations().every((animation) => animation.playState === 'finished')
          )
        )
    )
    .toBe(true);
  await expect
    .poll(async () =>
      (await readMotionObservations(page))
        .filter((entry) => entry.surface === 'card' && entry.removedAtMs === undefined)
        .every((entry) => (entry.samples.at(-1)?.elapsedMs ?? 0) >= 800)
    )
    .toBe(true);
  releaseInbox();
  const card = page.locator(SELECTORS.card).filter({ hasText: 'Late motion card' });
  await expect(card).toBeVisible();
  const inserted = (await readMotionObservations(page)).find(
    (entry) => entry.label === 'Reviews waiting'
  );
  expect(inserted, 'expected a recorded late GitHub card').toBeDefined();
  await expect
    .poll(() =>
      card.evaluate((element) => ({
        opacity: getComputedStyle(element).opacity,
        transform: getComputedStyle(element).transform,
      }))
    )
    .toEqual({ opacity: '1', transform: 'none' });
  await expect(card.getByRole('link', { name: /Late motion card/ })).toHaveAttribute(
    'href',
    LATE_INBOX.items[0]?.url ?? ''
  );
});

test('live reduced motion and restored motion reach the real dialog and preserve focus', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(observeMotionNodes, { dialog: SELECTORS.dialog });
  await page.goto('/home');
  await expect(page.getByTestId('home-dashboard')).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Open command palette' });
  const dialog = page.getByTestId('command-palette');
  for (const reducedMotion of ['reduce', 'no-preference'] as const) {
    await page.emulateMedia({ reducedMotion });
    // Wait for the browser media event to reach useSyncExternalStore before mounting.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    const before = (await readMotionObservations(page)).length;
    await trigger.click();
    await expect(dialog.getByRole('combobox')).toBeFocused();
    await expect
      .poll(() => dialog.evaluate((element) => getComputedStyle(element).opacity))
      .toBe('1');
    const panel = (await readMotionObservations(page)).slice(before)[0];
    expect(panel).toBeDefined();
    if (reducedMotion === 'reduce') {
      expect(panel?.samples.every((sample) => sample.translateY === 0 && sample.scaleX === 1)).toBe(
        true
      );
    } else {
      expect(panel?.samples[0]?.translateY).toBeLessThan(0);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});

test('a real transcript disclosure expands to auto height and finishes its exit', async ({
  page,
}) => {
  const title = `Motion disclosure ${Date.now()}`;
  const created = await page.request.post('/api/chats', { data: { title } });
  expect(created.ok()).toBe(true);
  const { id: chatId } = (await created.json()) as { id: string };
  try {
    const bound = await page.request.put(`/api/chats/${chatId}`, { data: { workdir: '/tmp' } });
    expect(bound.ok()).toBe(true);
    const transcript: MessagesPage = {
      messages: [
        {
          id: `${chatId}-thought`,
          chatId,
          role: 'ai',
          text: 'Answer',
          timestamp: Date.now(),
          parts: [
            { type: 'thinking', text: 'Motion disclosure body' },
            { type: 'text', text: 'Answer' },
          ],
        },
      ],
      nextCursor: null,
    };
    await page.route(`**/api/chats/${chatId}/messages?*`, async function thoughtTranscript(route) {
      await route.fulfill({ json: transcript });
    });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addInitScript(observeMotionNodes, {
      disclosure: '.chat-timeline-item > div:has(> .app-scrollbar > .markdown-content--thinking)',
    });
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Chats' })
      .getByTitle(title, { exact: true })
      .click();
    const toggle = page.getByRole('button', { name: 'Thought', exact: true });
    await expect(toggle).toBeVisible();
    await toggle.click();
    const panel = page.locator('.markdown-content--thinking').locator('..').locator('..');
    await expect(page.getByText('Motion disclosure body')).toBeVisible();
    await expect
      .poll(() => panel.evaluate((element) => (element as HTMLElement).style.height))
      .toBe('auto');
    const expanded = (await readMotionObservations(page)).find(
      (entry) => entry.surface === 'disclosure'
    );
    // The collapsed border-box keeps its two 1px borders.
    expect(expanded?.samples[0]?.height).toBe(2);
    await expect
      .poll(() => panel.evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThan(0);
    await toggle.click();
    await expect(panel).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await readMotionObservations(page)).find((entry) => entry.surface === 'disclosure')
            ?.removedAtMs
      )
      .toBeDefined();
    const collapsed = (await readMotionObservations(page)).find(
      (entry) => entry.surface === 'disclosure'
    );
    expect(collapsed?.removedAtMs).toBeDefined();
    expect(collapsed?.samples.some((sample) => sample.height > 0)).toBe(true);
  } finally {
    const removed = await page.request.delete(`/api/chats/${chatId}`);
    expect(removed.ok()).toBe(true);
  }
});
