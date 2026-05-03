import { createFileRoute } from '@tanstack/react-router';
import { useApp } from '@/lib/app-context';
import { ToolSettingsPage } from '@/features/settings/tools';

export const Route = createFileRoute('/_authenticated/settings/tools')({
  component: ToolsSettingsRoute,
});

function ToolsSettingsRoute() {
  const app = useApp();

  return (
    <ToolSettingsPage
      maxToolIterations={app.settings.maxToolIterations}
      setMaxToolIterations={app.settings.setMaxToolIterations}
    />
  );
}
