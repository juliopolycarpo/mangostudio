import type { GithubInboxResponse } from '@mangostudio/shared/github';
import { expect, test } from '@playwright/test';
import { observeMotionNodes, readMotionObservations } from './support/motion-observer';

const SELECTORS = { card: '[data-testid="home-dashboard"] section' };
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

test('a card arriving after the grid entrance mounts already settled', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
  const initialCards = (await readMotionObservations(page)).filter(
    (entry) => entry.surface === 'card'
  );
  expect(
    initialCards.some((entry) => (entry.samples[0]?.translateY ?? 0) > 0),
    'expected first-paint cards to retain their entrance'
  ).toBe(true);
  releaseInbox();
  const card = page.locator(SELECTORS.card).filter({ hasText: 'Late motion card' });
  await expect(card).toBeVisible();
  const inserted = (await readMotionObservations(page)).find(
    (entry) => entry.label === 'Reviews waiting'
  );
  expect(inserted, 'expected a recorded late GitHub card').toBeDefined();
  expect(inserted?.samples[0]?.opacity).toBe(1);
  expect(inserted?.samples[0]?.translateY).toBe(0);
  await expect(card.getByRole('link', { name: /Late motion card/ })).toHaveAttribute(
    'href',
    LATE_INBOX.items[0]?.url ?? ''
  );
  expect(errors).toEqual([]);
});
