import { createFileRoute } from '@tanstack/react-router';
import { ExternalApiSettingsPage } from '@/features/settings/external-api';
import { apiKeysListQueryOptions } from '@/features/settings/external-api/queries';
import { useApp } from '@/lib/app-context';

export const Route = createFileRoute('/_authenticated/settings/external-api')({
  loader: ({ context: { queryClient } }) => queryClient.prefetchQuery(apiKeysListQueryOptions()),
  component: ExternalApiSettingsRoute,
});

function ExternalApiSettingsRoute() {
  const app = useApp();

  return (
    <ExternalApiSettingsPage
      settings={app.settings.externalApiSettings}
      setExternalApiEnabled={app.settings.setExternalApiEnabled}
    />
  );
}
