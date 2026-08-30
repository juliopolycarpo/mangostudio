import { createFileRoute } from '@tanstack/react-router';
import {
  agentCliStatusesQueryOptions,
  installRecipesQueryOptions,
} from '@/features/environments/queries';
import { validateEnvironmentSearch } from '@/features/environments/use-environment-scope';

export const Route = createFileRoute('/_authenticated/environments/agents')({
  validateSearch: validateEnvironmentSearch,
  loaderDeps: ({ search }) => ({ environmentId: search.environmentId }),
  loader: ({ context: { queryClient }, deps }) => {
    void queryClient.prefetchQuery(agentCliStatusesQueryOptions(deps.environmentId));
    void queryClient.prefetchQuery(installRecipesQueryOptions(deps.environmentId));
  },
});
