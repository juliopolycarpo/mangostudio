import { createFileRoute } from '@tanstack/react-router';
import { OverviewPage } from '@/features/environments/components/OverviewPage';
import {
  agentCliStatusesQueryOptions,
  installRecipesQueryOptions,
  runtimeStatusesQueryOptions,
} from '@/features/environments/queries';
import {
  libraryResourcesQueryOptions,
  libraryTargetsQueryOptions,
} from '@/features/library/queries';

export const Route = createFileRoute('/_authenticated/environments/')({
  // Prefetch rather than ensure: every section renders its own state, so the
  // page is useful the moment the first query lands and blocking navigation on
  // the slowest of five would only delay all of them.
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(agentCliStatusesQueryOptions());
    void queryClient.prefetchQuery(runtimeStatusesQueryOptions());
    void queryClient.prefetchQuery(installRecipesQueryOptions());
    void queryClient.prefetchQuery(libraryResourcesQueryOptions());
    void queryClient.prefetchQuery(libraryTargetsQueryOptions());
  },
  component: OverviewPage,
});
