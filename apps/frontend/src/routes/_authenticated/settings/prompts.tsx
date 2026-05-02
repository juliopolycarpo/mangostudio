import { createFileRoute } from '@tanstack/react-router';
import { PromptSettings } from '@/components/settings/PromptSettings';
import { useApp } from '@/lib/app-context';

export const Route = createFileRoute('/_authenticated/settings/prompts')({
  component: PromptSettingsRoute,
});

function PromptSettingsRoute() {
  const app = useApp();

  return (
    <PromptSettings
      promptSettings={app.settings.promptSettings}
      onTextSystemPromptChange={app.settings.setTextSystemPrompt}
      onImageSystemPromptChange={app.settings.setImageSystemPrompt}
      onUpdateRuleFile={app.settings.updateRuleFileSetting}
      onAddCustomRule={app.settings.addCustomRule}
      onRemoveCustomRule={app.settings.removeCustomRule}
    />
  );
}
