import { createLazyFileRoute } from '@tanstack/react-router';
import { ContextSettings } from '@/components/settings/ContextSettings';
import { useApp } from '@/lib/app-context';

export const Route = createLazyFileRoute('/_authenticated/settings/context')({
  component: ContextSettingsRoute,
});

function ContextSettingsRoute() {
  const app = useApp();

  return (
    <ContextSettings
      settings={app.settings.contextSettings}
      availableModels={app.catalog.textModels}
      setCompactionBehavior={app.settings.setContextCompactionBehavior}
      setWarningThreshold={app.settings.setContextWarningThreshold}
      setDangerThreshold={app.settings.setContextDangerThreshold}
      setHardStopThreshold={app.settings.setContextHardStopThreshold}
      setPreferredSummaryModel={app.settings.setPreferredSummaryModel}
      setProviderCompactionEnabled={app.settings.setProviderCompactionEnabled}
    />
  );
}
