import type { GitRepoState } from '@mangostudio/shared/git';
import type { GithubContext } from '@mangostudio/shared/github';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

const githubContextKeys = {
  all: ['github-context'] as const,
  detail: (chatId: string) => [...githubContextKeys.all, chatId] as const,
};

export function useGithubContext(chatId: string, gitState: GitRepoState | undefined) {
  const queryClient = useQueryClient();
  const branch = branchIdentity(gitState);
  const previousBranch = useRef(branch);

  const query = useQuery({
    queryKey: githubContextKeys.detail(chatId),
    queryFn: async (): Promise<GithubContext> => {
      const { data, error } = await client.api.github.context.get({ query: { chatId } });
      if (error) throw new ApiError(error.value);
      return data as GithubContext;
    },
    enabled: gitState?.state === 'repo',
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    const previous = previousBranch.current;
    previousBranch.current = branch;
    if (previous === undefined || branch === undefined || previous === branch) return;
    void queryClient.invalidateQueries({ queryKey: githubContextKeys.detail(chatId) });
  }, [branch, chatId, queryClient]);

  return query;
}

function branchIdentity(state: GitRepoState | undefined): string | undefined {
  if (state?.state !== 'repo') return undefined;
  return state.status.branch.name ?? `detached:${state.status.branch.detachedAt ?? 'HEAD'}`;
}
