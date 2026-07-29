import type {
  CommitResponse,
  DiscardPathsBody,
  GenerateCommitMessageResponse,
  GitBranchesResponse,
  GitCommitDetailsResponse,
  GitDiffResponse,
  GitHeadMessageResponse,
  GitHistoryResponse,
  GitPushBody,
  GitRepoState,
  GitStatus,
  InitRepoResponse,
  StashListResponse,
} from '@mangostudio/shared/git';
import {
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';
import { githubContextKeys } from './use-github-context';

const gitStateKeys = {
  all: ['git-state'] as const,
  detail: (chatId: string) => [...gitStateKeys.all, chatId] as const,
};

const gitStashKeys = {
  all: ['git-stashes'] as const,
  detail: (chatId: string) => [...gitStashKeys.all, chatId] as const,
};

const gitHeadMessageKeys = {
  all: ['git-head-message'] as const,
  detail: (chatId: string) => [...gitHeadMessageKeys.all, chatId] as const,
};

const gitBranchKeys = {
  all: ['git-branches'] as const,
  detail: (chatId: string) => [...gitBranchKeys.all, chatId] as const,
};

const gitHistoryKeys = {
  all: ['git-history'] as const,
  detail: (chatId: string) => [...gitHistoryKeys.all, chatId] as const,
};

const gitCommitKeys = {
  all: ['git-commit'] as const,
  detail: (chatId: string, hash: string) => [...gitCommitKeys.all, chatId, hash] as const,
};

const gitDiffKeys = {
  all: ['git-diff'] as const,
  detail: (chatId: string, input: GitDiffInput) =>
    [...gitDiffKeys.all, chatId, input.path, input.staged ?? false, input.commit ?? null] as const,
};

/** Query families a git write may invalidate. Each mutation declares its own set. */
export const GIT_SCOPES = [
  'state',
  'stashes',
  'branches',
  'history',
  'commits',
  'diffs',
  'github',
] as const;
export type GitScope = (typeof GIT_SCOPES)[number];

/**
 * Declarative invalidation map: each write states what it can change so a
 * single-file stage click does not refetch history or every cached commit.
 */
export const gitWriteScopes = {
  init: GIT_SCOPES,
  stage: ['state', 'diffs'],
  unstage: ['state', 'diffs'],
  discard: ['state', 'diffs'],
  commit: ['state', 'history', 'commits', 'branches', 'diffs', 'github'],
  stashSave: ['state', 'stashes', 'diffs'],
  stashPop: ['state', 'stashes', 'diffs'],
  stashApply: ['state', 'stashes', 'diffs'],
  // Dropping only removes a stack entry; the worktree and its diffs are untouched.
  stashDrop: ['stashes'],
  // createBranch runs `git switch -c` at the current HEAD — log is unchanged.
  createBranch: ['state', 'branches'],
  deleteBranch: ['branches'],
  renameBranch: ['state', 'branches', 'github'],
  switchBranch: ['state', 'branches', 'history', 'diffs', 'github'],
  checkoutRemote: ['state', 'branches', 'history', 'diffs', 'github'],
  fetch: ['state', 'branches', 'github'],
  pull: ['state', 'branches', 'history', 'commits', 'diffs', 'github'],
  push: ['state', 'branches', 'github'],
} as const satisfies Record<string, readonly GitScope[]>;

type GitPathSelection = { paths: string[] } | { all: true };
export type GitDiscardSelection = Pick<DiscardPathsBody, 'paths' | 'mode'>;
interface CommitInput {
  title: string;
  body?: string;
  amend?: boolean;
}
interface GenerateCommitMessageInput {
  model?: string;
}
interface StashSaveInput {
  message?: string;
  includeUntracked?: boolean;
}
interface StashPopInput {
  index?: number;
}
interface RenameBranchInput {
  name: string;
  newName: string;
}
interface DeleteBranchInput {
  name: string;
  force?: boolean;
}
export interface GitDiffInput {
  path: string;
  staged?: boolean;
  commit?: string;
}

function gitStateQueryOptions(chatId: string) {
  return queryOptions({
    queryKey: gitStateKeys.detail(chatId),
    queryFn: async () => {
      const { data, error } = await client.api.git.state.get({ query: { chatId } });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    refetchOnWindowFocus: true,
  });
}

export function invalidateGitState(queryClient: QueryClient, chatId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: gitStateKeys.detail(chatId) });
}

async function invalidateGitScopes(
  queryClient: QueryClient,
  chatId: string,
  scopes: readonly GitScope[]
): Promise<void> {
  const keys: Record<GitScope, readonly unknown[]> = {
    state: gitStateKeys.detail(chatId),
    stashes: gitStashKeys.detail(chatId),
    branches: gitBranchKeys.detail(chatId),
    history: gitHistoryKeys.detail(chatId),
    commits: [...gitCommitKeys.all, chatId],
    diffs: [...gitDiffKeys.all, chatId],
    github: [...githubContextKeys.all, chatId],
  };
  await Promise.all(
    scopes.map((scope) => queryClient.invalidateQueries({ queryKey: keys[scope] }))
  );
}

export function useGitState(chatId: string) {
  return useQuery(gitStateQueryOptions(chatId));
}

export function useInitRepo(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<InitRepoResponse> => {
      const { data, error } = await client.api.git.init.post({ chatId });
      if (error) throw new ApiError(error.value);
      return data as InitRepoResponse;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.init),
  });
}

export function useStagePaths(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (selection: GitPathSelection): Promise<GitStatus> => {
      const { data, error } = await client.api.git.stage.post({ chatId, ...selection });
      if (error) throw new ApiError(error.value);
      return data as GitStatus;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.stage),
  });
}

export function useUnstagePaths(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (selection: GitPathSelection): Promise<GitStatus> => {
      const { data, error } = await client.api.git.unstage.post({ chatId, ...selection });
      if (error) throw new ApiError(error.value);
      return data as GitStatus;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.unstage),
  });
}

export function useDiscardPaths(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: GitDiscardSelection): Promise<GitStatus> => {
      const { data, error } = await client.api.git.discard.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitStatus;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.discard),
  });
}

export function useCommit(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CommitInput): Promise<CommitResponse> => {
      const { data, error } = await client.api.git.commit.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as CommitResponse;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.commit),
  });
}

export function useGenerateCommitMessage(chatId: string) {
  return useMutation({
    mutationFn: async (
      input: GenerateCommitMessageInput = {}
    ): Promise<GenerateCommitMessageResponse> => {
      const { data, error } = await client.api.git['commit-message'].post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GenerateCommitMessageResponse;
    },
  });
}

export function useGitStashes(chatId: string) {
  return useQuery({
    queryKey: gitStashKeys.detail(chatId),
    queryFn: async (): Promise<StashListResponse> => {
      const { data, error } = await client.api.git.stashes.get({ query: { chatId } });
      if (error) throw new ApiError(error.value);
      return data as StashListResponse;
    },
  });
}

export function useStashSave(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StashSaveInput): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.stash.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.stashSave),
  });
}

export function useStashPop(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StashPopInput): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.stash.pop.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.stashPop),
  });
}

export function useStashApply(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StashPopInput): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.stash.apply.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.stashApply),
  });
}

export function useStashDrop(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StashPopInput): Promise<StashListResponse> => {
      const { data, error } = await client.api.git.stash.drop.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as StashListResponse;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.stashDrop),
  });
}

export function useGitBranches(chatId: string) {
  return useQuery({
    queryKey: gitBranchKeys.detail(chatId),
    queryFn: async (): Promise<GitBranchesResponse> => {
      const { data, error } = await client.api.git.branches.get({ query: { chatId } });
      if (error) throw new ApiError(error.value);
      return data as GitBranchesResponse;
    },
  });
}

export function useSwitchBranch(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.branches.switch.post({ chatId, name });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.switchBranch),
  });
}

export function useCreateBranch(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.branches.post({ chatId, name });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.createBranch),
  });
}

export function useDeleteBranch(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteBranchInput): Promise<GitBranchesResponse> => {
      const { data, error } = await client.api.git.branches.delete({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitBranchesResponse;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.deleteBranch),
  });
}

export function useRenameBranch(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RenameBranchInput): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.branches.rename.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.renameBranch),
  });
}

export function useCheckoutRemoteBranch(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (remoteRef: string): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.branches['checkout-remote'].post({
        chatId,
        remoteRef,
      });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.checkoutRemote),
  });
}

export function useGitHistory(chatId: string) {
  return useInfiniteQuery({
    queryKey: gitHistoryKeys.detail(chatId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<GitHistoryResponse> => {
      const query = pageParam ? { chatId, cursor: pageParam } : { chatId };
      const { data, error } = await client.api.git.history.get({ query });
      if (error) throw new ApiError(error.value);
      return data as GitHistoryResponse;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

export function useGitCommit(chatId: string, hash: string | null) {
  return useQuery({
    queryKey: gitCommitKeys.detail(chatId, hash ?? ''),
    enabled: hash !== null,
    queryFn: async (): Promise<GitCommitDetailsResponse> => {
      if (!hash) throw new Error('A commit hash is required.');
      const { data, error } = await client.api.git.commit.get({ query: { chatId, hash } });
      if (error) throw new ApiError(error.value);
      return data as GitCommitDetailsResponse;
    },
  });
}

export function useGitDiff(chatId: string, input: GitDiffInput | null) {
  return useQuery({
    queryKey: gitDiffKeys.detail(chatId, input ?? { path: '' }),
    enabled: input !== null,
    queryFn: async (): Promise<GitDiffResponse> => {
      if (!input) throw new Error('A diff selection is required.');
      const { data, error } = await client.api.git.diff.get({
        query: { chatId, ...input },
      });
      if (error) throw new ApiError(error.value);
      return data as GitDiffResponse;
    },
  });
}

interface RemoteMutationInput {
  prune?: boolean;
  force?: GitPushBody['force'];
}

function useRemoteMutation(chatId: string, operation: 'fetch' | 'pull' | 'push') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RemoteMutationInput = {}): Promise<GitRepoState> => {
      const endpoint = client.api.git[operation];
      const body =
        operation === 'fetch'
          ? { chatId, prune: input.prune }
          : operation === 'push'
            ? { chatId, ...(input.force ? { force: input.force } : {}) }
            : { chatId };
      const { data, error } = await endpoint.post(body);
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes[operation]),
  });
}

export function useGitFetch(chatId: string) {
  return useRemoteMutation(chatId, 'fetch');
}

export function useGitPull(chatId: string) {
  return useRemoteMutation(chatId, 'pull');
}

export function useGitPush(chatId: string) {
  return useRemoteMutation(chatId, 'push');
}

/**
 * The commit an amend would replace. Enabled only while amend mode is active so
 * the panel does not spawn a `git log` on every render of every chat.
 */
export function useGitHeadMessage(chatId: string, enabled: boolean) {
  return useQuery({
    queryKey: gitHeadMessageKeys.detail(chatId),
    enabled,
    queryFn: async (): Promise<GitHeadMessageResponse> => {
      const { data, error } = await client.api.git['head-message'].get({ query: { chatId } });
      if (error) throw new ApiError(error.value);
      return data as GitHeadMessageResponse;
    },
  });
}
