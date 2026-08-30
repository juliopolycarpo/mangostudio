import { createFileRoute } from '@tanstack/react-router';
import { connectorQueryOptions } from '@/features/settings/connectors/hooks/use-connectors';

export const Route = createFileRoute('/_authenticated/settings/connectors')({
  loader: ({ context: { queryClient } }) => queryClient.prefetchQuery(connectorQueryOptions()),
});
