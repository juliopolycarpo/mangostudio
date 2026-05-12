import { createFileRoute } from '@tanstack/react-router';
import { MetricsSettingsPage } from '@/features/settings/observability';
import { observabilityMetricsQueryOptions } from '@/features/settings/observability/queries';

export const Route = createFileRoute('/_authenticated/settings/metrics')({
  loader: ({ context: { queryClient } }) =>
    queryClient.prefetchQuery(observabilityMetricsQueryOptions()),
  component: MetricsSettingsPage,
});
