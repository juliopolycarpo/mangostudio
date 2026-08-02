import { createFileRoute } from '@tanstack/react-router';
import { validateEnvironmentSearch } from '@/features/environments/use-environment-scope';
import { MatrixPage } from '@/features/library/components/MatrixPage';
import { libraryResourcesQueryOptions } from '@/features/library/queries';

export const Route = createFileRoute('/_authenticated/environments/library/subagents')({
  validateSearch: validateEnvironmentSearch,
  loaderDeps: ({ search }) => ({ environmentId: search.environmentId }),
  loader: ({ context: { queryClient }, deps }) =>
    queryClient.prefetchQuery(libraryResourcesQueryOptions('subagent', deps.environmentId)),
  component: () => <MatrixPage kind="subagent" />,
});
