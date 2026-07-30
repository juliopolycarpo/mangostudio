import { useQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
