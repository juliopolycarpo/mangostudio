/**
 * The library moved under the environments umbrella, so every `/library/*` URL
 * that a user could have bookmarked is now forwarded by one splat stub.
 *
 * Driven through a real router rather than by calling `beforeLoad` directly:
 * the thing worth asserting is the address the browser ends up at, and a stub
 * that forwards the path while dropping the query string looks correct from the
 * inside while stranding exactly the deep links it exists to keep.
 */

import { describe, expect, it } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { Route as LegacyLibraryRoute } from '../../../src/routes/_authenticated/library/$';

type BeforeLoad = (ctx: { location: { href: string } }) => void;

/** The stub's own `beforeLoad`, which a file route keeps in its options bag. */
function beforeLoadOf(route: unknown): BeforeLoad {
  return (route as { options: { beforeLoad: BeforeLoad } }).options.beforeLoad;
}

/**
 * Mounts the stub next to a catch-all standing in for the umbrella and reports
 * where a legacy URL lands. The generated tree cannot be used here — it drags
 * in the authenticated loader and its whole query graph — so the two ends of
 * the redirect are reproduced with the real stub in between.
 */
async function followLegacyUrl(url: string): Promise<string> {
  const rootRoute = createRootRoute({ component: Outlet });
  const legacyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'library/$',
    beforeLoad: beforeLoadOf(LegacyLibraryRoute),
  });
  // Absorbs every destination, so the assertion is about the address built
  // rather than about which umbrella page happens to exist today.
  const umbrellaRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'environments/$',
    component: () => null,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([legacyRoute, umbrellaRoute]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  return router.state.location.href;
}

describe('legacy /library routes', () => {
  // The bare umbrella root has no path segment for the splat to capture, so it
  // is the one case that would 404 if this stub were written as a prefix match
  // over `$` alone.
  it.each([
    ['/library', '/environments/library'],
    ['/library/skills', '/environments/library/skills'],
    ['/library/subagents', '/environments/library/subagents'],
    ['/library/instructions', '/environments/library/instructions'],
    ['/library/settings', '/environments/library/settings'],
    ['/library/backups', '/environments/library/backups'],
  ])('forwards %s to its umbrella sibling', async (from, to) => {
    expect(await followLegacyUrl(from)).toBe(to);
  });

  it('forwards a resource deep link with its key intact', async () => {
    expect(await followLegacyUrl('/library/skill:pdf-export')).toBe(
      '/environments/library/skill:pdf-export'
    );
  });

  it('keeps the environment scope a legacy tab link carried', async () => {
    expect(await followLegacyUrl('/library/skills?environmentId=box-7')).toBe(
      '/environments/library/skills?environmentId=box-7'
    );
  });

  it('keeps a resource deep link pointed at the version comparison', async () => {
    expect(await followLegacyUrl('/library/skill:pdf-export?compare=true')).toBe(
      '/environments/library/skill:pdf-export?compare=true'
    );
  });

  it('keeps the fragment an in-page anchor was bookmarked with', async () => {
    expect(await followLegacyUrl('/library/backups#retention')).toBe(
      '/environments/library/backups#retention'
    );
  });
});
