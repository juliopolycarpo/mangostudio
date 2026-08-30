import { describe, expect, it } from 'bun:test';
import { queryClient } from '@/lib/query-client';

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
