import { createFileRoute } from '@tanstack/react-router';
import { useApp } from '@/lib/app-context';
import { ConnectorsSettings } from '@/components/settings/ConnectorsSettings';

export const Route = createFileRoute('/_authenticated/settings/connectors')({
  component: ConnectorsSettingsRoute,
});

function ConnectorsSettingsRoute() {
  const app = useApp();

  return <ConnectorsSettings modelCatalog={app.catalog} reloadModelCatalog={app.refreshCatalog} />;
}
