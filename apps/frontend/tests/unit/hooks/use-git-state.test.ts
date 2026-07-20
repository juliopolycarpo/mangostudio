import type { GitStatus } from '@mangostudio/shared/git';
import { useQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGitStashes, useStagePaths } from '@/features/workspace/hooks/use-git-state';
import type * as ApiClient from '@/lib/api-client';
import { act, renderHook, waitFor } from '../../support/harness/render';

const { mockStage, mockStashes } = vi.hoisted(() => ({
  mockStage: vi.fn(),
  mockStashes: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  client: {
    api: {
      git: {
        stage: { post: mockStage },
        stashes: { get: mockStashes },
      },
    },
  } as unknown as typeof ApiClient,
}));

const status: GitStatus = {
  branch: { name: 'main', ahead: 0, behind: 0 },
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  clean: true,
};

describe('Git write hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stages through Eden and invalidates both repository queries', async () => {
    mockStage.mockResolvedValue({ data: status, error: null });
    const refetchState = vi.fn().mockResolvedValue(status);
    const refetchStashes = vi.fn().mockResolvedValue({ stashes: [] });

    const { result } = renderHook(() => {
      useQuery({
        queryKey: ['git-state', 'chat-1'],
        queryFn: refetchState,
        initialData: { state: 'repo', root: '/repo', workdir: '/repo', status },
        staleTime: Number.POSITIVE_INFINITY,
      });
      useQuery({
        queryKey: ['git-stashes', 'chat-1'],
        queryFn: refetchStashes,
        initialData: { stashes: [] },
        staleTime: Number.POSITIVE_INFINITY,
      });
      return useStagePaths('chat-1');
    });

    await act(async () => {
      await result.current.mutateAsync({ paths: ['src/panel.tsx'] });
    });

    expect(mockStage).toHaveBeenCalledWith({ chatId: 'chat-1', paths: ['src/panel.tsx'] });
    await waitFor(() => expect(refetchState).toHaveBeenCalledOnce());
    await waitFor(() => expect(refetchStashes).toHaveBeenCalledOnce());
  });

  it('loads the chat-scoped stash list through Eden', async () => {
    mockStashes.mockResolvedValue({
      data: { stashes: [{ index: 0, message: 'Saved work', branch: 'main' }] },
      error: null,
    });

    const { result } = renderHook(() => useGitStashes('chat-2'));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockStashes).toHaveBeenCalledWith({ query: { chatId: 'chat-2' } });
    expect(result.current.data?.stashes).toEqual([
      { index: 0, message: 'Saved work', branch: 'main' },
    ]);
  });
});
