import { createFileRoute } from '@tanstack/react-router';
import { ResourceDetail } from '@/features/library/components/ResourceDetail';
import { libraryResourceQueryOptions } from '@/features/library/queries';

export const Route = createFileRoute('/_authenticated/environments/library/$resourceKey')({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.prefetchQuery(libraryResourceQueryOptions(params.resourceKey)),
  component: ResourceDetailRoute,
});

function ResourceDetailRoute() {
  const { resourceKey } = Route.useParams();
  return <ResourceDetail resourceKey={resourceKey} />;
}
