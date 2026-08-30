import { createFileRoute } from '@tanstack/react-router';
import { toolSettingsListQueryOptions } from '@/features/settings/tools/queries';

export const Route = createFileRoute('/_authenticated/settings/tools')({
  loader: ({ context: { queryClient } }) =>
    queryClient.prefetchQuery(toolSettingsListQueryOptions()),
});
