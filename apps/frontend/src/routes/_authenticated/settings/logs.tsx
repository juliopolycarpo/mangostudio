import { createFileRoute } from '@tanstack/react-router';
import { LogsSettingsPage } from '@/features/settings/observability';
import { observabilityLogsQueryOptions } from '@/features/settings/observability/queries';

export const Route = createFileRoute('/_authenticated/settings/logs')({
  loader: ({ context: { queryClient } }) =>
    queryClient.prefetchQuery(observabilityLogsQueryOptions()),
  component: LogsSettingsPage,
});
