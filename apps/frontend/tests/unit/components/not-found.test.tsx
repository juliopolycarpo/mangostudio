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
  // biome-ignore lint/suspicious/noExplicitAny: unregistered test-only route tree
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
});
