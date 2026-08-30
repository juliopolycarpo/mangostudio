import { createLazyFileRoute } from '@tanstack/react-router';
import { ExternalApiSettingsPage } from '@/features/settings/external-api';
import { useApp } from '@/lib/app-context';

export const Route = createLazyFileRoute('/_authenticated/settings/external-api')({
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
