import { createFileRoute } from '@tanstack/react-router';
import { HealthPage } from '@/features/environments/components/HealthPage';
import {
  agentCliStatusesQueryOptions,
  runtimeStatusesQueryOptions,
  versionManagerStatusesQueryOptions,
} from '@/features/environments/queries';

export const Route = createFileRoute('/_authenticated/environments/health')({
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(runtimeStatusesQueryOptions());
    void queryClient.prefetchQuery(versionManagerStatusesQueryOptions());
    void queryClient.prefetchQuery(agentCliStatusesQueryOptions());
  },
  component: HealthPage,
});
