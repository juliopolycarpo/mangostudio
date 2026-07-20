import type {
  CommitResponse,
  GitRepoState,
  GitStatus,
  InitRepoResponse,
  StashListResponse,
} from '@mangostudio/shared/git';
import {
  type QueryClient,
  queryOptions,
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

type GitPathSelection = { paths: string[] } | { all: true };
interface CommitInput {
  title: string;
  body?: string;
  amend?: boolean;
}
interface StashSaveInput {
  message?: string;
  includeUntracked?: boolean;
}
interface StashPopInput {
  index?: number;
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
