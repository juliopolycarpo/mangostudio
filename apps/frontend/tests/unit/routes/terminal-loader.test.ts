/**
 * The `/terminal` route's search validation and prefetch loader.
 *
 * `terminalAvailabilityQueryOptions`/`terminalSessionsQueryOptions` are
 * mocked with a counting fetcher rather than a real one, on the same
 * reasoning as `studio-loader.test.ts`: what is worth asserting here is which
 * environment id the loader prefetched with, not the query's own plumbing —
 * that already has its own coverage in `terminal-service.test.ts`.
 */

import { describe, expect, it, mock } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { QueryClient } from '@tanstack/react-query';

const requests: string[] = [];

function fakeQueryOptions(kind: 'availability' | 'sessions', environmentId: string) {
  return {
    queryKey: ['terminals', kind, environmentId] as const,
    queryFn: () => {
      requests.push(`${kind}:${environmentId}`);
      return Promise.resolve(null);
    },
  };
}

// Before the route is imported, never after: a static import binds the
// loader to the real HTTP-backed query options.
mock.module('../../../src/features/terminal/services/terminal-service', () => ({
  terminalAvailabilityQueryOptions: (environmentId: string) =>
    fakeQueryOptions('availability', environmentId),
  terminalSessionsQueryOptions: (environmentId: string) =>
    fakeQueryOptions('sessions', environmentId),
}));

const { Route: TerminalRoute } = await import('../../../src/routes/_authenticated/terminal');

interface EnvironmentSearch {
  readonly environmentId?: string;
}

type RouteOptions = {
  readonly validateSearch: (raw: Record<string, unknown>) => EnvironmentSearch;
  readonly loaderDeps: (ctx: { search: EnvironmentSearch }) => { environmentId: string };
  readonly loader: (ctx: {
    context: { queryClient: QueryClient };
    deps: { environmentId: string };
  }) => unknown;
};

const options = (TerminalRoute as unknown as { options: RouteOptions }).options;

/**
 * The loader itself is fire-and-forget (`void queryClient.prefetchQuery(...)`,
 * never returned) so a slow probe cannot stall navigation — the same choice
 * `environments/runtimes.tsx`'s loader makes. That means calling it resolves
 * before the prefetch's queryFn necessarily has, so assertions need one real
 * tick for the fetch this queues to actually run.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('/terminal route search', () => {
  it('defaults to no environment id when the search carries none', () => {
    expect(options.validateSearch({})).toEqual({});
  });

  it('keeps an explicit environment id', () => {
    expect(options.validateSearch({ environmentId: 'env-wsl' })).toEqual({
      environmentId: 'env-wsl',
    });
  });

  it('falls back to the local environment id in loaderDeps', () => {
    expect(options.loaderDeps({ search: {} })).toEqual({ environmentId: LOCAL_ENVIRONMENT_ID });
    expect(options.loaderDeps({ search: { environmentId: 'env-wsl' } })).toEqual({
      environmentId: 'env-wsl',
    });
  });
});

describe('/terminal route loader', () => {
  it('prefetches availability and the session list for the resolved environment', async () => {
    requests.length = 0;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await options.loader({ context: { queryClient }, deps: { environmentId: 'env-wsl' } });
    await flushMicrotasks();

    expect(requests.sort()).toEqual(['availability:env-wsl', 'sessions:env-wsl']);
  });

  it('prefetches the local environment when the loader deps say so', async () => {
    requests.length = 0;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await options.loader({
      context: { queryClient },
      deps: { environmentId: LOCAL_ENVIRONMENT_ID },
    });
    await flushMicrotasks();

    expect(requests.sort()).toEqual([
      `availability:${LOCAL_ENVIRONMENT_ID}`,
      `sessions:${LOCAL_ENVIRONMENT_ID}`,
    ]);
  });
});
