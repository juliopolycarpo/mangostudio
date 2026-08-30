import { createFileRoute } from '@tanstack/react-router';
import { apiKeysListQueryOptions } from '@/features/settings/external-api/queries';

export const Route = createFileRoute('/_authenticated/settings/external-api')({
  loader: ({ context: { queryClient } }) => queryClient.prefetchQuery(apiKeysListQueryOptions()),
});
