import { createFileRoute } from '@tanstack/react-router';
import { ProviderSettingsPage } from '@/features/settings/providers';
import { providerSettingsDetailQueryOptions } from '@/features/settings/providers/queries';

export const Route = createFileRoute('/_authenticated/settings/providers/$provider')({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(providerSettingsDetailQueryOptions(params.provider)),
  component: ProviderSettingsPage,
});
