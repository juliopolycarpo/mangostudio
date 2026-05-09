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
      chatTitleSettings={app.settings.chatTitleSettings}
      availableTitleModels={app.catalog.textModels}
      setChatAutoRenameEnabled={app.settings.setChatAutoRenameEnabled}
      setChatTitleStrategy={app.settings.setChatTitleStrategy}
      setChatTitlePromptPrefixLength={app.settings.setChatTitlePromptPrefixLength}
      setPreferredChatTitleModel={app.settings.setPreferredChatTitleModel}
    />
  );
}
