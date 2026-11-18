/**
 * The router's default error boundary. A route whose chunk cannot be fetched
 * must say so in the person's language and offer Retry and Reload; a route that
 * threw for any other reason keeps the router's generic view, because no retry
 * fixes a bug in the route.
 */

import { describe, expect, it, spyOn } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';

import { RouteErrorView } from '../../../src/components/layout/RouteErrorView';
import { router as appRouter } from '../../../src/router';
import { act, render, screen } from '../../support/harness/render';

const CHUNK_FAILURE_MESSAGE = 'Failed to fetch dynamically imported module: /assets/settings-a1.js';

function RouteBody() {
  return <p>route body</p>;
}

/**
 * The network between the tab and a route chunk: every import rejects with
 * `rejection` while `reachable` is false, and resolves once it is true.
 */
interface ChunkNetworkFake {
  reachable: boolean;
  imports: number;
}

/** A router whose one route is lazy, as every real route is, over a chunk the fake network may refuse. */
async function renderLazyRoute(rejection: Error, { reachable }: { reachable: boolean }) {
  const fake: ChunkNetworkFake = { reachable, imports: 0 };
  const rootRoute = createRootRoute({ component: Outlet });
  const lazyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
  }).lazy(() => {
    fake.imports += 1;
    if (!fake.reachable) return Promise.reject(rejection);
    return Promise.resolve({ options: { id: '/', component: RouteBody } } as never);
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([lazyRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    defaultErrorComponent: RouteErrorView,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unregistered test-only route tree
  render(<RouterProvider router={router as any} />);
  await act(async () => {
    await router.load();
  });
  return { fake, router };
}

describe('RouteErrorView', () => {
  it('offers Retry and Reload when a route chunk cannot be fetched', async () => {
    await renderLazyRoute(new TypeError(CHUNK_FAILURE_MESSAGE), { reachable: false });

    expect(await screen.findByText(en.errors.lazyChunk.title)).toBeInTheDocument();
    expect(screen.getByText(en.errors.lazyChunk.hint)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.common.retry })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.errors.lazyChunk.reload })).toBeInTheDocument();
    // The router's own box would be the unstyled fallback this replaces.
    expect(screen.queryByText('Something went wrong!')).toBeNull();
  });

  it('asks the network again on Retry and renders the route once the chunk arrives', async () => {
    const { fake } = await renderLazyRoute(new TypeError(CHUNK_FAILURE_MESSAGE), {
      reachable: false,
    });
    const retry = await screen.findByRole('button', { name: en.common.retry });
    const importsBeforeRetry = fake.imports;
    expect(importsBeforeRetry, 'expected failed imports before Retry').toBeGreaterThan(0);

    // The connection comes back before the click.
    fake.reachable = true;
    await userEvent.setup().click(retry);

    expect(await screen.findByText('route body')).toBeInTheDocument();
    expect(fake.imports, 'expected Retry to request the chunk again').toBeGreaterThan(
      importsBeforeRetry
    );
  });

  it('reloads the page from the Reload action', async () => {
    const reload = spyOn(window.location, 'reload').mockImplementation(() => undefined);
    try {
      await renderLazyRoute(new TypeError(CHUNK_FAILURE_MESSAGE), { reachable: false });

      await userEvent
        .setup()
        .click(await screen.findByRole('button', { name: en.errors.lazyChunk.reload }));

      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      reload.mockRestore();
    }
  });

  it('keeps the router generic view for an error that is not a chunk failure', async () => {
    await renderLazyRoute(new Error('route module threw while evaluating'), { reachable: false });

    expect(await screen.findByText('Something went wrong!')).toBeInTheDocument();
    expect(
      screen.queryByText(en.errors.lazyChunk.title),
      'expected no chunk-failure panel for a plain Error'
    ).toBeNull();
    expect(screen.queryByRole('button', { name: en.errors.lazyChunk.reload })).toBeNull();
  });

  it('is registered as the application router default boundary', () => {
    expect(
      appRouter.options.defaultErrorComponent,
      'expected router.options.defaultErrorComponent: RouteErrorView | received: another component'
    ).toBe(RouteErrorView);
  });
});
