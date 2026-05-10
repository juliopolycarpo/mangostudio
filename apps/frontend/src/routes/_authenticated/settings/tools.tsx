import { createFileRoute } from '@tanstack/react-router';
import { useApp } from '@/lib/app-context';
import { ToolSettingsPage } from '@/features/settings/tools';
import { toolSettingsListQueryOptions } from '@/features/settings/tools/queries';

export const Route = createFileRoute('/_authenticated/settings/tools')({
  loader: ({ context: { queryClient } }) =>
    queryClient.prefetchQuery(toolSettingsListQueryOptions()),
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
