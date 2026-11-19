import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import type { GitRepoState } from '@mangostudio/shared/git';
import { useQuery } from '@tanstack/react-query';

import type { RealtimeTopicListener } from '@/lib/realtime/realtime-client';

import { act, renderHook, waitFor } from '../../support/harness/render';
import { setTestSession } from '../../support/setup/auth-client-stub';

const mocks = {
  bindRealtimeClientToUser: jest.fn(),
  subscribe: jest.fn(),
};

void mock.module('@/lib/realtime/realtime-client', () => ({
  bindRealtimeClientToUser: mocks.bindRealtimeClientToUser,
  getRealtimeClient: () => ({ subscribe: mocks.subscribe }),
}));

// Static imports are evaluated before any statement above runs, so the hook
// has to come in afterwards or it binds the real realtime client. The
// signed-in session it reads comes from the aliased auth-client stub, set in
// `beforeEach`.
const { useGitRealtimeInvalidation } = await import('@/features/workspace/hooks/use-git-state');

const repoState: GitRepoState = {
  state: 'repo',
  root: '/repo',
  workdir: '/repo',
  status: {
    branch: { name: 'main', ahead: 0, behind: 0 },
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    clean: true,
  },
};

describe('useGitRealtimeInvalidation', () => {
  let listener: RealtimeTopicListener;
  let release: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    // The hook reads the session; the aliased stub reports signed out unless
    // a test says otherwise, and `bun.setup.ts` resets it after each one.
    setTestSession({ user: { id: 'user-test' } });
    release = jest.fn();
    mocks.subscribe.mockImplementation((_: string, nextListener: RealtimeTopicListener) => {
      listener = nextListener;
      return release;
    });
    mocks.subscribe.mockClear();
    mocks.bindRealtimeClientToUser.mockClear();
  });

  it('invalidates only signaled Git scopes and unsubscribes on unmount', async () => {
    const refetchState = jest.fn().mockResolvedValue(repoState);
    const refetchHistory = jest.fn().mockResolvedValue({ commits: [], nextCursor: null });

    const { unmount } = renderHook(() => {
      useQuery({
        queryKey: ['git-state', 'chat-1'],
        queryFn: refetchState,
        initialData: repoState,
        staleTime: Number.POSITIVE_INFINITY,
      });
      useQuery({
        queryKey: ['git-history', 'chat-1'],
        queryFn: refetchHistory,
        initialData: { commits: [], nextCursor: null },
        staleTime: Number.POSITIVE_INFINITY,
      });
      useGitRealtimeInvalidation('chat-1');
    });

    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).toHaveBeenCalledWith('git:chat-1', expect.any(Function));

    await act(async () => {
      await listener({
        type: 'invalidate',
        message: {
          type: 'invalidate',
          topic: 'git:chat-1',
          scopes: ['state'],
        },
      });
    });

    await waitFor(() => expect(refetchState).toHaveBeenCalledTimes(1));
    expect(refetchHistory).not.toHaveBeenCalled();

    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  /**
   * The sidebar badge is a per-chat read of the same state. A write signaled on
   * `git:chat-1` must refetch that badge while it is on screen and leave the
   * badge of a neighbouring row alone.
   */
  it('refetches the visible badge of the signaled chat on a state-scoped event', async () => {
    const refetchBadge = jest.fn().mockResolvedValue(null);
    const refetchNeighbourBadge = jest.fn().mockResolvedValue(null);

    renderHook(() => {
      useQuery({
        queryKey: ['git-summary', 'chat-1'],
        queryFn: refetchBadge,
        initialData: null,
        staleTime: Number.POSITIVE_INFINITY,
      });
      useQuery({
        queryKey: ['git-summary', 'chat-2'],
        queryFn: refetchNeighbourBadge,
        initialData: null,
        staleTime: Number.POSITIVE_INFINITY,
      });
      useGitRealtimeInvalidation('chat-1');
    });

    await act(async () => {
      await listener({
        type: 'invalidate',
        message: { type: 'invalidate', topic: 'git:chat-1', scopes: ['state'] },
      });
    });

    await waitFor(() => expect(refetchBadge).toHaveBeenCalledTimes(1));
    expect(refetchNeighbourBadge).not.toHaveBeenCalled();
  });

  /**
   * A same-client write masks this: it invalidates the GitHub panel's own
   * `githubKeys` queries explicitly alongside this event. A second mounted
   * client — another tab, or a different chat's panel sharing the query
   * client — only ever sees this event, so the `github` scope has to reach
   * `githubKeys` on its own or that client's PR/issue/check/thread reads go
   * stale until a manual refresh.
   */
  it('invalidates the GitHub panel queries on a github-scoped event', async () => {
    const refetchGithubContext = jest.fn().mockResolvedValue({ state: 'none' });
    const refetchPrs = jest.fn().mockResolvedValue({ prs: [] });

    renderHook(() => {
      useQuery({
        queryKey: ['github-context', 'chat-1', 'main'],
        queryFn: refetchGithubContext,
        initialData: { state: 'none' },
        staleTime: Number.POSITIVE_INFINITY,
      });
      useQuery({
        queryKey: ['github-panel', 'prs', 'chat-1', 'open'],
        queryFn: refetchPrs,
        initialData: { prs: [] },
        staleTime: Number.POSITIVE_INFINITY,
      });
      useGitRealtimeInvalidation('chat-1');
    });

    await act(async () => {
      await listener({
        type: 'invalidate',
        message: {
          type: 'invalidate',
          topic: 'git:chat-1',
          scopes: ['github'],
        },
      });
    });

    await waitFor(() => expect(refetchGithubContext).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refetchPrs).toHaveBeenCalledTimes(1));
  });
});

describe('useGitRealtimeInvalidation repo topic', () => {
  const listeners = new Map<string, RealtimeTopicListener>();

  const repoVariant = repoState as Extract<GitRepoState, { state: 'repo' }>;

  function stateWithoutKey(): GitRepoState {
    return { ...repoVariant };
  }

  function stateWithKey(): GitRepoState {
    return { ...repoVariant, repoKey: 'sharedRepoKey' };
  }

  beforeEach(() => {
    setTestSession({ user: { id: 'user-test' } });
    listeners.clear();
    mocks.subscribe.mockReset();
    mocks.subscribe.mockImplementation((topic: string, nextListener: RealtimeTopicListener) => {
      listeners.set(topic, nextListener);
      return jest.fn();
    });
  });

  async function deliver(topic: string, scopes: ReadonlyArray<'state' | 'branches'>) {
    const topicListener = listeners.get(topic);
    if (!topicListener) throw new Error(`(listeners): expected a listener on ${topic}`);
    await act(async () => {
      await topicListener({
        type: 'invalidate',
        message: { type: 'invalidate', topic, scopes: [...scopes] },
      });
    });
  }

  function mountPanel(state: GitRepoState) {
    const refetchState = jest.fn().mockResolvedValue(state);
    renderHook(() => {
      useQuery({
        queryKey: ['git-state', 'chat-1'],
        queryFn: refetchState,
        initialData: state,
        staleTime: Number.POSITIVE_INFINITY,
      });
      useGitRealtimeInvalidation('chat-1');
    });
    return refetchState;
  }

  it('subscribes to the repo topic next to the chat topic when the state carries a key', () => {
    mountPanel(stateWithKey());

    expect([...listeners.keys()].sort()).toEqual(['git:chat-1', 'repo:sharedRepoKey']);
  });

  it('keeps only the chat topic when the state has no key, as against an older hub', () => {
    mountPanel(stateWithoutKey());

    expect([...listeners.keys()]).toEqual(['git:chat-1']);
  });

  it('refreshes the panel on a write from a sibling chat announced on the repo topic', async () => {
    const refetchState = mountPanel(stateWithKey());

    await deliver('repo:sharedRepoKey', ['state']);

    await waitFor(() => expect(refetchState).toHaveBeenCalledTimes(1));
  });

  async function ackRepoTopic(requestedAt: number) {
    const topicListener = listeners.get('repo:sharedRepoKey');
    if (!topicListener) throw new Error('(listeners): expected a listener on repo:sharedRepoKey');
    await act(async () => {
      await topicListener({ type: 'subscribed', requestedAt });
    });
  }

  it('skips the ack barrier for a state read after the subscribe frame was sent', async () => {
    const refetchState = mountPanel(stateWithKey());

    await ackRepoTopic(Date.now() - 1_000);
    await Bun.sleep(100);

    expect(refetchState).not.toHaveBeenCalled();
  });

  it('refetches at the ack when the state was read before the subscribe frame was sent', async () => {
    const refetchState = mountPanel(stateWithKey());

    // Read at T, subscribe frame at T+0.1 s: a sibling write at T+0.5 s that
    // the hub processed before the subscription is in neither the read nor a frame.
    await ackRepoTopic(Date.now() + 100);

    await waitFor(() => expect(refetchState).toHaveBeenCalledTimes(1));
  });

  it('refetches once when one write is announced on both topics', async () => {
    const refetchState = mountPanel(stateWithKey());

    // The hub publishes the chat frame first and the repo frame right after it,
    // so the tab receives both before either has been applied.
    await Promise.all([deliver('git:chat-1', ['state']), deliver('repo:sharedRepoKey', ['state'])]);

    await waitFor(() => expect(refetchState).toHaveBeenCalledTimes(1));
    await Bun.sleep(100);
    expect(refetchState).toHaveBeenCalledTimes(1);
  });
});
