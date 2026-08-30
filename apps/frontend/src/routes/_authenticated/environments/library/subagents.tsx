import { createFileRoute } from '@tanstack/react-router';
import { validateEnvironmentSearch } from '@/features/environments/use-environment-scope';
import { libraryResourcesQueryOptions } from '@/features/library/queries';

export const Route = createFileRoute('/_authenticated/environments/library/subagents')({
  validateSearch: validateEnvironmentSearch,
  loaderDeps: ({ search }) => ({ environmentId: search.environmentId }),
  loader: ({ context: { queryClient }, deps }) =>
    queryClient.prefetchQuery(libraryResourcesQueryOptions('subagent', deps.environmentId)),
});
