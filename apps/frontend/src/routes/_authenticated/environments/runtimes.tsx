import { createFileRoute } from '@tanstack/react-router';
import { RuntimesPage } from '@/features/environments/components/RuntimesPage';
import {
  installRecipesQueryOptions,
  runtimeStatusesQueryOptions,
  versionManagerStatusesQueryOptions,
} from '@/features/environments/queries';
import { validateEnvironmentSearch } from '@/features/environments/use-environment-scope';

export const Route = createFileRoute('/_authenticated/environments/runtimes')({
  validateSearch: validateEnvironmentSearch,
  loaderDeps: ({ search }) => ({ environmentId: search.environmentId }),
  // Prefetch rather than ensure: a cold probe is capped at a few seconds
  // server-side, and blocking the route on it would stall navigation.
  loader: ({ context: { queryClient }, deps }) => {
    void queryClient.prefetchQuery(runtimeStatusesQueryOptions(deps.environmentId));
    void queryClient.prefetchQuery(versionManagerStatusesQueryOptions(deps.environmentId));
    void queryClient.prefetchQuery(installRecipesQueryOptions());
  },
  component: RuntimesPage,
});
