import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { observeMotionNodes, readMotionObservations } from './support/motion-observer';

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
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
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
      expect(errors).toEqual([]);
    });
  });
}
