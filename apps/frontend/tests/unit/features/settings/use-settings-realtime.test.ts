import { useQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markAppSettingsLocalWrite,
  resetAppSettingsLocalWriteWindow,
} from '@/features/settings/app/local-write-window';
import { useSettingsRealtimeInvalidation } from '@/features/settings/hooks/use-settings-realtime';
import type { RealtimeTopicListener } from '@/lib/realtime/realtime-client';
import { act, renderHook, waitFor } from '../../../support/harness/render';

const mocks = vi.hoisted(() => ({
  bindRealtimeClientToUser: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: 'user-test' } } }),
  },
}));

vi.mock('@/lib/realtime/realtime-client', () => ({
  bindRealtimeClientToUser: mocks.bindRealtimeClientToUser,
  getRealtimeClient: () => ({ subscribe: mocks.subscribe }),
}));

/** Mounts one query per settings section so each family is observably stale. */
function mountSettingsSections() {
  const refetch = {
    app: vi.fn().mockResolvedValue({ thinkingEnabled: false }),
    provider: vi.fn().mockResolvedValue({ providers: [] }),
    tool: vi.fn().mockResolvedValue({ tools: [] }),
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
  let release: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    release = vi.fn();
    mocks.subscribe.mockImplementation((_: string, nextListener: RealtimeTopicListener) => {
      listener = nextListener;
      return release;
    });
    mocks.subscribe.mockClear();
    resetAppSettingsLocalWriteWindow();
  });

  it('invalidates only the signaled section and unsubscribes on unmount', async () => {
    const { refetch, unmount } = mountSettingsSections();

    expect(mocks.subscribe).toHaveBeenCalledOnce();
    expect(mocks.subscribe).toHaveBeenCalledWith('settings', expect.any(Function));

    await act(async () => {
      await listener({
        type: 'invalidate',
        message: { type: 'invalidate', topic: 'settings', scopes: ['provider'] },
      });
    });

    await waitFor(() => expect(refetch.provider).toHaveBeenCalledOnce());
    expect(refetch.app).not.toHaveBeenCalled();
    expect(refetch.tool).not.toHaveBeenCalled();

    unmount();
    expect(release).toHaveBeenCalledOnce();
  });

  it('refreshes every section on a subscription acknowledgement', async () => {
    const { refetch } = mountSettingsSections();

    await act(async () => {
      await listener({ type: 'subscribed' });
    });

    await waitFor(() => expect(refetch.app).toHaveBeenCalledOnce());
    expect(refetch.provider).toHaveBeenCalledOnce();
    expect(refetch.tool).toHaveBeenCalledOnce();
  });

  it('refreshes every section when an event carries no scopes', async () => {
    const { refetch } = mountSettingsSections();

    await act(async () => {
      await listener({
        type: 'invalidate',
        message: { type: 'invalidate', topic: 'settings' },
      });
    });

    await waitFor(() => expect(refetch.app).toHaveBeenCalledOnce());
    expect(refetch.provider).toHaveBeenCalledOnce();
    expect(refetch.tool).toHaveBeenCalledOnce();
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

    await waitFor(() => expect(refetch.provider).toHaveBeenCalledOnce());
    expect(refetch.app).not.toHaveBeenCalled();
  });

  it('refreshes app on a subscription acknowledgement even mid-write', async () => {
    const { refetch } = mountSettingsSections();
    markAppSettingsLocalWrite();

    await act(async () => {
      await listener({ type: 'subscribed' });
    });

    // The ack stands in for events lost while the socket was down and is never
    // replayed, so the echo window must not swallow it.
    await waitFor(() => expect(refetch.app).toHaveBeenCalledOnce());
  });

  it('re-applies a dropped app event once the local write window closes', async () => {
    vi.useFakeTimers();
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
        await vi.advanceTimersByTimeAsync(2_100);
      });

      expect(refetch.app).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a dropped app event back while edits keep reopening the window', async () => {
    vi.useFakeTimers();
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
          await vi.advanceTimersByTimeAsync(1_500);
        });
        markAppSettingsLocalWrite();
      }

      expect(refetch.app).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });

      expect(refetch.app).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a deferred app refresh when the section unmounts', async () => {
    vi.useFakeTimers();
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
        await vi.advanceTimersByTimeAsync(2_100);
      });

      expect(refetch.app).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
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

    await waitFor(() => expect(refetch.app).toHaveBeenCalledOnce());
  });
});
