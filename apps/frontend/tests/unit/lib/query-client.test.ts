import { describe, expect, it } from 'bun:test';

import { queryClient, shouldRetryQuery } from '@/lib/query-client';
import { ApiError } from '@/lib/utils';

describe('shouldRetryQuery', () => {
  it('retries an ordinary failure once', () => {
    const failure = new ApiError({ error: 'boom', code: 'INTERNAL' });
    expect(shouldRetryQuery(0, failure)).toBe(true);
    expect(shouldRetryQuery(1, failure)).toBe(false);
  });

  it('does not retry ENVIRONMENT_UNAVAILABLE, which the hub already backs off', () => {
    const failure = new ApiError({
      error: 'The environment is unavailable.',
      code: 'ENVIRONMENT_UNAVAILABLE',
    });
    expect(
      shouldRetryQuery(0, failure),
      '(ENVIRONMENT_UNAVAILABLE): expected no client retry | received: retry'
    ).toBe(false);
  });

  it('keeps retrying PROVIDER_ERROR once, since a provider may recover at once', () => {
    expect(shouldRetryQuery(0, new ApiError({ error: 'x', code: 'PROVIDER_ERROR' }))).toBe(true);
  });
});

describe('queryClient defaults', () => {
  it('keeps interval refetches paused while the tab is hidden', () => {
    // Polled queries (observability, runtime health, ChatGPT usage) set only
    // `refetchInterval` and rely on this default to stop when the tab is in
    // the background. A `true` here would turn every one of them into a
    // hidden-tab polling loop.
    expect(queryClient.getDefaultOptions().queries?.refetchIntervalInBackground).toBe(false);
  });

  it('does not refetch on window focus, so realtime signals stay the refresh path', () => {
    expect(queryClient.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });
});
