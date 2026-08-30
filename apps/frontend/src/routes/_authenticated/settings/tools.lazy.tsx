import { createLazyFileRoute } from '@tanstack/react-router';
import { ToolSettingsPage } from '@/features/settings/tools';
import { useApp } from '@/lib/app-context';

export const Route = createLazyFileRoute('/_authenticated/settings/tools')({
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
