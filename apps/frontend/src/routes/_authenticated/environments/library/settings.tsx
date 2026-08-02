import { createFileRoute } from '@tanstack/react-router';
import { validateEnvironmentSearch } from '@/features/environments/use-environment-scope';
import { SettingsComparison } from '@/features/library/components/SettingsComparison';
import { settingsComparisonQueryOptions } from '@/features/library/queries';

export const Route = createFileRoute('/_authenticated/environments/library/settings')({
  validateSearch: validateEnvironmentSearch,
  loaderDeps: ({ search }) => ({ environmentId: search.environmentId }),
  loader: ({ context: { queryClient }, deps }) =>
    queryClient.prefetchQuery(settingsComparisonQueryOptions(deps.environmentId)),
  component: SettingsComparison,
});
