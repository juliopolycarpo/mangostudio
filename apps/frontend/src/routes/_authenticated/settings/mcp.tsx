import { createFileRoute } from '@tanstack/react-router';
import { mcpServerListQueryOptions } from '@/features/settings/mcp/queries';

export const Route = createFileRoute('/_authenticated/settings/mcp')({
  loader: ({ context: { queryClient } }) => queryClient.prefetchQuery(mcpServerListQueryOptions()),
});
