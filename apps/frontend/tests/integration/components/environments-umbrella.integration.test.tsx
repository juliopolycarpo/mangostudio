/**
 * The library is a section inside the environments umbrella, which means two
 * layouts render at once through a chain of `Outlet`s. This mounts them the way
 * the router nests them and checks the seam: one page heading, two tab strips,
 * and the section landing on the right one of them.
 */

import { describe, expect, it } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { screen, within } from '@testing-library/react';
import type { FunctionComponent } from 'react';
import { Route as EnvironmentsRoute } from '../../../src/routes/_authenticated/environments';
import { Route as LibraryRoute } from '../../../src/routes/_authenticated/environments/library';
import { act, render } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

/** The route's page component, which the file keeps module-local. */
function componentOf(route: unknown): FunctionComponent {
  return (route as { options: { component: FunctionComponent } }).options.component;
}

/**
 * Rebuilds the umbrella's slice of the route tree. The generated tree cannot be
 * mounted here — it drags in the authenticated loader and its whole query graph
 * — so the nesting under test is reproduced with the real page components.
 */
async function renderUmbrellaAt(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const environmentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'environments',
    component: componentOf(EnvironmentsRoute),
  });
  const libraryRoute = createRoute({
    getParentRoute: () => environmentsRoute,
    path: 'library',
    component: componentOf(LibraryRoute),
  });
  const skillsRoute = createRoute({
    getParentRoute: () => libraryRoute,
    path: 'skills',
    component: () => <div data-testid="section-outlet" />,
  });
  // Absorbs the tab links that point outside the slice under test.
  const catchAllRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '$',
    component: Outlet,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([
      environmentsRoute.addChildren([libraryRoute.addChildren([skillsRoute])]),
      catchAllRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });

  // The test router is deliberately not the app's registered route tree, so its
  // type does not line up with the provider's registered one.
  // biome-ignore lint/suspicious/noExplicitAny: unregistered test-only route tree
  const result = render(<RouterProvider router={router as any} />);
  await act(async () => {
    await router.load();
  });
  // `router.load()` settles routing, not the queries the loaded tree starts.
  // `BackupUsage` fetches on mount and renders nothing while it is pending, so
  // there is no element to await — without flushing its promise chain here the
  // resolution lands after the test body and prints an "update was not wrapped
  // in act(...)" block while every assertion still passes.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return result;
}

describe('environments umbrella', () => {
  it('nests the library section under a single page heading', async () => {
    // BackupUsage renders inside the section layout and would otherwise hit the
    // network; the strip itself is covered by its own test.
    createFetchScenario()
      .respondWithJson('GET', '/api/library/propagate/backups', {
        body: { sets: [], sizeBytes: 0, retentionCount: 0, retentionBytes: 0 },
      })
      .install();

    await renderUmbrellaAt('/environments/library/skills');

    // One heading, owned by the umbrella. A section that kept its own would
    // stack two page titles on top of each other.
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Environments');

    const umbrellaTabs = screen.getByRole('navigation', { name: 'Environments' });
    expect(within(umbrellaTabs).getByRole('link', { name: 'Toolchains' })).toHaveAttribute(
      'href',
      '/environments/runtimes'
    );
    expect(within(umbrellaTabs).getByRole('link', { name: 'Library' })).toHaveAttribute(
      'href',
      '/environments/library'
    );

    const sectionTabs = screen.getByRole('navigation', { name: 'Library' });
    expect(within(sectionTabs).getByRole('link', { name: 'Skills' })).toHaveAttribute(
      'href',
      '/environments/library/skills'
    );
    expect(screen.getByTestId('section-outlet')).toBeInTheDocument();
  });

  // Fuzzy matching is what keeps the umbrella tab lit while a nested page is
  // open; an exact-match tab would go dark the moment the section loaded.
  it('keeps the library tab active on a page one level deeper', async () => {
    createFetchScenario()
      .respondWithJson('GET', '/api/library/propagate/backups', {
        body: { sets: [], sizeBytes: 0, retentionCount: 0, retentionBytes: 0 },
      })
      .install();

    await renderUmbrellaAt('/environments/library/skills');

    const umbrellaTabs = screen.getByRole('navigation', { name: 'Environments' });
    expect(within(umbrellaTabs).getByRole('link', { name: 'Library' })).toHaveAttribute(
      'data-status',
      'active'
    );
    expect(within(umbrellaTabs).getByRole('link', { name: 'Toolchains' })).not.toHaveAttribute(
      'data-status',
      'active'
    );
  });
});
