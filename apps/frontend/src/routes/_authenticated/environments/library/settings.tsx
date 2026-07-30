import { createFileRoute } from '@tanstack/react-router';
import { SettingsComparison } from '@/features/library/components/SettingsComparison';
import { settingsComparisonQueryOptions } from '@/features/library/queries';

export const Route = createFileRoute('/_authenticated/environments/library/settings')({
  loader: ({ context: { queryClient } }) =>
    queryClient.prefetchQuery(settingsComparisonQueryOptions()),
  component: SettingsComparison,
});
