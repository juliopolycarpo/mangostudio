import type { GitStatus } from '@mangostudio/shared/git';
import { useQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GIT_SCOPES,
  gitWriteScopes,
  useCommit,
  useGitFetch,
  useGitPull,
  useGitStashes,
  useStagePaths,
  useUnstagePaths,
} from '@/features/workspace/hooks/use-git-state';
import type * as ApiClient from '@/lib/api-client';
import { act, renderHook, waitFor } from '../../support/harness/render';

const { mockStage, mockUnstage, mockCommit, mockFetch, mockPull, mockStashes } = vi.hoisted(() => ({
  mockStage: vi.fn(),
  mockUnstage: vi.fn(),
  mockCommit: vi.fn(),
  mockFetch: vi.fn(),
  mockPull: vi.fn(),
  mockStashes: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  client: {
    api: {
      git: {
        stage: { post: mockStage },
        unstage: { post: mockUnstage },
        commit: { post: mockCommit },
        fetch: { post: mockFetch },
        pull: { post: mockPull },
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
}

describe('Git write hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stages through Eden and invalidates state and diffs only', async () => {
    mockStage.mockResolvedValue({ data: status, error: null });
    const refetchState = vi.fn().mockResolvedValue(repoState);
    const refetchDiffs = vi.fn().mockResolvedValue({ path: 'src/panel.tsx', hunks: [] });
    const refetchHistory = vi.fn().mockResolvedValue({ commits: [], nextCursor: null });
    const refetchCommits = vi
      .fn()
      .mockResolvedValue({ hash: 'abc123', subject: 'prior', files: [] });
    const refetchBranches = vi.fn().mockResolvedValue({ branches: [], remotes: [] });
    const refetchStashes = vi.fn().mockResolvedValue({ stashes: [] });

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
    await waitFor(() => expect(refetchState).toHaveBeenCalledOnce());
    await waitFor(() => expect(refetchDiffs).toHaveBeenCalledOnce());
    expect(refetchHistory).not.toHaveBeenCalled();
    expect(refetchCommits).not.toHaveBeenCalled();
    expect(refetchBranches).not.toHaveBeenCalled();
    expect(refetchStashes).not.toHaveBeenCalled();
  });

  it('unstages without invalidating history, commits, or branches', async () => {
    mockUnstage.mockResolvedValue({ data: status, error: null });
    const refetchState = vi.fn().mockResolvedValue(repoState);
    const refetchHistory = vi.fn().mockResolvedValue({ commits: [], nextCursor: null });
    const refetchCommits = vi
      .fn()
      .mockResolvedValue({ hash: 'abc123', subject: 'prior', files: [] });
    const refetchBranches = vi.fn().mockResolvedValue({ branches: [], remotes: [] });

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

    await waitFor(() => expect(refetchState).toHaveBeenCalledOnce());
    expect(refetchHistory).not.toHaveBeenCalled();
    expect(refetchCommits).not.toHaveBeenCalled();
    expect(refetchBranches).not.toHaveBeenCalled();
  });

  it('commit invalidates history, commits, branches, and github context', async () => {
    mockCommit.mockResolvedValue({ data: { hash: 'def456', subject: 'feat' }, error: null });
    const refetchState = vi.fn().mockResolvedValue(repoState);
    const refetchHistory = vi.fn().mockResolvedValue({ commits: [], nextCursor: null });
    const refetchCommits = vi
      .fn()
      .mockResolvedValue({ hash: 'abc123', subject: 'prior', files: [] });
    const refetchBranches = vi.fn().mockResolvedValue({ branches: [], remotes: [] });
    const refetchGithub = vi.fn().mockResolvedValue({ state: 'none' });
    const refetchStashes = vi.fn().mockResolvedValue({ stashes: [] });

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

    await waitFor(() => expect(refetchState).toHaveBeenCalledOnce());
    await waitFor(() => expect(refetchHistory).toHaveBeenCalledOnce());
    await waitFor(() => expect(refetchCommits).toHaveBeenCalledOnce());
    await waitFor(() => expect(refetchBranches).toHaveBeenCalledOnce());
    await waitFor(() => expect(refetchGithub).toHaveBeenCalledOnce());
    expect(refetchStashes).not.toHaveBeenCalled();
  });

  it('pull invalidates history while fetch does not', async () => {
    mockPull.mockResolvedValue({ data: repoState, error: null });
    mockFetch.mockResolvedValue({ data: repoState, error: null });
    const pullHistory = vi.fn().mockResolvedValue({ commits: [], nextCursor: null });
    const fetchHistory = vi.fn().mockResolvedValue({ commits: [], nextCursor: null });
    const fetchState = vi.fn().mockResolvedValue(repoState);

    const { result: pullResult } = renderHook(() => {
      useSeedTrackedQueries({ history: pullHistory });
      return useGitPull('chat-1');
    });

    await act(async () => {
      await pullResult.current.mutateAsync({});
    });
    await waitFor(() => expect(pullHistory).toHaveBeenCalledOnce());

    const { result: fetchResult } = renderHook(() => {
      useSeedTrackedQueries({ state: fetchState, history: fetchHistory });
      return useGitFetch('chat-1');
    });

    await act(async () => {
      await fetchResult.current.mutateAsync({});
    });
    await waitFor(() => expect(fetchState).toHaveBeenCalledOnce());
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
