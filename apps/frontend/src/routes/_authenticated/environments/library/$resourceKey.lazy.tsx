import { createLazyFileRoute } from '@tanstack/react-router';
import { ResourceDetail } from '@/features/library/components/ResourceDetail';

export const Route = createLazyFileRoute('/_authenticated/environments/library/$resourceKey')({
  component: ResourceDetailRoute,
});

function ResourceDetailRoute() {
  const { resourceKey } = Route.useParams();
  const { compare } = Route.useSearch();
  return <ResourceDetail resourceKey={resourceKey} initialCompare={compare === true} />;
}
