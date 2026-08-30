import { createFileRoute } from '@tanstack/react-router';
import {
  agentCliStatusesQueryOptions,
  runtimeStatusesQueryOptions,
  versionManagerStatusesQueryOptions,
} from '@/features/environments/queries';
import { validateEnvironmentSearch } from '@/features/environments/use-environment-scope';

export const Route = createFileRoute('/_authenticated/environments/health')({
  validateSearch: validateEnvironmentSearch,
  loaderDeps: ({ search }) => ({ environmentId: search.environmentId }),
  loader: ({ context: { queryClient }, deps }) => {
    void queryClient.prefetchQuery(runtimeStatusesQueryOptions(deps.environmentId));
    void queryClient.prefetchQuery(versionManagerStatusesQueryOptions(deps.environmentId));
    void queryClient.prefetchQuery(agentCliStatusesQueryOptions(deps.environmentId));
  },
});
