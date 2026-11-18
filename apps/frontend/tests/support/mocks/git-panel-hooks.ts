import { jest, mock } from 'bun:test';

import type {
  GitBranchesResponse,
  GitCommitDetailsResponse,
  GitDiffResponse,
  GitHeadMessageResponse,
  GitHistoryResponse,
  GitRepoState,
  GitWorktreeListResponse,
} from '@mangostudio/shared/git';
import type { GithubContext } from '@mangostudio/shared/github';

/**
 * The state behind the mocked git and GitHub hooks of `GitPanel`.
 *
 * A test sets the fields it cares about and renders; `resetGitPanelHooks` puts
 * every field back between tests. Importing this module registers the
 * `mock.module` replacements below, so it must be evaluated before anything
 * that imports `GitPanel` (`tests/support/harness/git-panel.tsx` does that).
 */
export const gitPanelHooks = {
  data: undefined as GitRepoState | undefined,
  error: null as Error | null,
  loading: false,
  fetching: false,
  refetch: jest.fn(),
  mutate: jest.fn(),
  initPending: false,
  initError: null as Error | null,
  stage: jest.fn(),
  unstage: jest.fn(),
  discard: jest.fn(),
  commit: jest.fn(),
  generate: jest.fn(),
  stashSave: jest.fn(),
  stashPop: jest.fn(),
  stashApply: jest.fn(),
  stashDrop: jest.fn(),
  stashes: [] as Array<{ index: number; message: string; branch?: string }>,
  branches: { branches: [], remotes: [] } as GitBranchesResponse,
  branchSwitch: jest.fn(),
  branchCreate: jest.fn(),
  branchRename: jest.fn(),
  branchDelete: jest.fn(),
  checkoutRemote: jest.fn(),
  gitFetch: jest.fn(),
  gitPull: jest.fn(),
  gitPush: jest.fn(),
  headMessage: undefined as GitHeadMessageResponse | undefined,
  headMessageError: null as Error | null,
  historyPages: [] as GitHistoryResponse[],
  historyLoading: false,
  commitDetails: undefined as GitCommitDetailsResponse | undefined,
  diff: undefined as GitDiffResponse | undefined,
  githubData: { state: 'no-remote' } as GithubContext,
  githubError: null as Error | null,
  githubLoading: false,
  githubFetching: false,
  githubRefetch: jest.fn(),
  worktrees: { worktrees: [] } as GitWorktreeListResponse,
  worktreesError: null as Error | null,
  worktreesRefetch: jest.fn(),
  worktreeAdd: jest.fn(),
  worktreeRemove: jest.fn(),
};

const hooks = gitPanelHooks;

void mock.module('../../../src/features/workspace/hooks/use-github-context', () => ({
  useGithubContext: () => ({
    data: hooks.githubData,
    error: hooks.githubError,
    isLoading: hooks.githubLoading,
    isFetching: hooks.githubFetching,
    refetch: hooks.githubRefetch,
  }),
}));

void mock.module('../../../src/features/workspace/hooks/use-git-state', () => ({
  useGitRealtimeInvalidation: () => undefined,
  useGitState: () => ({
    data: hooks.data,
    error: hooks.error,
    isLoading: hooks.loading,
    isFetching: hooks.fetching,
    refetch: hooks.refetch,
  }),
  useInitRepo: () => ({
    mutate: hooks.mutate,
    isPending: hooks.initPending,
    error: hooks.initError,
  }),
  useStagePaths: () => ({ mutateAsync: hooks.stage, isPending: false }),
  useUnstagePaths: () => ({ mutateAsync: hooks.unstage, isPending: false }),
  useDiscardPaths: () => ({ mutateAsync: hooks.discard, isPending: false }),
  useCommit: () => ({ mutateAsync: hooks.commit, isPending: false }),
  useGenerateCommitMessage: () => ({ mutateAsync: hooks.generate, isPending: false }),
  useGitStashes: () => ({ data: { stashes: hooks.stashes }, isLoading: false, error: null }),
  useStashSave: () => ({ mutateAsync: hooks.stashSave, isPending: false }),
  useStashPop: () => ({ mutateAsync: hooks.stashPop, isPending: false }),
  useStashApply: () => ({ mutateAsync: hooks.stashApply, isPending: false }),
  useStashDrop: () => ({ mutateAsync: hooks.stashDrop, isPending: false }),
  useGitBranches: () => ({ data: hooks.branches, isLoading: false, error: null }),
  useSwitchBranch: () => ({ mutateAsync: hooks.branchSwitch, isPending: false }),
  useCreateBranch: () => ({ mutateAsync: hooks.branchCreate, isPending: false }),
  useRenameBranch: () => ({ mutateAsync: hooks.branchRename, isPending: false }),
  useDeleteBranch: () => ({ mutateAsync: hooks.branchDelete, isPending: false }),
  useCheckoutRemoteBranch: () => ({ mutateAsync: hooks.checkoutRemote, isPending: false }),
  useGitFetch: () => ({ mutateAsync: hooks.gitFetch, isPending: false }),
  useGitPull: () => ({ mutateAsync: hooks.gitPull, isPending: false }),
  useGitPush: () => ({ mutateAsync: hooks.gitPush, isPending: false }),
  useGitHeadMessage: (_chatId: string, enabled: boolean) => ({
    data: enabled ? hooks.headMessage : undefined,
    error: enabled ? hooks.headMessageError : null,
    isLoading: false,
  }),
  useGitHistory: () => ({
    data: { pages: hooks.historyPages },
    isLoading: hooks.historyLoading,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(),
  }),
  useGitCommit: () => ({ data: hooks.commitDetails, isLoading: false, error: null }),
  useGitDiff: () => ({ data: hooks.diff, isLoading: false, error: null }),
  useGitWorktrees: () => ({
    data: hooks.worktrees,
    error: hooks.worktreesError,
    isLoading: false,
    isFetching: false,
    refetch: hooks.worktreesRefetch,
  }),
  useAddWorktree: () => ({ mutateAsync: hooks.worktreeAdd, isPending: false }),
  useRemoveWorktree: () => ({ mutateAsync: hooks.worktreeRemove, isPending: false }),
}));

/** Puts every field of `gitPanelHooks` back to its initial value; call from `beforeEach`. */
export function resetGitPanelHooks(): void {
  hooks.data = undefined;
  hooks.error = null;
  hooks.loading = false;
  hooks.fetching = false;
  hooks.initPending = false;
  hooks.initError = null;
  hooks.refetch.mockReset();
  hooks.mutate.mockReset();
  hooks.stage.mockReset();
  hooks.unstage.mockReset();
  hooks.discard.mockReset();
  hooks.commit.mockReset();
  hooks.generate.mockReset();
  hooks.stashSave.mockReset();
  hooks.stashPop.mockReset();
  hooks.stashApply.mockReset();
  hooks.stashDrop.mockReset();
  hooks.stashes = [];
  hooks.branches = { branches: [], remotes: [] };
  hooks.branchSwitch.mockReset();
  hooks.branchCreate.mockReset();
  hooks.branchRename.mockReset();
  hooks.branchDelete.mockReset();
  hooks.checkoutRemote.mockReset();
  hooks.gitFetch.mockReset();
  hooks.gitPull.mockReset();
  hooks.gitPush.mockReset();
  hooks.headMessage = undefined;
  hooks.headMessageError = null;
  hooks.historyPages = [];
  hooks.historyLoading = false;
  hooks.commitDetails = undefined;
  hooks.diff = undefined;
  hooks.githubData = { state: 'no-remote' };
  hooks.githubError = null;
  hooks.githubLoading = false;
  hooks.githubFetching = false;
  hooks.githubRefetch.mockReset();
  hooks.worktrees = { worktrees: [] };
  hooks.worktreesError = null;
  hooks.worktreesRefetch.mockReset();
  hooks.worktreeAdd.mockReset();
  hooks.worktreeRemove.mockReset();
  sessionStorage.clear();
  localStorage.clear();
}
