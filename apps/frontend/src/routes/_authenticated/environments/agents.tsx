import { createFileRoute } from '@tanstack/react-router';
import { AgentsPage } from '@/features/environments/components/AgentsPage';
import {
  agentCliStatusesQueryOptions,
  installRecipesQueryOptions,
} from '@/features/environments/queries';

export const Route = createFileRoute('/_authenticated/environments/agents')({
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(agentCliStatusesQueryOptions());
    void queryClient.prefetchQuery(installRecipesQueryOptions());
  },
  component: AgentsPage,
});
