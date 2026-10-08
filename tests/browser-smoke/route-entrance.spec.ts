import { expect, type Page, test } from '@playwright/test';

/**
 * The authenticated layout's route container, in a real browser: the first
 * page appears already settled, and a later move between pages still fades.
 *
 * The unit tests pin what `useRouteEntrance` returns, but the `motion/react`
 * stub drops animation props, so only a browser sees whether the layout
 * actually hands them to the container. Each container is recorded at the
 * moment it enters the DOM, before any frame is painted: `motion` renders
 * `initial` as an inline style on mount, so that is when a fade starts at 0
 * and a settled entrance starts at 1.
 */

type RouteContainerEntry = { path: string; opacity: number };

declare global {
  interface Window {
    __routeContainerEntries?: RouteContainerEntry[];
  }
}

const ROUTE_CONTAINER = '[data-testid="route-container"]';

/** Records every route container's opacity as it is inserted, from the first byte of the page. */
function recordRouteContainerEntries(selector: string): void {
  const entries: RouteContainerEntry[] = [];
  window.__routeContainerEntries = entries;
  const record = (element: Element) => {
    entries.push({
      path: window.location.pathname,
      opacity: Number(getComputedStyle(element).opacity),
    });
  };
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(selector)) record(node);
        for (const nested of node.querySelectorAll(selector)) record(nested);
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });
}

function routeContainerEntries(page: Page): Promise<RouteContainerEntry[]> {
  return page.evaluate(() => window.__routeContainerEntries ?? []);
}

// Pinned rather than inherited: under reduced motion every page enters at
// opacity 1, and the navigation half below would fail for the wrong reason.
test.use({ reducedMotion: 'no-preference' });

test('the first page appears settled and later pages still fade in', async ({ page }) => {
  test.setTimeout(90_000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.addInitScript(recordRouteContainerEntries, ROUTE_CONTAINER);

  // The dashboard has no chat picker to reopen when another smoke spec changes
  // the shared account's active chat. It exercises the same first-page latch.
  await page.goto('/home');
  await expect(page.getByTestId('home-dashboard')).toBeVisible({ timeout: 20_000 });

  const firstLoad = await routeContainerEntries(page);
  expect(
    firstLoad.length,
    `expected route container mounts on first load: >= 1 | received: ${firstLoad.length}`
  ).toBeGreaterThan(0);
  expect(
    firstLoad[0]?.opacity,
    `expected first-load route container opacity: 1 | received: ${firstLoad[0]?.opacity}`
  ).toBe(1);

  // In-app, never `page.goto`: a full load mounts the layout again and takes
  // the first-page path, which is exactly what this half must not measure.
  await page
    .getByRole('button', { name: 'Gallery', exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/gallery$/, { timeout: 10_000 });
  // The URL can move before the lazy page mounts its container.
  await expect
    .poll(async () => (await routeContainerEntries(page)).length, {
      message: `expected route container mounts after navigating: > ${firstLoad.length}`,
      timeout: 10_000,
    })
    .toBeGreaterThan(firstLoad.length);

  // The first container mounted after the click is the gallery's: the
  // container is keyed by top-level page, so nothing else remounts it.
  const [navigated] = (await routeContainerEntries(page)).slice(firstLoad.length);
  expect(
    navigated?.opacity,
    `expected route container opacity after an in-app navigation: < 1 | received: ${JSON.stringify(navigated)}`
  ).toBeLessThan(1);

  expect(consoleErrors).toEqual([]);
});
