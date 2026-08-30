import { createFileRoute } from '@tanstack/react-router';
import { providerSettingsListQueryOptions } from '@/features/settings/providers/queries';

export const Route = createFileRoute('/_authenticated/settings/providers')({
  loader: ({ context: { queryClient } }) =>
    queryClient.prefetchQuery(providerSettingsListQueryOptions()),
});
