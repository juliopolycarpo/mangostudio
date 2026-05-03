import { createFileRoute } from '@tanstack/react-router';
import { useApp } from '@/lib/app-context';
import { GeneralSettings } from '@/components/settings/GeneralSettings';

export const Route = createFileRoute('/_authenticated/settings/general')({
  component: GeneralSettingsRoute,
});

function GeneralSettingsRoute() {
  const app = useApp();

  return (
    <GeneralSettings
      imageQuality={app.settings.globalImageQuality}
      setImageQuality={app.settings.setGlobalImageQuality}
    />
  );
}
