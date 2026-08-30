import { createLazyFileRoute } from '@tanstack/react-router';
import { ConnectorsSettings } from '@/features/settings/connectors';
import { useApp } from '@/lib/app-context';

export const Route = createLazyFileRoute('/_authenticated/settings/connectors')({
  component: ConnectorsSettingsRoute,
});

function ConnectorsSettingsRoute() {
  const app = useApp();

  return <ConnectorsSettings modelCatalog={app.catalog} reloadModelCatalog={app.refreshCatalog} />;
}
