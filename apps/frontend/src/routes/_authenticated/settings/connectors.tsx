import { createFileRoute } from '@tanstack/react-router';
import { ConnectorsSettings } from '@/features/settings/connectors';
import { connectorQueryOptions } from '@/features/settings/connectors/hooks/use-connectors';
import { useApp } from '@/lib/app-context';

export const Route = createFileRoute('/_authenticated/settings/connectors')({
  loader: ({ context: { queryClient } }) => queryClient.prefetchQuery(connectorQueryOptions()),
  component: ConnectorsSettingsRoute,
});

function ConnectorsSettingsRoute() {
  const app = useApp();

  return <ConnectorsSettings modelCatalog={app.catalog} reloadModelCatalog={app.refreshCatalog} />;
}
