import type { GitRepoState } from '@mangostudio/shared/git';
import type { GithubContext } from '@mangostudio/shared/github';
import { useQuery } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

const githubContextKeys = {
  all: ['github-context'] as const,
  detail: (chatId: string, branch: string) => [...githubContextKeys.all, chatId, branch] as const,
};

export function useGithubContext(chatId: string, gitState: GitRepoState | undefined) {
  // The branch belongs in the key: checking out a different ref must refetch the
  // pull request context rather than serve the previous branch's answer.
  const branch = branchIdentity(gitState);

  return useQuery({
    queryKey: githubContextKeys.detail(chatId, branch ?? ''),
    queryFn: async (): Promise<GithubContext> => {
      const { data, error } = await client.api.github.context.get({ query: { chatId } });
      if (error) throw new ApiError(error.value);
      return data as GithubContext;
    },
    enabled: branch !== undefined,
    refetchOnWindowFocus: true,
  });
}

function branchIdentity(state: GitRepoState | undefined): string | undefined {
  if (state?.state !== 'repo') return undefined;
  return state.status.branch.name ?? `detached:${state.status.branch.detachedAt ?? 'HEAD'}`;
}
