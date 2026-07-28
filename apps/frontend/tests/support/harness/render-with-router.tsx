/**
 * Renders a component that contains router `Link`s.
 *
 * `Link` reads router context on mount and throws without it, so any component
 * with in-app navigation needs a router around it. This mounts a memory router
 * whose catch-all route renders the tree under test, which keeps a test about a
 * component from turning into a test about routing.
 */

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type React from 'react';
import { act, render } from './render';

export async function renderWithRouter(ui: React.ReactElement, initialPath = '/') {
  const rootRoute = createRootRoute({ component: Outlet });
  const splatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '$',
    component: () => ui,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => ui,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, splatRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  // The test router is deliberately not the app's registered route tree, so its
  // type does not line up with the provider's registered one.
  // biome-ignore lint/suspicious/noExplicitAny: unregistered test-only route tree
  const result = render(<RouterProvider router={router as any} />);
  // The initial load settles router state, so it belongs inside `act` — without
  // it every test using this harness emits an update-not-wrapped warning.
  await act(async () => {
    await router.load();
  });
  return { ...result, router };
}
