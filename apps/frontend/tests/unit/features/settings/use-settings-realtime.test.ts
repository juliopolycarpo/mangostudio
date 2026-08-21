import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { useQuery } from '@tanstack/react-query';
import {
  markAppSettingsLocalWrite,
  resetAppSettingsLocalWriteWindow,
} from '@/features/settings/app/local-write-window';
import type { RealtimeTopicListener } from '@/lib/realtime/realtime-client';
import { act, renderHook, waitFor } from '../../../support/harness/render';
import {
  advanceTimersByTimeAsync,
  restoreRealTimers,
  useFakeTimers,
} from '../../../support/harness/timers';
import { setTestSession } from '../../../support/setup/auth-client-stub';

// `vi.hoisted` exists because `vi.mock` is hoisted above the file's own
// statements. `mock.module` is not hoisted, so a plain const declared before
// the call is enough.
const mocks = {
  bindRealtimeClientToUser: jest.fn(),
  subscribe: jest.fn(),
};

mock.module('@/lib/realtime/realtime-client', () => ({
  bindRealtimeClientToUser: mocks.bindRealtimeClientToUser,
  getRealtimeClient: () => ({ subscribe: mocks.subscribe }),
}));

// Static imports are evaluated before any statement above runs, so the hook has
// to come in afterwards or it binds the real realtime client. The signed-in
// session it reads comes from the aliased auth-client stub, set in `beforeEach`.
const { useSettingsRealtimeInvalidation } = await import(
  '@/features/settings/hooks/use-settings-realtime'
);

/** Mounts one query per settings section so each family is observably stale. */
function mountSettingsSections() {
  const refetch = {
    app: jest.fn().mockResolvedValue({ thinkingEnabled: false }),
    provider: jest.fn().mockResolvedValue({ providers: [] }),
    tool: jest.fn().mockResolvedValue({ tools: [] }),
  };

  const view = renderHook(() => {
    useQuery({
      queryKey: ['app-settings', 'current'],
      queryFn: refetch.app,
      initialData: { thinkingEnabled: false },
      staleTime: Number.POSITIVE_INFINITY,
    });
    useQuery({
      queryKey: ['provider-settings', 'list'],
      queryFn: refetch.provider,
      initialData: { providers: [] },
      staleTime: Number.POSITIVE_INFINITY,
    });
    useQuery({
      queryKey: ['tool-settings', 'list'],
      queryFn: refetch.tool,
      initialData: { tools: [] },
      staleTime: Number.POSITIVE_INFINITY,
    });
    useSettingsRealtimeInvalidation();
  });

  return { ...view, refetch };
}

describe('useSettingsRealtimeInvalidation', () => {
  let listener: RealtimeTopicListener;
  let release: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    // The hook reads the session; the aliased stub reports signed out unless a
    // test says otherwise, and `bun.setup.ts` resets it after each one.
    setTestSession({ user: { id: 'user-test' } });
    release = jest.fn();
    mocks.subscribe.mockImplementation((_: string, nextListener: RealtimeTopicListener) => {
      listener = nextListener;
      return release;
    });
    mocks.subscribe.mockClear();
    resetAppSettingsLocalWriteWindow();
  });

  it('invalidates only the signaled section and unsubscribes on unmount', async () => {
    const { refetch, unmount } = mountSettingsSections();

    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).toHaveBeenCalledWith('settings', expect.any(Function));

    await act(async () => {
      await listener({
        type: 'invalidate',
        message: { type: 'invalidate', topic: 'settings', scopes: ['provider'] },
      });
    });

    await waitFor(() => expect(refetch.provider).toHaveBeenCalledTimes(1));
    expect(refetch.app).not.toHaveBeenCalled();
    expect(refetch.tool).not.toHaveBeenCalled();

    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('refreshes every section on a subscription acknowledgement', async () => {
    const { refetch } = mountSettingsSections();

    await act(async () => {
      await listener({ type: 'subscribed' });
    });

    await waitFor(() => expect(refetch.app).toHaveBeenCalledTimes(1));
    expect(refetch.provider).toHaveBeenCalledTimes(1);
    expect(refetch.tool).toHaveBeenCalledTimes(1);
  });

  it('refreshes every section when an event carries no scopes', async () => {
    const { refetch } = mountSettingsSections();

    await act(async () => {
      await listener({
        type: 'invalidate',
        message: { type: 'invalidate', topic: 'settings' },
      });
    });

    await waitFor(() => expect(refetch.app).toHaveBeenCalledTimes(1));
    expect(refetch.provider).toHaveBeenCalledTimes(1);
    expect(refetch.tool).toHaveBeenCalledTimes(1);
  });

  it('ignores an app echo while this tab is mid-write, but keeps other sections live', async () => {
    const { refetch } = mountSettingsSections();
    markAppSettingsLocalWrite();

    await act(async () => {
      await listener({
        type: 'invalidate',
        message: { type: 'invalidate', topic: 'settings', scopes: ['app', 'provider'] },
      });
    });

    await waitFor(() => expect(refetch.provider).toHaveBeenCalledTimes(1));
    expect(refetch.app).not.toHaveBeenCalled();
  });

  it('defers only the app half of a subscription acknowledgement mid-write', async () => {
    useFakeTimers();
    try {
      const { refetch } = mountSettingsSections();
      markAppSettingsLocalWrite();

      await act(async () => {
        await listener({ type: 'subscribed' });
      });

      // Sections this tab is not writing have nothing to lose.
      expect(refetch.provider).toHaveBeenCalledTimes(1);
      expect(refetch.tool).toHaveBeenCalledTimes(1);
      // Refetching app now would replace the cache `saveSettings` builds its
      // next value from, so the following keystroke would carry the server's
      // older object into the pending PUT.
      expect(refetch.app).not.toHaveBeenCalled();

      await act(async () => {
        await advanceTimersByTimeAsync(2_100);
      });

      // Deferred, never dropped: the ack stands in for events lost while the
      // socket was down and nothing replays it.
      expect(refetch.app).toHaveBeenCalledTimes(1);
    } finally {
      await restoreRealTimers();
    }
  });

  it('re-applies a dropped app event once the local write window closes', async () => {
    useFakeTimers();
    try {
      const { refetch } = mountSettingsSections();
      markAppSettingsLocalWrite();

      await act(async () => {
        await listener({
          type: 'invalidate',
          message: { type: 'invalidate', topic: 'settings', scopes: ['app'] },
        });
      });

      expect(refetch.app).not.toHaveBeenCalled();

      // The event may have come from another tab, and nothing republishes it —
      // suppression has to be a delay, not a discard.
      await act(async () => {
        await advanceTimersByTimeAsync(2_100);
      });

      expect(refetch.app).toHaveBeenCalledTimes(1);
    } finally {
      await restoreRealTimers();
    }
  });

  it('holds a dropped app event back while edits keep reopening the window', async () => {
    useFakeTimers();
    try {
      const { refetch } = mountSettingsSections();
      markAppSettingsLocalWrite();

      await act(async () => {
        await listener({
          type: 'invalidate',
          message: { type: 'invalidate', topic: 'settings', scopes: ['app'] },
        });
      });

      // A continuous burst: each edit reopens the window before the deferred
      // refresh can fire, so it must re-arm rather than refetch mid-keystroke.
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          await advanceTimersByTimeAsync(1_500);
        });
        markAppSettingsLocalWrite();
      }

      expect(refetch.app).not.toHaveBeenCalled();

      await act(async () => {
        await advanceTimersByTimeAsync(2_100);
      });

      expect(refetch.app).toHaveBeenCalledTimes(1);
    } finally {
      await restoreRealTimers();
    }
  });

  it('cancels a deferred app refresh when the section unmounts', async () => {
    useFakeTimers();
    try {
      const { refetch, unmount } = mountSettingsSections();
      markAppSettingsLocalWrite();

      await act(async () => {
        await listener({
          type: 'invalidate',
          message: { type: 'invalidate', topic: 'settings', scopes: ['app'] },
        });
      });

      unmount();

      await act(async () => {
        await advanceTimersByTimeAsync(2_100);
      });

      expect(refetch.app).not.toHaveBeenCalled();
    } finally {
      await restoreRealTimers();
    }
  });

  it('applies an app event once the local write window has closed', async () => {
    const { refetch } = mountSettingsSections();
    markAppSettingsLocalWrite();
    resetAppSettingsLocalWriteWindow();

    await act(async () => {
      await listener({
        type: 'invalidate',
        message: { type: 'invalidate', topic: 'settings', scopes: ['app'] },
      });
    });

    await waitFor(() => expect(refetch.app).toHaveBeenCalledTimes(1));
  });
});
