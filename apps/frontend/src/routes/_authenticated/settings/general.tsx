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
      textSystemPrompt={app.settings.globalTextSystemPrompt}
      setTextSystemPrompt={app.settings.setGlobalTextSystemPrompt}
      imageSystemPrompt={app.settings.globalImageSystemPrompt}
      setImageSystemPrompt={app.settings.setGlobalImageSystemPrompt}
      imageQuality={app.settings.globalImageQuality}
      setImageQuality={app.settings.setGlobalImageQuality}
    />
  );
}
