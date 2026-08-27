import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { GitStatus } from '@mangostudio/shared/git';
import { GIT_SCOPES } from '@mangostudio/shared/realtime';
import { useQuery } from '@tanstack/react-query';
import type * as ApiClient from '@/lib/api-client';
import { act, renderHook, waitFor } from '../../support/harness/render';

const {
  mockStage,
  mockUnstage,
  mockCommit,
  mockFetch,
  mockPull,
  mockPush,
  mockStashes,
  mockStashApply,
  mockStashDrop,
  mockBranchDelete,
  mockBranchRename,
  mockHeadMessage,
  mockWorktreeList,
  mockWorktreeAdd,
  mockWorktreeRemove,
} = {
  mockStage: jest.fn(),
  mockUnstage: jest.fn(),
  mockCommit: jest.fn(),
  mockFetch: jest.fn(),
  mockPull: jest.fn(),
  mockPush: jest.fn(),
  mockStashes: jest.fn(),
  mockStashApply: jest.fn(),
  mockStashDrop: jest.fn(),
  mockBranchDelete: jest.fn(),
  mockBranchRename: jest.fn(),
  mockHeadMessage: jest.fn(),
  mockWorktreeList: jest.fn(),
  mockWorktreeAdd: jest.fn(),
  mockWorktreeRemove: jest.fn(),
};

mock.module('@/lib/api-client', () => ({
  client: {
    api: {
      git: {
        stage: { post: mockStage },
        unstage: { post: mockUnstage },
        commit: { post: mockCommit },
        fetch: { post: mockFetch },
        pull: { post: mockPull },
        push: { post: mockPush },
        stashes: { get: mockStashes },
        stash: { apply: { post: mockStashApply }, drop: { post: mockStashDrop } },
        branches: { delete: mockBranchDelete, rename: { post: mockBranchRename } },
        'head-message': { get: mockHeadMessage },
        worktrees: {
          get: mockWorktreeList,
          post: mockWorktreeAdd,
          delete: mockWorktreeRemove,
        },
      },
    },
  } as unknown as typeof ApiClient,
}));

// Static imports are evaluated before any statement above runs, so the hooks
// under test have to come in afterwards or they bind the real api-client.
const {
  gitWriteScopes,
  useAddWorktree,
  useCommit,
  useDeleteBranch,
  useGitFetch,
  useGitHeadMessage,
  useGitPull,
  useGitPush,
  useGitStashes,
  useGitWorktrees,
  useRemoveWorktree,
  useRenameBranch,
  useStagePaths,
  useStashApply,
  useStashDrop,
  useUnstagePaths,
} = await import('@/features/workspace/hooks/use-git-state');

const status: GitStatus = {
  branch: { name: 'main', ahead: 0, behind: 0 },
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  clean: true,
};

const repoState = { state: 'repo' as const, root: '/repo', workdir: '/repo', status };

const noop = async () => null;

type QuerySpy = () => Promise<unknown>;

/** Always register every tracked query so hooks stay unconditional. */
function useSeedTrackedQueries(spies: {
  state?: QuerySpy;
  stashes?: QuerySpy;
  branches?: QuerySpy;
  history?: QuerySpy;
  commits?: QuerySpy;
  diffs?: QuerySpy;
  github?: QuerySpy;
  worktrees?: QuerySpy;
}) {
  useQuery({
    queryKey: ['git-state', 'chat-1'],
    queryFn: spies.state ?? noop,
    initialData: repoState,
    staleTime: Number.POSITIVE_INFINITY,
  });
  useQuery({
    queryKey: ['git-stashes', 'chat-1'],
    queryFn: spies.stashes ?? noop,
    initialData: { stashes: [] },
    staleTime: Number.POSITIVE_INFINITY,
  });
  useQuery({
    queryKey: ['git-branches', 'chat-1'],
    queryFn: spies.branches ?? noop,
    initialData: { branches: [], remotes: [] },
    staleTime: Number.POSITIVE_INFINITY,
  });
  useQuery({
    queryKey: ['git-history', 'chat-1'],
    queryFn: spies.history ?? noop,
    initialData: { commits: [], nextCursor: null },
    staleTime: Number.POSITIVE_INFINITY,
  });
  useQuery({
    queryKey: ['git-commit', 'chat-1', 'abc123'],
    queryFn: spies.commits ?? noop,
    initialData: { hash: 'abc123', subject: 'prior', files: [] },
    staleTime: Number.POSITIVE_INFINITY,
  });
  useQuery({
    queryKey: ['git-diff', 'chat-1', 'src/panel.tsx', false, null],
    queryFn: spies.diffs ?? noop,
    initialData: { path: 'src/panel.tsx', hunks: [] },
    staleTime: Number.POSITIVE_INFINITY,
  });
  useQuery({
    queryKey: ['github-context', 'chat-1', 'main'],
    queryFn: spies.github ?? noop,
    initialData: { state: 'none' },
    staleTime: Number.POSITIVE_INFINITY,
  });
  useQuery({
    queryKey: ['git-worktrees', 'chat-1'],
    queryFn: spies.worktrees ?? noop,
    initialData: { worktrees: [] },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

describe('Git write hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stages through Eden and invalidates state and diffs only', async () => {
    mockStage.mockResolvedValue({ data: status, error: null });
    const refetchState = jest.fn().mockResolvedValue(repoState);
    const refetchDiffs = jest.fn().mockResolvedValue({ path: 'src/panel.tsx', hunks: [] });
    const refetchHistory = jest.fn().mockResolvedValue({ commits: [], nextCursor: null });
    const refetchCommits = jest
      .fn()
      .mockResolvedValue({ hash: 'abc123', subject: 'prior', files: [] });
    const refetchBranches = jest.fn().mockResolvedValue({ branches: [], remotes: [] });
    const refetchStashes = jest.fn().mockResolvedValue({ stashes: [] });

    const { result } = renderHook(() => {
      useSeedTrackedQueries({
        state: refetchState,
        diffs: refetchDiffs,
        history: refetchHistory,
        commits: refetchCommits,
        branches: refetchBranches,
        stashes: refetchStashes,
      });
      return useStagePaths('chat-1');
    });

    await act(async () => {
      await result.current.mutateAsync({ paths: ['src/panel.tsx'] });
    });

    expect(mockStage).toHaveBeenCalledWith({ chatId: 'chat-1', paths: ['src/panel.tsx'] });
    await waitFor(() => expect(refetchState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refetchDiffs).toHaveBeenCalledTimes(1));
    expect(refetchHistory).not.toHaveBeenCalled();
    expect(refetchCommits).not.toHaveBeenCalled();
    expect(refetchBranches).not.toHaveBeenCalled();
    expect(refetchStashes).not.toHaveBeenCalled();
  });

  it('unstages without invalidating history, commits, or branches', async () => {
    mockUnstage.mockResolvedValue({ data: status, error: null });
    const refetchState = jest.fn().mockResolvedValue(repoState);
    const refetchHistory = jest.fn().mockResolvedValue({ commits: [], nextCursor: null });
    const refetchCommits = jest
      .fn()
      .mockResolvedValue({ hash: 'abc123', subject: 'prior', files: [] });
    const refetchBranches = jest.fn().mockResolvedValue({ branches: [], remotes: [] });

    const { result } = renderHook(() => {
      useSeedTrackedQueries({
        state: refetchState,
        history: refetchHistory,
        commits: refetchCommits,
        branches: refetchBranches,
      });
      return useUnstagePaths('chat-1');
    });

    await act(async () => {
      await result.current.mutateAsync({ paths: ['src/panel.tsx'] });
    });

    await waitFor(() => expect(refetchState).toHaveBeenCalledTimes(1));
    expect(refetchHistory).not.toHaveBeenCalled();
    expect(refetchCommits).not.toHaveBeenCalled();
    expect(refetchBranches).not.toHaveBeenCalled();
  });

  it('commit invalidates history, commits, branches, and github context', async () => {
    mockCommit.mockResolvedValue({ data: { hash: 'def456', subject: 'feat' }, error: null });
    const refetchState = jest.fn().mockResolvedValue(repoState);
    const refetchHistory = jest.fn().mockResolvedValue({ commits: [], nextCursor: null });
    const refetchCommits = jest
      .fn()
      .mockResolvedValue({ hash: 'abc123', subject: 'prior', files: [] });
    const refetchBranches = jest.fn().mockResolvedValue({ branches: [], remotes: [] });
    const refetchGithub = jest.fn().mockResolvedValue({ state: 'none' });
    const refetchStashes = jest.fn().mockResolvedValue({ stashes: [] });

    const { result } = renderHook(() => {
      useSeedTrackedQueries({
        state: refetchState,
        history: refetchHistory,
        commits: refetchCommits,
        branches: refetchBranches,
        github: refetchGithub,
        stashes: refetchStashes,
      });
      return useCommit('chat-1');
    });

    await act(async () => {
      await result.current.mutateAsync({ title: 'feat: land' });
    });

    await waitFor(() => expect(refetchState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refetchHistory).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refetchCommits).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refetchBranches).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refetchGithub).toHaveBeenCalledTimes(1));
    expect(refetchStashes).not.toHaveBeenCalled();
  });

  it('pull invalidates history while fetch does not', async () => {
    mockPull.mockResolvedValue({ data: repoState, error: null });
    mockFetch.mockResolvedValue({ data: repoState, error: null });
    const pullHistory = jest.fn().mockResolvedValue({ commits: [], nextCursor: null });
    const fetchHistory = jest.fn().mockResolvedValue({ commits: [], nextCursor: null });
    const fetchState = jest.fn().mockResolvedValue(repoState);

    const { result: pullResult } = renderHook(() => {
      useSeedTrackedQueries({ history: pullHistory });
      return useGitPull('chat-1');
    });

    await act(async () => {
      await pullResult.current.mutateAsync({});
    });
    await waitFor(() => expect(pullHistory).toHaveBeenCalledTimes(1));

    const { result: fetchResult } = renderHook(() => {
      useSeedTrackedQueries({ state: fetchState, history: fetchHistory });
      return useGitFetch('chat-1');
    });

    await act(async () => {
      await fetchResult.current.mutateAsync({});
    });
    await waitFor(() => expect(fetchState).toHaveBeenCalledTimes(1));
    expect(fetchHistory).not.toHaveBeenCalled();
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

  it('applies a stash through Eden while leaving the entry listed', async () => {
    mockStashApply.mockResolvedValue({ data: repoState, error: null });
    const refetchStashes = jest.fn().mockResolvedValue({ stashes: [] });
    const refetchState = jest.fn().mockResolvedValue(repoState);

    const { result } = renderHook(() => {
      useSeedTrackedQueries({ state: refetchState, stashes: refetchStashes });
      return useStashApply('chat-1');
    });

    await act(async () => {
      await result.current.mutateAsync({ index: 2 });
    });

    expect(mockStashApply).toHaveBeenCalledWith({ chatId: 'chat-1', index: 2 });
    await waitFor(() => expect(refetchStashes).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refetchState).toHaveBeenCalledTimes(1));
  });

  it('drops a stash without invalidating the worktree state', async () => {
    mockStashDrop.mockResolvedValue({ data: { stashes: [] }, error: null });
    const refetchStashes = jest.fn().mockResolvedValue({ stashes: [] });
    const refetchState = jest.fn().mockResolvedValue(repoState);

    const { result } = renderHook(() => {
      useSeedTrackedQueries({ state: refetchState, stashes: refetchStashes });
      return useStashDrop('chat-1');
    });

    await act(async () => {
      await result.current.mutateAsync({ index: 0 });
    });

    expect(mockStashDrop).toHaveBeenCalledWith({ chatId: 'chat-1', index: 0 });
    await waitFor(() => expect(refetchStashes).toHaveBeenCalledTimes(1));
    // The stack changed, the checkout did not.
    expect(refetchState).not.toHaveBeenCalled();
  });

  it('deletes and renames branches through Eden', async () => {
    mockBranchDelete.mockResolvedValue({ data: { branches: [], remotes: [] }, error: null });
    mockBranchRename.mockResolvedValue({ data: repoState, error: null });
    const refetchBranches = jest.fn().mockResolvedValue({ branches: [], remotes: [] });
    const refetchState = jest.fn().mockResolvedValue(repoState);

    const { result: deleteResult } = renderHook(() => {
      useSeedTrackedQueries({ state: refetchState, branches: refetchBranches });
      return useDeleteBranch('chat-1');
    });
    await act(async () => {
      await deleteResult.current.mutateAsync({ name: 'feat/old', force: true });
    });

    expect(mockBranchDelete).toHaveBeenCalledWith({
      chatId: 'chat-1',
      name: 'feat/old',
      force: true,
    });
    await waitFor(() => expect(refetchBranches).toHaveBeenCalledTimes(1));
    expect(refetchState).not.toHaveBeenCalled();

    const { result: renameResult } = renderHook(() => {
      useSeedTrackedQueries({ state: refetchState });
      return useRenameBranch('chat-1');
    });
    await act(async () => {
      await renameResult.current.mutateAsync({ name: 'feat/old', newName: 'feat/new' });
    });

    expect(mockBranchRename).toHaveBeenCalledWith({
      chatId: 'chat-1',
      name: 'feat/old',
      newName: 'feat/new',
    });
    // Renaming the checked-out branch changes status.branch.name.
    await waitFor(() => expect(refetchState).toHaveBeenCalledTimes(1));
  });

  it('sends the lease only when a push asks to force', async () => {
    mockPush.mockResolvedValue({ data: repoState, error: null });

    const { result } = renderHook(() => {
      useSeedTrackedQueries({});
      return useGitPush('chat-1');
    });

    await act(async () => {
      await result.current.mutateAsync({});
    });
    expect(mockPush).toHaveBeenLastCalledWith({ chatId: 'chat-1' });

    await act(async () => {
      await result.current.mutateAsync({ force: 'with-lease' });
    });
    expect(mockPush).toHaveBeenLastCalledWith({ chatId: 'chat-1', force: 'with-lease' });
  });

  it('reads the HEAD commit message only while amend mode is active', async () => {
    mockHeadMessage.mockResolvedValue({
      data: { hash: 'abc1234', title: 'previous title', body: 'previous body' },
      error: null,
    });

    const { result: disabled } = renderHook(() => useGitHeadMessage('chat-1', false));
    expect(mockHeadMessage).not.toHaveBeenCalled();
    expect(disabled.current.data).toBeUndefined();

    const { result } = renderHook(() => useGitHeadMessage('chat-2', true));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockHeadMessage).toHaveBeenCalledWith({ query: { chatId: 'chat-2' } });
    expect(result.current.data?.title).toBe('previous title');
  });

  it('lists worktrees through Eden', async () => {
    mockWorktreeList.mockResolvedValue({
      data: { worktrees: [{ path: '/repo', branch: 'main', isMain: true }] },
      error: null,
    });

    const { result } = renderHook(() => useGitWorktrees('chat-2'));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockWorktreeList).toHaveBeenCalledWith({ query: { chatId: 'chat-2' } });
    expect(result.current.data?.worktrees).toHaveLength(1);
  });

  it("adding a worktree refreshes branches and worktrees but not this chat's state", async () => {
    mockWorktreeAdd.mockResolvedValue({ data: { worktrees: [] }, error: null });
    const refetchWorktrees = jest.fn().mockResolvedValue({ worktrees: [] });
    const refetchBranches = jest.fn().mockResolvedValue({ branches: [], remotes: [] });
    const refetchState = jest.fn().mockResolvedValue(repoState);
    const refetchHistory = jest.fn().mockResolvedValue({ commits: [], nextCursor: null });

    const { result } = renderHook(() => {
      useSeedTrackedQueries({
        worktrees: refetchWorktrees,
        branches: refetchBranches,
        state: refetchState,
        history: refetchHistory,
      });
      return useAddWorktree('chat-1');
    });

    await act(async () => {
      await result.current.mutateAsync({
        path: '/work/feature',
        mode: 'new-branch',
        branch: 'feat/panel',
      });
    });

    expect(mockWorktreeAdd).toHaveBeenCalledWith({
      chatId: 'chat-1',
      path: '/work/feature',
      mode: 'new-branch',
      branch: 'feat/panel',
    });
    await waitFor(() => expect(refetchWorktrees).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refetchBranches).toHaveBeenCalledTimes(1));
    expect(refetchState).not.toHaveBeenCalled();
    expect(refetchHistory).not.toHaveBeenCalled();
  });

  it('removing a worktree sends the force flag and refreshes the same scopes', async () => {
    mockWorktreeRemove.mockResolvedValue({ data: { worktrees: [] }, error: null });
    const refetchWorktrees = jest.fn().mockResolvedValue({ worktrees: [] });
    const refetchState = jest.fn().mockResolvedValue(repoState);

    const { result } = renderHook(() => {
      useSeedTrackedQueries({ worktrees: refetchWorktrees, state: refetchState });
      return useRemoveWorktree('chat-1');
    });

    await act(async () => {
      await result.current.mutateAsync({ path: '/work/feature', force: true });
    });

    expect(mockWorktreeRemove).toHaveBeenCalledWith({
      chatId: 'chat-1',
      path: '/work/feature',
      force: true,
    });
    await waitFor(() => expect(refetchWorktrees).toHaveBeenCalledTimes(1));
    expect(refetchState).not.toHaveBeenCalled();
  });

  it('covers every write mutation with a non-empty known scope set', () => {
    const known = new Set<string>(GIT_SCOPES);
    const writeHooks = Object.keys(gitWriteScopes);
    expect(writeHooks.length).toBeGreaterThan(0);

    for (const [name, scopes] of Object.entries(gitWriteScopes)) {
      expect(scopes.length, `${name} must declare scopes`).toBeGreaterThan(0);
      for (const scope of scopes) {
        expect(known.has(scope), `${name} uses unknown scope "${scope}"`).toBe(true);
      }
    }
  });
});
