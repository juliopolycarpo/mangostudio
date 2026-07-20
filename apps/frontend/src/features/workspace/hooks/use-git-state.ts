import type { GitRepoState, InitRepoResponse } from '@mangostudio/shared/git';
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

export function useGitState(chatId: string, enabled = true) {
  return useQuery({ ...gitStateQueryOptions(chatId), enabled });
}

export function useInitRepo(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<InitRepoResponse> => {
      const { data, error } = await client.api.git.init.post({ chatId });
      if (error) throw new ApiError(error.value);
      return data as InitRepoResponse;
    },
    onSuccess: () => invalidateGitState(queryClient, chatId),
  });
}
