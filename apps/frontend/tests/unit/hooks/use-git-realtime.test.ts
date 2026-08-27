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

mock.module('@/lib/realtime/realtime-client', () => ({
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
