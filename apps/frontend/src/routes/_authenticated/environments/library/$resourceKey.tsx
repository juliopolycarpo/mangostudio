import { createFileRoute } from '@tanstack/react-router';
import { validateEnvironmentSearch } from '@/features/environments/use-environment-scope';
import { ResourceDetail } from '@/features/library/components/ResourceDetail';
import { libraryResourceQueryOptions } from '@/features/library/queries';

export const Route = createFileRoute('/_authenticated/environments/library/$resourceKey')({
  validateSearch: validateEnvironmentSearch,
  loaderDeps: ({ search }) => ({ environmentId: search.environmentId }),
  loader: ({ context: { queryClient }, params, deps }) =>
    queryClient.prefetchQuery(libraryResourceQueryOptions(params.resourceKey, deps.environmentId)),
  component: ResourceDetailRoute,
});

function ResourceDetailRoute() {
  const { resourceKey } = Route.useParams();
  return <ResourceDetail resourceKey={resourceKey} />;
}
