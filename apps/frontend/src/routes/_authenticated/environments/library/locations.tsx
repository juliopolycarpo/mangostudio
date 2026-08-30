import { createFileRoute } from '@tanstack/react-router';
import { validateEnvironmentSearch } from '@/features/environments/use-environment-scope';
import { libraryLocationsQueryOptions } from '@/features/library/queries';

export const Route = createFileRoute('/_authenticated/environments/library/locations')({
  validateSearch: validateEnvironmentSearch,
  loaderDeps: ({ search }) => ({ environmentId: search.environmentId }),
  loader: ({ context: { queryClient }, deps }) =>
    queryClient.prefetchQuery(libraryLocationsQueryOptions(deps.environmentId)),
});
