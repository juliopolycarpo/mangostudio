/**
 * The "since your last visit" bookmark: read once, then moved forward.
 *
 * Tested on the hook rather than through `ActivityStrip`, because reporting a
 * session to that component makes `useRealtimeInvalidation` open a real socket
 * and strand an `ErrorEvent` under whichever file the runner reaches next.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { useActivityBookmark } from '@/features/activity/use-activity-bookmark';
import { flushAsyncRender, renderHook } from '../../../support/harness/render';
import { setTestSession } from '../../../support/setup/auth-client-stub';

const LAST_SEEN_KEY = 'mangostudio:activity-last-seen';

afterEach(() => {
  window.localStorage.removeItem(LAST_SEEN_KEY);
});

describe('useActivityBookmark', () => {
  it('reports null for a signed-out session and writes nothing', async () => {
    const { result } = renderHook(() => useActivityBookmark());
    await flushAsyncRender();

    expect(result.current).toBeNull();
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).toBeNull();
  });

  it('reports the stored bookmark and then advances it', async () => {
    const previous = Date.now() - 60_000;
    window.localStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ 'user-1': previous }));
    setTestSession({ user: { id: 'user-1' } });

    const { result } = renderHook(() => useActivityBookmark());
    await flushAsyncRender();

    expect(result.current).toBe(previous);
    const stored = JSON.parse(window.localStorage.getItem(LAST_SEEN_KEY) ?? '{}') as Record<
      string,
      number
    >;
    expect(stored['user-1']).toBeGreaterThan(previous);
  });

  it('reports null on a first visit rather than treating the page as new', async () => {
    setTestSession({ user: { id: 'user-2' } });

    const { result } = renderHook(() => useActivityBookmark());
    await flushAsyncRender();

    expect(result.current).toBeNull();
    const stored = JSON.parse(window.localStorage.getItem(LAST_SEEN_KEY) ?? '{}') as Record<
      string,
      number
    >;
    expect(stored['user-2']).toBeGreaterThan(0);
  });

  it('does not re-read the bookmark it just moved', async () => {
    const previous = Date.now() - 60_000;
    window.localStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ 'user-1': previous }));
    setTestSession({ user: { id: 'user-1' } });

    const { result, rerender } = renderHook(() => useActivityBookmark());
    await flushAsyncRender();
    rerender();
    await flushAsyncRender();

    // A live read would collapse the count to zero while somebody was looking.
    expect(result.current).toBe(previous);
  });
});
