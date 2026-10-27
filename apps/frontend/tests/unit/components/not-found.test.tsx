import { describe, expect, it } from 'bun:test';

import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';

import { NotFound } from '../../../src/components/layout/NotFound';
import { act, render, screen } from '../../support/harness/render';

/**
 * An address no route owns, through a real router: what matters is that the
 * root's `notFoundComponent` stands in for the whole page and that its way out
 * is a link, not that the component renders on its own.
 */
async function renderUnmatched(path: string) {
  const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFound });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unregistered test-only route tree
  render(<RouterProvider router={router as any} />);
  await act(async () => {
    await router.load();
  });
}

describe('NotFound', () => {
  it('says what is missing and offers the way back', async () => {
    await renderUnmatched('/no/such/page');

    expect(await screen.findByTestId('not-found')).toBeInTheDocument();
    expect(screen.getByText('Page not found')).toBeInTheDocument();
    const back = screen.getByRole('link', { name: 'Back to MangoStudio' });
    expect(back).toHaveAttribute('href', '/');
  });

  it("is the bootstrap failure page's anatomy: the logo, then a title-size heading in a card", async () => {
    await renderUnmatched('/no/such/page');

    const page = await screen.findByTestId('not-found');
    // There is no shell on this page to name the product, so the page does.
    expect(page.querySelector('img')).toHaveAttribute('alt', 'MangoStudio logo');
    const heading = screen.getByRole('heading', { level: 1, name: 'Page not found' });
    expect(heading).toHaveClass('text-title', 'font-semibold', 'text-fg');
    expect(heading.closest('.bg-surface')).not.toBeNull();
  });
});
