import type {
  CommitResponse,
  GenerateCommitMessageResponse,
  GitBranchesResponse,
  GitCommitDetailsResponse,
  GitDiffResponse,
  GitHistoryResponse,
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

const gitStateKeys = {
  all: ['git-state'] as const,
  detail: (chatId: string) => [...gitStateKeys.all, chatId] as const,
};

const gitStashKeys = {
  all: ['git-stashes'] as const,
  detail: (chatId: string) => [...gitStashKeys.all, chatId] as const,
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

type GitPathSelection = { paths: string[] } | { all: true };
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

function invalidateGitStashes(queryClient: QueryClient, chatId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: gitStashKeys.detail(chatId) });
}

async function invalidateGitWrites(queryClient: QueryClient, chatId: string): Promise<void> {
  await Promise.all([
    invalidateGitState(queryClient, chatId),
    invalidateGitStashes(queryClient, chatId),
    queryClient.invalidateQueries({ queryKey: gitBranchKeys.detail(chatId) }),
    queryClient.invalidateQueries({ queryKey: gitHistoryKeys.detail(chatId) }),
    queryClient.invalidateQueries({ queryKey: [...gitCommitKeys.all, chatId] }),
    queryClient.invalidateQueries({ queryKey: [...gitDiffKeys.all, chatId] }),
    queryClient.invalidateQueries({ queryKey: ['github-context', chatId] }),
  ]);
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
    onSuccess: () => invalidateGitWrites(queryClient, chatId),
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
    onSuccess: () => invalidateGitWrites(queryClient, chatId),
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
    onSuccess: () => invalidateGitWrites(queryClient, chatId),
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
    onSuccess: () => invalidateGitWrites(queryClient, chatId),
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
    onSuccess: () => invalidateGitWrites(queryClient, chatId),
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
    onSuccess: () => invalidateGitWrites(queryClient, chatId),
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
    onSuccess: () => invalidateGitWrites(queryClient, chatId),
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
    onSuccess: () => invalidateGitWrites(queryClient, chatId),
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

function useRemoteMutation(chatId: string, operation: 'fetch' | 'pull' | 'push') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { prune?: boolean } = {}): Promise<GitRepoState> => {
      const endpoint = client.api.git[operation];
      const body = operation === 'fetch' ? { chatId, prune: input.prune } : { chatId };
      const { data, error } = await endpoint.post(body);
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitWrites(queryClient, chatId),
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
