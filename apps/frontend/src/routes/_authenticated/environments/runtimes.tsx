import { createFileRoute } from '@tanstack/react-router';
import { RuntimesPage } from '@/features/environments/components/RuntimesPage';
import {
  installRecipesQueryOptions,
  runtimeStatusesQueryOptions,
  versionManagerStatusesQueryOptions,
} from '@/features/environments/queries';

export const Route = createFileRoute('/_authenticated/environments/runtimes')({
  // Prefetch rather than ensure: a cold probe is capped at a few seconds
  // server-side, and blocking the route on it would stall navigation.
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(runtimeStatusesQueryOptions());
    void queryClient.prefetchQuery(versionManagerStatusesQueryOptions());
    void queryClient.prefetchQuery(installRecipesQueryOptions());
  },
  component: RuntimesPage,
});
