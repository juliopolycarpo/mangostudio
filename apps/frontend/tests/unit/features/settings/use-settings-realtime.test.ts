import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import { useQuery } from '@tanstack/react-query';

import type { RealtimeTopicListener } from '@/lib/realtime/realtime-client';
import { getTabWriterId } from '@/lib/realtime/writer-id';

import { act, renderHook, waitFor } from '../../../support/harness/render';
import { advanceTimersByTimeAsync, useFakeTimers } from '../../../support/harness/timers';
import { setTestSession } from '../../../support/setup/auth-client-stub';

// `vi.hoisted` exists because `vi.mock` is hoisted above the file's own
// statements. `mock.module` is not hoisted, so a plain const declared before
// the call is enough.
const mocks = {
  bindRealtimeClientToUser: jest.fn(),
  subscribe: jest.fn(),
};

void mock.module('@/lib/realtime/realtime-client', () => ({
  bindRealtimeClientToUser: mocks.bindRealtimeClientToUser,
  getRealtimeClient: () => ({ subscribe: mocks.subscribe }),
}));

// Static imports are evaluated before any statement above runs, so the hook has
// to come in afterwards or it binds the real realtime client. The signed-in
// session it reads comes from the aliased auth-client stub, set in `beforeEach`.
const { useSettingsRealtimeInvalidation } =
  await import('@/features/settings/hooks/use-settings-realtime');

const OTHER_TAB_WRITER_ID = 'other-tab-writer';

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

  /** An `app`-scoped settings event as the hub publishes it, optionally naming its writer. */
  function appEvent(writerId?: string, scopes: readonly string[] = ['app']) {
    return act(async () => {
      await listener({
        type: 'invalidate',
        message: {
          type: 'invalidate',
          topic: 'settings',
          scopes,
          ...(writerId === undefined ? {} : { writerId }),
        } as never,
      });
    });
  }

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

  it('ignores the app echo of its own write, but keeps other sections live', async () => {
    const { refetch } = mountSettingsSections();

    await appEvent(getTabWriterId(), ['app', 'provider']);

    await waitFor(() => expect(refetch.provider).toHaveBeenCalledTimes(1));
    expect(refetch.app).not.toHaveBeenCalled();
  });

  // The bug class this id replaces: a time window cannot tell a self-echo from
  // another tab's write, so a genuine remote write that landed inside it was
  // dropped (and later had to be re-armed). The id compares instead of guessing.
  it('applies another tab write immediately, right after this tab own echo', async () => {
    useFakeTimers();
    const { refetch } = mountSettingsSections();

    await appEvent(getTabWriterId());
    expect(refetch.app).not.toHaveBeenCalled();

    // No timer advanced: where the window used to be.
    await appEvent(OTHER_TAB_WRITER_ID);

    expect(refetch.app).toHaveBeenCalledTimes(1);
  });

  it('applies another tab write that arrives before this tab own echo', async () => {
    const { refetch } = mountSettingsSections();

    await appEvent(OTHER_TAB_WRITER_ID);
    await waitFor(() => expect(refetch.app).toHaveBeenCalledTimes(1));

    await appEvent(getTabWriterId());
    expect(refetch.app).toHaveBeenCalledTimes(1);
  });

  it('converges when two tabs save at once: each applies only the other one write', async () => {
    useFakeTimers();
    const { refetch } = mountSettingsSections();

    // Both writes are in flight together, so this tab sees its own echo and the
    // other tab's in either order; exactly one refetch must follow, for the
    // other tab's write.
    await appEvent(OTHER_TAB_WRITER_ID);
    await appEvent(getTabWriterId());
    await appEvent(getTabWriterId());
    await appEvent(OTHER_TAB_WRITER_ID);

    expect(refetch.app).toHaveBeenCalledTimes(2);
  });

  it('applies an app event that names no writer, as an older hub publishes it', async () => {
    const { refetch } = mountSettingsSections();

    await appEvent(undefined);

    await waitFor(() => expect(refetch.app).toHaveBeenCalledTimes(1));
  });

  it('applies an app acknowledgement at once instead of waiting out a window', async () => {
    useFakeTimers();
    const { refetch } = mountSettingsSections();

    // Own echo first: nothing about the ack may depend on how recently this tab wrote.
    await appEvent(getTabWriterId());
    await act(async () => {
      await listener({ type: 'subscribed' });
    });

    expect(refetch.app).toHaveBeenCalledTimes(1);
    expect(refetch.provider).toHaveBeenCalledTimes(1);
    expect(refetch.tool).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing after dropping an own echo', async () => {
    useFakeTimers();
    const { refetch } = mountSettingsSections();

    await appEvent(getTabWriterId());

    // The old design re-applied a dropped echo once its window closed.
    await act(async () => {
      await advanceTimersByTimeAsync(10_000);
    });

    expect(refetch.app).not.toHaveBeenCalled();
  });
});
