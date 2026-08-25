import { createFileRoute } from '@tanstack/react-router';
import {
  type EnvironmentScopeSearch,
  validateEnvironmentSearch,
} from '@/features/environments/use-environment-scope';
import { ResourceDetail } from '@/features/library/components/ResourceDetail';
import { libraryResourceQueryOptions } from '@/features/library/queries';

interface ResourceDetailSearch extends EnvironmentScopeSearch {
  /** Opens the version comparison on arrival. Absent means "closed". */
  readonly compare?: true;
}

/**
 * `compare` is a link's way of saying "show me what differs" — the hub's
 * divergence card sends it. Kept out of the URL when false rather than written
 * as `compare=false`, so an ordinary visit has the address it always had.
 */
function validateSearch(raw: Record<string, unknown>): ResourceDetailSearch {
  const scope = validateEnvironmentSearch(raw);
  return raw.compare === true || raw.compare === 'true' ? { ...scope, compare: true } : scope;
}

export const Route = createFileRoute('/_authenticated/environments/library/$resourceKey')({
  validateSearch,
  loaderDeps: ({ search }) => ({ environmentId: search.environmentId }),
  loader: ({ context: { queryClient }, params, deps }) =>
    queryClient.prefetchQuery(libraryResourceQueryOptions(params.resourceKey, deps.environmentId)),
  component: ResourceDetailRoute,
});

function ResourceDetailRoute() {
  const { resourceKey } = Route.useParams();
  const { compare } = Route.useSearch();
  return <ResourceDetail resourceKey={resourceKey} initialCompare={compare === true} />;
}
