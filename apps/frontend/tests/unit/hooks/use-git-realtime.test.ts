import type { GitRepoState } from '@mangostudio/shared/git';
import { useQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGitRealtimeInvalidation } from '@/features/workspace/hooks/use-git-state';
import type { RealtimeTopicListener } from '@/lib/realtime/realtime-client';
import { act, renderHook, waitFor } from '../../support/harness/render';

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
  let release: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    release = vi.fn();
    mocks.subscribe.mockImplementation((_: string, nextListener: RealtimeTopicListener) => {
      listener = nextListener;
      return release;
    });
    mocks.subscribe.mockClear();
    mocks.bindRealtimeClientToUser.mockClear();
  });

  it('invalidates only signaled Git scopes and unsubscribes on unmount', async () => {
    const refetchState = vi.fn().mockResolvedValue(repoState);
    const refetchHistory = vi.fn().mockResolvedValue({ commits: [], nextCursor: null });

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

    expect(mocks.subscribe).toHaveBeenCalledOnce();
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

    await waitFor(() => expect(refetchState).toHaveBeenCalledOnce());
    expect(refetchHistory).not.toHaveBeenCalled();

    unmount();
    expect(release).toHaveBeenCalledOnce();
  });
});
