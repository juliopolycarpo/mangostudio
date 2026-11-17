import { describe, expect, it } from 'bun:test';

import type { Environment } from '@mangostudio/shared/environments';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

import {
  environmentKeys,
  refetchUnavailableQueriesOnConnect,
} from '@/features/environments/queries';
import {
  invalidateEnvironmentUnavailableQueries,
  queryRetryDelay,
  shouldRetryQuery,
} from '@/lib/environment-unavailable';
import { ApiError } from '@/lib/utils';

function unavailable(reason: string, retryAfterSeconds?: number): ApiError {
  return new ApiError({
    error: 'The environment is unavailable.',
    code: 'ENVIRONMENT_UNAVAILABLE',
    details: {
      reason,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds: String(retryAfterSeconds) }),
    },
  });
}

describe('shouldRetryQuery', () => {
  it('retries an ordinary failure once', () => {
    const failure = new ApiError({ error: 'boom', code: 'INTERNAL' });
    expect(shouldRetryQuery(0, failure)).toBe(true);
    expect(shouldRetryQuery(1, failure)).toBe(false);
  });

  it('retries a provider failure once, since a provider may recover at once', () => {
    expect(shouldRetryQuery(0, new ApiError({ error: 'x', code: 'PROVIDER_ERROR' }))).toBe(true);
  });

  it.each([
    ['stopped-retrying', false],
    ['binary-missing', false],
    ['bound-elsewhere', false],
    ['start-failed', true],
    ['backing-off', true],
    ['unavailable', true],
  ] as const)('first failure with reason %s retries: %p', (reason, retries) => {
    expect(
      shouldRetryQuery(0, unavailable(reason)),
      `(${reason}): expected retry=${retries} on the first failure`
    ).toBe(retries);
  });

  it('retries a transient reason only once', () => {
    expect(shouldRetryQuery(1, unavailable('start-failed'))).toBe(false);
  });

  it('retries an unavailable answer that names no reason once', () => {
    expect(shouldRetryQuery(0, new ApiError({ error: 'x', code: 'ENVIRONMENT_UNAVAILABLE' }))).toBe(
      true
    );
  });
});

describe('queryRetryDelay', () => {
  it("waits as long as the hub's retryAfterSeconds says", () => {
    expect(queryRetryDelay(0, unavailable('backing-off', 4))).toBe(4_000);
  });

  it('clamps an overlong wait to 30 seconds', () => {
    expect(queryRetryDelay(0, unavailable('backing-off', 3_600))).toBe(30_000);
  });

  it('falls back to the default exponential delay without a wait', () => {
    expect(queryRetryDelay(0, unavailable('start-failed'))).toBe(1_000);
    expect(queryRetryDelay(2, new ApiError({ error: 'x', code: 'INTERNAL' }))).toBe(4_000);
  });

  it('ignores a wait that is not a positive number', () => {
    const error = new ApiError({
      error: 'x',
      code: 'ENVIRONMENT_UNAVAILABLE',
      details: { reason: 'backing-off', retryAfterSeconds: 'soon' },
    });
    expect(error.retryAfterSeconds).toBeNull();
    expect(queryRetryDelay(0, error)).toBe(1_000);
  });
});

function connectedEnvironment(state: 'connected' | 'disconnected'): Environment {
  return { id: 'local', status: { state } } as Environment;
}

/** A query that fails with `error` on its first run and resolves `'ok'` after. */
async function seedFailedQuery(
  client: QueryClient,
  key: readonly string[],
  error: Error,
  fetches: { count: number }
): Promise<void> {
  const queryFn = () => {
    fetches.count += 1;
    return fetches.count === 1 ? Promise.reject(error) : Promise.resolve('ok');
  };
  await client.prefetchQuery({ queryKey: key, queryFn, retry: false });
  // A mounted component: `invalidateQueries` refetches active queries only, and
  // `retryOnMount: false` keeps mounting from refetching the errored query.
  new QueryObserver(client, {
    queryKey: key,
    queryFn,
    retry: false,
    retryOnMount: false,
  }).subscribe(() => undefined);
}

describe('refetching queries that failed with ENVIRONMENT_UNAVAILABLE', () => {
  it('refetches only the unavailable-failed queries, through a real QueryClient', async () => {
    const client = new QueryClient();
    const unavailableFetches = { count: 0 };
    const otherFetches = { count: 0 };
    await seedFailedQuery(
      client,
      ['git', 'status'],
      unavailable('start-failed'),
      unavailableFetches
    );
    await seedFailedQuery(
      client,
      ['chat', 'list'],
      new ApiError({ error: 'x', code: 'INTERNAL' }),
      otherFetches
    );

    await invalidateEnvironmentUnavailableQueries(client);

    expect(unavailableFetches.count, '(git status): expected one refetch').toBe(2);
    expect(client.getQueryState(['git', 'status'])?.status).toBe('success');
    expect(otherFetches.count, '(chat list): expected no refetch for another error').toBe(1);
    expect(client.getQueryState(['chat', 'list'])?.status).toBe('error');
  });

  it('refetches when the environments list shows one connected', async () => {
    const client = new QueryClient();
    const fetches = { count: 0 };
    await seedFailedQuery(client, ['library', 'resources'], unavailable('backing-off'), fetches);
    client.setQueryData(environmentKeys.entities(), [connectedEnvironment('connected')]);

    await refetchUnavailableQueriesOnConnect(client);

    expect(fetches.count).toBe(2);
    expect(client.getQueryState(['library', 'resources'])?.status).toBe('success');
  });

  it('leaves them alone while no environment is connected', async () => {
    const client = new QueryClient();
    const fetches = { count: 0 };
    await seedFailedQuery(client, ['library', 'resources'], unavailable('backing-off'), fetches);
    client.setQueryData(environmentKeys.entities(), [connectedEnvironment('disconnected')]);

    await refetchUnavailableQueriesOnConnect(client);

    expect(fetches.count).toBe(1);
    expect(client.getQueryState(['library', 'resources'])?.status).toBe('error');
  });
});
