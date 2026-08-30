import { createFileRoute } from '@tanstack/react-router';
import { agentSettingsListQueryOptions } from '@/features/settings/agents/queries';
import { toolSettingsListQueryOptions } from '@/features/settings/tools/queries';

export const Route = createFileRoute('/_authenticated/settings/agents')({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.prefetchQuery(agentSettingsListQueryOptions()),
      queryClient.prefetchQuery(toolSettingsListQueryOptions()),
    ]),
});
