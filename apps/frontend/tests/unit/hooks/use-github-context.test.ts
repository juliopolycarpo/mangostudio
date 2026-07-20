import type { GitRepoState } from '@mangostudio/shared/git';
import type { GithubContext } from '@mangostudio/shared/github';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGithubContext } from '@/features/workspace/hooks/use-github-context';
import type * as ApiClient from '@/lib/api-client';
import { renderHook, waitFor } from '../../support/harness/render';

const { mockContext } = vi.hoisted(() => ({ mockContext: vi.fn() }));

vi.mock('@/lib/api-client', () => ({
  client: {
    api: {
      github: {
        context: { get: mockContext },
      },
    },
  } as unknown as typeof ApiClient,
}));

const context: GithubContext = {
  state: 'ok',
  repo: {
    nameWithOwner: 'mango/mangostudio',
    defaultBranch: 'main',
    url: 'https://github.example/mango/mangostudio',
  },
  pr: null,
};

function repoState(branch: string): GitRepoState {
  return {
    state: 'repo',
    root: '/repo',
    workdir: '/repo',
    status: {
      branch: { name: branch, ahead: 0, behind: 0 },
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
      clean: true,
    },
  };
}

describe('useGithubContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContext.mockResolvedValue({ data: context, error: null });
  });

  it('loads context through the chat-scoped Eden endpoint', async () => {
    const { result } = renderHook(() => useGithubContext('chat-1', repoState('main')));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockContext).toHaveBeenCalledWith({ query: { chatId: 'chat-1' } });
    expect(result.current.data).toEqual(context);
  });

  it('does not query until the working directory is a repository', () => {
    const { result } = renderHook(() =>
      useGithubContext('chat-1', { state: 'not-a-repo', workdir: '/repo' })
    );

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockContext).not.toHaveBeenCalled();
  });

  it('refetches when the git query reports a different branch', async () => {
    const { result, rerender } = renderHook(
      ({ branch }) => useGithubContext('chat-1', repoState(branch)),
      { initialProps: { branch: 'main' } }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockContext).toHaveBeenCalledTimes(1);

    rerender({ branch: 'feat/github-context' });

    await waitFor(() => expect(mockContext).toHaveBeenCalledTimes(2));
  });
});
